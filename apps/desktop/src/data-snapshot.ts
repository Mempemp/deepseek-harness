/**
 * Pre-update snapshots of the user's Harness data.
 *
 * The shell copies a fixed, small set of paths out of the shared Harness home before it hands
 * the application to an installer, so a release whose migration or core misbehaves never takes
 * Every captured file is a real copy: session logs are appended in place, and hardlinking a live
 * file would make the "snapshot" grow with the session it is supposed to remember. Space is saved
 * between snapshots instead — a file whose size and mtime still match an older snapshot is linked
 * to that snapshot's copy, and older snapshots are immutable, so the link stays honest. In practice
 * the second and later snapshots cost only what changed since the previous one.
 *
 * Deliberately excluded: `node_modules` trees, projection caches, logs, runtimes and vendored
 * server payloads. They are regenerable, and backing them up would spend the whole budget on the
 * parts a rollback does not need. Third-party plugin data is included only for the directories
 * this product ships, because an arbitrary plugin's database can reach hundreds of megabytes.
 *
 * Restoring is additive: files present in the snapshot are written back over the home, and files
 * the user created since are left alone. Nothing is deleted, so a restore can never lose data that
 * the snapshot did not know about.
 */

import { copyFile, mkdir, readFile, readdir, rename, rm, stat, statfs, link, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** One path taken from the Harness home: a whole tree or a single file. */
export interface DataSnapshotSection {
  readonly path: string
  readonly kind: 'tree' | 'file'
}

/**
 * Data a rollback or a reinstall must not destroy. `profiles/*` is narrowed to the user patch
 * layer: the profile's `node_modules` is rebuilt from the shipped catalog on the next start.
 */
export const DATA_SNAPSHOT_SECTIONS: readonly DataSnapshotSection[] = [
  { path: 'sessions', kind: 'tree' },
  { path: 'storages/workspace.json', kind: 'file' },
  { path: '.credentials.yaml', kind: 'file' },
  { path: 'settings.yaml', kind: 'file' },
  { path: 'settings.yaml.imported', kind: 'file' },
  { path: 'mcp-servers.json', kind: 'file' },
  { path: 'plugins', kind: 'tree' },
  { path: 'dsh-notifier-ru', kind: 'tree' },
  { path: '1c-project-properties', kind: 'tree' },
  { path: 'rlm-tools-bsl', kind: 'tree' },
]

/** Directories the walk never descends into, wherever they appear. */
export const DATA_SNAPSHOT_EXCLUDED_DIRECTORIES: readonly string[] = ['node_modules', 'session_projcache', '.git']

/** Why a snapshot exists; the reason is part of its directory name and manifest. */
export type DataSnapshotReason = 'update' | 'restore' | 'manual'

/** One captured file. `linked` records that its bytes are shared with an older snapshot. */
export interface DataSnapshotEntry {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
  readonly linked: boolean
}

/** What a snapshot contains, so a restore or a UI listing needs no second walk. */
export interface DataSnapshotManifest {
  readonly version: 1
  readonly id: string
  readonly createdAt: string
  readonly appVersion: string
  readonly reason: DataSnapshotReason
  readonly home: string
  readonly totals: { readonly files: number; readonly bytes: number; readonly storedBytes: number }
  readonly entries: readonly DataSnapshotEntry[]
}

/** Result of {@link createDataSnapshot}; `directory` is present only when one was written. */
export interface DataSnapshotResult {
  readonly outcome: 'created' | 'empty' | 'low-space' | 'oversized' | 'failed'
  readonly directory?: string
  readonly manifest?: DataSnapshotManifest
  readonly message?: string
}

/** Default ceiling for the bytes one snapshot writes itself; unchanged files are linked, not written. */
export const DATA_SNAPSHOT_MAX_STORED_BYTES = 1_500 * 1024 * 1024

/** Free space the snapshot refuses to eat into. */
export const DATA_SNAPSHOT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024

/** Snapshots kept regardless of age. */
export const DATA_SNAPSHOTS_RETAINED = 3

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

/** Sortable, self-describing directory name: `<ISO time>-<reason>-v<app version>`. */
export function dataSnapshotId(time: Date, reason: DataSnapshotReason, appVersion: string): string {
  return `${time.toISOString().replaceAll(/[:.]/gu, '-')}-${reason}-v${appVersion}`
}

async function* walk(directory: string, root: string, skip: ReadonlySet<string>): AsyncGenerator<{ absolute: string; path: string }> {
  let names: string[]
  try { names = await readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const name of names.sort()) {
    if (skip.has(name)) continue
    const absolute = join(directory, name)
    const info = await stat(absolute).catch(() => undefined)
    if (info === undefined) continue
    if (info.isDirectory()) yield* walk(absolute, root, skip)
    else if (info.isFile()) yield { absolute, path: relative(root, absolute).split(sep).join('/') }
  }
}

/** The user patch layer of every profile; the rest of a profile is machine-local and rebuilt. */
async function patchLayers(home: string): Promise<Array<{ absolute: string; path: string }>> {
  const profiles = join(home, 'profiles')
  let names: string[]
  try { names = await readdir(profiles) } catch { return [] }
  const layers: Array<{ absolute: string; path: string }> = []
  for (const name of names) {
    const absolute = join(profiles, name, 'cordis.patch.yml')
    if (await exists(absolute)) layers.push({ absolute, path: relative(home, absolute).split(sep).join('/') })
  }
  return layers
}

/** One file an older snapshot already holds, with the identity it was captured under. */
interface ReusableFile {
  readonly size: number
  readonly mtimeMs: number
  readonly path: string
}

/**
 * Every file an older snapshot already holds, newest snapshot first.
 * @param root - Snapshot root.
 * @returns Relative path to its captured copy and that copy's identity.
 */
async function reusableFiles(root: string): Promise<Map<string, ReusableFile>> {
  const reusable = new Map<string, ReusableFile>()
  for (const manifest of await readDataSnapshots(root)) {
    const directory = join(root, manifest.id, 'files')
    for (const entry of manifest.entries) {
      if (reusable.has(entry.path)) continue
      reusable.set(entry.path, { size: entry.size, mtimeMs: entry.mtimeMs, path: join(directory, ...entry.path.split('/')) })
    }
  }
  return reusable
}

/**
 * Put one file into the snapshot: link to an identical older copy when possible, copy otherwise.
 * @param options - Live file, destination, identity, the reusable index, and whether linking is allowed.
 * @returns Whether the snapshot shares its bytes with an older snapshot.
 */
async function capture(options: {
  readonly source: string
  readonly destination: string
  readonly relative: string
  readonly size: number
  readonly mtimeMs: number
  readonly reusable: Map<string, ReusableFile>
  readonly dedupe: boolean
}): Promise<boolean> {
  await mkdir(dirname(options.destination), { recursive: true, mode: 0o700 })
  const previous = options.dedupe ? options.reusable.get(options.relative) : undefined
  if (previous !== undefined && previous.size === options.size && previous.mtimeMs === options.mtimeMs) {
    try {
      await link(previous.path, options.destination)
      return true
    } catch {
      // The older snapshot was pruned or sits on another volume; copy instead.
    }
  }
  await copyFile(options.source, options.destination)
  return false
}

/**
 * Capture the data sections into a new snapshot directory.
 * @param options - Harness home, snapshot root, application version, reason, and budget.
 * @returns The written snapshot, or why nothing usable was produced. Never throws for a full disk.
 */
export async function createDataSnapshot(options: {
  readonly home: string
  readonly root: string
  readonly appVersion: string
  readonly reason: DataSnapshotReason
  readonly now?: Date
  readonly maxStoredBytes?: number
  readonly minFreeBytes?: number
  /** False captures every file in full instead of linking to an older identical copy. */
  readonly dedupe?: boolean
}): Promise<DataSnapshotResult> {
  const now = options.now ?? new Date()
  const maxStoredBytes = options.maxStoredBytes ?? DATA_SNAPSHOT_MAX_STORED_BYTES
  const minFreeBytes = options.minFreeBytes ?? DATA_SNAPSHOT_MIN_FREE_BYTES
  const id = dataSnapshotId(now, options.reason, options.appVersion)
  const directory = join(options.root, id)
  const skip = new Set(DATA_SNAPSHOT_EXCLUDED_DIRECTORIES)
  let stored = 0
  const entries: DataSnapshotEntry[] = []
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const free = await statfs(options.root).then(filesystem => filesystem.bavail * filesystem.bsize).catch(() => undefined)
    if (free !== undefined && free < minFreeBytes) {
      await rm(directory, { recursive: true, force: true })
      return { outcome: 'low-space', message: `free space ${String(free)} is below ${String(minFreeBytes)}` }
    }
    const reusable = await reusableFiles(options.root)
    const sources: Array<{ absolute: string; path: string }> = [...await patchLayers(options.home)]
    for (const section of DATA_SNAPSHOT_SECTIONS) {
      const absolute = join(options.home, ...section.path.split('/'))
      if (section.kind === 'file') {
        if (await exists(absolute)) sources.push({ absolute, path: section.path })
      } else {
        const info = await stat(absolute).catch(() => undefined)
        if (info?.isDirectory() === true) {
          for await (const file of walk(absolute, options.home, skip)) sources.push(file)
        }
      }
    }
    for (const source of sources) {
      const info = await stat(source.absolute)
      const size = info.size
      const mtimeMs = Math.round(info.mtimeMs)
      const linked = await capture({
        source: source.absolute,
        destination: join(directory, 'files', ...source.path.split('/')),
        relative: source.path,
        size,
        mtimeMs,
        reusable,
        dedupe: options.dedupe ?? true,
      })
      if (!linked) stored += size
      entries.push({ path: source.path, size, mtimeMs, linked })
      if (stored > maxStoredBytes) {
        await rm(directory, { recursive: true, force: true })
        return { outcome: 'oversized', message: `stored bytes exceeded ${String(maxStoredBytes)}` }
      }
    }
    if (entries.length === 0) {
      await rm(directory, { recursive: true, force: true })
      return { outcome: 'empty' }
    }
    const manifest: DataSnapshotManifest = {
      version: 1,
      id,
      createdAt: now.toISOString(),
      appVersion: options.appVersion,
      reason: options.reason,
      home: options.home,
      totals: { files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0), storedBytes: stored },
      entries,
    }
    await writeAtomic(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    return { outcome: 'created', directory, manifest }
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    return { outcome: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * List snapshots under a root, newest first.
 * @param root - Snapshot root; a missing directory is an empty list.
 * @returns Manifests that parse as {@link DataSnapshotManifest}; unreadable directories are skipped.
 */
export async function readDataSnapshots(root: string): Promise<DataSnapshotManifest[]> {
  let names: string[]
  try { names = await readdir(root) } catch { return [] }
  const manifests: DataSnapshotManifest[] = []
  for (const name of names.sort().reverse()) {
    const raw = await readFile(join(root, name, 'manifest.json'), 'utf8').catch(() => undefined)
    if (raw === undefined) continue
    try {
      const value: unknown = JSON.parse(raw)
      if (typeof value !== 'object' || value === null) continue
      const fields = value as Record<string, unknown>
      if (fields.version !== 1 || fields.id !== name || !Array.isArray(fields.entries)) continue
      manifests.push(value as DataSnapshotManifest)
    } catch {
      // A half-written or hand-edited manifest is not a usable snapshot; skip it, keep the rest.
    }
  }
  return manifests
}

/** Outcome of a restore: how much was put back and what could not be. */
export interface DataSnapshotRestoreResult {
  readonly files: number
  readonly bytes: number
  readonly failed: readonly string[]
}

/**
 * Write a snapshot back over the home without deleting anything.
 * @param directory - Snapshot directory produced by {@link createDataSnapshot}.
 * @param home - Harness home to restore into.
 * @returns Counts of restored files and the relative paths that failed.
 */
export async function restoreDataSnapshot(directory: string, home: string): Promise<DataSnapshotRestoreResult> {
  let files = 0
  let bytes = 0
  const failed: string[] = []
  const snapshot = join(directory, 'files')
  const sources: Array<{ absolute: string; path: string }> = []
  for await (const file of walk(snapshot, snapshot, new Set())) sources.push(file)
  for (const source of sources) {
    const destination = join(home, ...source.path.split('/'))
    try {
      const info = await stat(source.absolute)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      // A copy, never a link: the restored file must not keep sharing the snapshot's bytes.
      await copyFile(source.absolute, destination)
      files += 1
      bytes += info.size
    } catch {
      failed.push(source.path)
    }
  }
  return { files, bytes, failed }
}

/** Bytes a snapshot holds in its own directory. */
async function snapshotBytes(root: string, id: string): Promise<number> {
  let total = 0
  const directory = join(root, id, 'files')
  for await (const file of walk(directory, directory, new Set())) {
    total += (await stat(file.absolute).catch(() => ({ size: 0 }))).size
  }
  return total
}

/**
 * Delete snapshots beyond the retention floors: the newest `keep`, then the oldest beyond `maxBytes`.
 * @param root - Snapshot root.
 * @param options - Count and byte floors.
 * @returns Removed snapshot ids, oldest first.
 */
export async function pruneDataSnapshots(root: string, options: {
  readonly keep?: number
  readonly maxBytes?: number
} = {}): Promise<string[]> {
  const keep = options.keep ?? DATA_SNAPSHOTS_RETAINED
  const maxBytes = options.maxBytes ?? DATA_SNAPSHOT_MAX_STORED_BYTES
  const manifests = await readDataSnapshots(root)
  const sizes = new Map<string, number>()
  for (const manifest of manifests) sizes.set(manifest.id, await snapshotBytes(root, manifest.id))
  const removed: string[] = []
  let bytes = [...sizes.values()].reduce((sum, value) => sum + value, 0)
  // Manifests are newest first, so pruning walks up from the oldest while either floor is exceeded.
  for (let index = manifests.length - 1; index >= 0; index -= 1) {
    const manifest = manifests[index]
    if (manifest === undefined) continue
    if (index < keep && bytes <= maxBytes) break
    try {
      await rm(join(root, manifest.id), { recursive: true, force: true })
      bytes -= sizes.get(manifest.id) ?? 0
      removed.push(manifest.id)
    } catch {
      // A locked file keeps the snapshot; the next run tries again rather than failing the update.
    }
  }
  return removed
}

/** Write atomically so a crash mid-prune never leaves a manifest that lies about its files. */
export async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp-${String(process.pid)}`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(temporary, contents, { mode: 0o600 })
  await rename(temporary, path)
}
