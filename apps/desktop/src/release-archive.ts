/**
 * Archived installers: the way back to the release that was running before an update.
 *
 * `electron-updater` keeps exactly one installer — the one it is installing — and it deletes it
 * after a successful install. Before that happens the shell links the running release's own
 * installer into a small archive, so a rollback needs no network and no rebuild: the archived
 * installer is the same NSIS package that produced the current installation, and the per-user
 * install directory accepts it without elevation.
 *
 * Linking (not copying) keeps the archive at directory-entry cost on Windows, where the updater
 * cache and the archive share a volume. A cross-volume setup falls back to a copy.
 */

import { copyFile, link, mkdir, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gt, valid, validRange } from 'semver'

/** One usable rollback target. */
export interface ArchivedInstaller {
  readonly version: string
  readonly path: string
}

/** Settled outcome of archiving the running release's installer. */
export interface ArchiveInstallerResult {
  readonly outcome: 'archived' | 'present' | 'missing' | 'failed'
  readonly path?: string
  readonly message?: string
}

/** Installers kept in the archive; the newest is the rollback target of the next update. */
export const ARCHIVED_INSTALLERS_RETAINED = 2

const INSTALLER_NAME = /^(.+)-x64.*\.exe$/u

/**
 * Read `electron-updater`'s cache directory name from the packaged update configuration.
 * The updater derives that directory from the same field, so reading it here keeps the archive and
 * the updater looking at one place instead of a guessed `<app name>-updater`.
 * @param appUpdateYml - Absolute path of `resources/app-update.yml`.
 * @returns The configured name, or undefined when the file is absent or has no such field.
 */
export function readUpdaterCacheDirName(appUpdateYml: string): string | undefined {
  let contents: string
  try { contents = readFileSync(appUpdateYml, 'utf8') } catch { return undefined }
  const match = /^updaterCacheDirName:\s*(.+)$/mu.exec(contents)
  const name = match?.[1]?.trim().replace(/^['"]|['"]$/gu, '')
  return name === undefined || name === '' ? undefined : name
}

/**
 * Find the updater's pending installer for one version.
 * @param pending - `electron-updater`'s `pending` directory.
 * @param version - Version whose installer should already be downloaded.
 * @returns The absolute path, or undefined when this release's installer is no longer cached.
 */
export async function findPendingInstaller(pending: string, version: string): Promise<string | undefined> {
  let names: string[]
  try { names = await readdir(pending) } catch { return undefined }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.exe')) continue
    const match = INSTALLER_NAME.exec(name)
    // The artifact name carries the version but also a target suffix; match the version verbatim.
    if (match === null || !name.includes(version)) continue
    const absolute = join(pending, name)
    const info = await stat(absolute).catch(() => undefined)
    if (info?.isFile() === true && info.size > 0) return absolute
  }
  return undefined
}

/**
 * Keep the installer of the release that is running now, so the next update can be undone.
 * @param options - Updater cache directory, archive directory, and the running version.
 * @returns What happened. `missing` is expected whenever this release was installed by hand rather
 * than by the updater (then no installer for it was ever downloaded), so the archive only becomes
 * useful once updates go through the application itself.
 */
export async function archiveInstaller(options: {
  readonly cacheDirectory: string
  readonly archiveDirectory: string
  readonly version: string
}): Promise<ArchiveInstallerResult> {
  if (valid(options.version) === null) return { outcome: 'failed', message: `invalid version ${options.version}` }
  const target = join(options.archiveDirectory, `${options.version}.exe`)
  const pending = join(options.cacheDirectory, 'pending')
  try {
    await mkdir(options.archiveDirectory, { recursive: true, mode: 0o700 })
    if (await stat(target).then(() => true).catch(() => false)) return { outcome: 'present', path: target }
    const source = await findPendingInstaller(pending, options.version)
    if (source === undefined) return { outcome: 'missing' }
    try {
      await link(await realpath(source), target)
    } catch {
      await copyFile(source, target)
    }
    return { outcome: 'archived', path: target }
  } catch (error) {
    await unlink(target).catch(() => undefined)
    return { outcome: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Installers present in the archive.
 * @param directory - Archive directory; missing means no rollback target.
 * @returns Valid versions, highest first.
 */
export async function listArchivedInstallers(directory: string): Promise<ArchivedInstaller[]> {
  let names: string[]
  try { names = await readdir(directory) } catch { return [] }
  const installers: ArchivedInstaller[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.exe')) continue
    const version = name.slice(0, -'.exe'.length)
    if (valid(version) === null || validRange(version) === null) continue
    const path = join(directory, name)
    const info = await stat(path).catch(() => undefined)
    if (info?.isFile() !== true || info.size === 0) continue
    installers.push({ version, path })
  }
  return installers.sort((left, right) => gt(left.version, right.version) ? -1 : 1)
}

/**
 * The release a rollback should return to: the newest archived installer that is not the one
 * currently running (an archive of the running version cannot change anything).
 * @param installers - Archive contents, highest version first.
 * @param currentVersion - Version of the running application.
 * @returns The target installer, or undefined when only the running version is archived.
 */
export function selectRollbackInstaller(installers: readonly ArchivedInstaller[], currentVersion: string): ArchivedInstaller | undefined {
  return installers.find(installer => installer.version !== currentVersion)
}

/**
 * Drop the oldest archived installers beyond `keep`.
 * @param directory - Archive directory.
 * @param keep - Installers to keep, newest first.
 * @returns Removed versions.
 */
export async function pruneArchivedInstallers(directory: string, keep = ARCHIVED_INSTALLERS_RETAINED): Promise<string[]> {
  const installers = await listArchivedInstallers(directory)
  const removed: string[] = []
  for (const installer of installers.slice(Math.max(0, keep))) {
    try {
      await unlink(installer.path)
      removed.push(installer.version)
    } catch {
      // A locked installer stays; the next prune retries rather than failing a startup.
    }
  }
  return removed
}
