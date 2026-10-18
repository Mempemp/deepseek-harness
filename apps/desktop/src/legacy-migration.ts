/**
 * One-time carry-over of the predecessor product's user data into this build's Harness home.
 *
 * The predecessor (DSH Desktop, core 0.1.7) kept its Harness home under
 * `%APPDATA%\dsh-desktop\harness`; this build uses `~/.dsh`. Sessions, storages and attachments are
 * written in the format this build reads, so carrying them over is a plain copy with no conversion.
 *
 * Content trees are copied without overwriting, so a file this home already has wins. Identity
 * files (credentials and the workspace registry) are reconciled instead: a home left behind by an
 * older install must not shadow the predecessor's newer state, because that shows the setup screen
 * to a configured user and drops every session into the ungrouped bucket.
 */

import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Home-relative marker recording that the predecessor data has already been carried over. */
export const LEGACY_MIGRATION_MARKER = '.legacy-migrated'

/**
 * Marker schema written by this build.
 * 1 — content trees only; 2 — also reconciles credentials and the workspace registry.
 */
export const LEGACY_MIGRATION_VERSION = 2

/** Top-level entries of the predecessor home that are user content and safe to copy as-is. */
export const LEGACY_CONTENT_DIRS = [
  'sessions',
  'storages',
  'attachments',
  '1c-project-properties',
  'pets',
  'task-board',
  'memos-plugin',
  'rlm-tools-bsl',
] as const

/** Predecessor store file the MCP manager reads as its legacy store. */
export const LEGACY_MCP_STORE = 'dsh-mcp.json'

/** Harness-home log recording what the migration did: a packaged window has no console to read. */
export const LEGACY_MIGRATION_LOG = 'logs/legacy-migration.log'

/** Credential store shared by both products; API keys live in its top-level `refs` map. */
export const CREDENTIALS_FILE = '.credentials.yaml'

/** Workspace registry the client groups sessions by. */
export const WORKSPACE_STORE = 'storages/workspace.json'

/** What one migration attempt decided, for the caller's diagnostics. */
export interface LegacyMigrationResult {
  readonly outcome: 'absent' | 'skipped' | 'applied' | 'partial'
  readonly detail?: string
}

/** Paths and log sink one migration attempt works with. */
export interface LegacyMigrationOptions {
  /** Directory of the predecessor Harness home (`%APPDATA%\dsh-desktop\harness`). */
  readonly legacyDir: string
  /** This build's Harness home (`~/.dsh`). */
  readonly homeDir: string
  /** Receives every decision and failure; the migration never throws into startup. */
  readonly note: (message: string) => void
}

/** True when the new home already recorded a migration of the current schema. */
export function legacyMigrationMarked(homeDir: string): boolean {
  return readMarkerVersion(homeDir) === LEGACY_MIGRATION_VERSION
}

/** Marker schema version recorded in the home, or undefined when there is no marker. */
function readMarkerVersion(homeDir: string): number | undefined {
  const path = join(homeDir, LEGACY_MIGRATION_MARKER)
  if (!existsSync(path)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return 1
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'number' ? version : 1
  } catch {
    return 1
  }
}

/** Copy one file or directory tree into the home, never overwriting anything already there. */
function mergeEntry(source: string, destination: string, note: (message: string) => void): void {
  const info = lstatSync(source)
  if (info.isSymbolicLink()) {
    note(`[legacy] skipping symlink: ${source}`)
    return
  }
  if (info.isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const name of readdirSync(source)) mergeEntry(join(source, name), join(destination, name), note)
    return
  }
  if (info.isFile()) {
    if (existsSync(destination)) return
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  }
}

/** Keys listed under the top-level `refs:` map of a credential store, without reading values. */
function credentialRefs(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => /^refs:\s*$/.test(line))
  if (start === -1) return []
  const keys: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^\s+([A-Za-z0-9_\-.]+):/.exec(line)
    if (match?.[1] !== undefined) keys.push(match[1])
    else if (!/^\s/.test(line)) break
  }
  return keys
}

/**
 * Adopt the predecessor credentials when the home's own store lacks keys the user entered there, so
 * an API key set up in the predecessor keeps the setup screen away.
 * @param legacyDir - Predecessor home.
 * @param homeDir - This build's home.
 * @param note - Decision sink.
 */
function reconcileCredentials(legacyDir: string, homeDir: string, note: (message: string) => void): void {
  const source = join(legacyDir, CREDENTIALS_FILE)
  if (!existsSync(source)) return
  const destination = join(homeDir, CREDENTIALS_FILE)
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
    note(`[legacy] carried ${CREDENTIALS_FILE}`)
    return
  }
  const legacyRefs = credentialRefs(readFileSync(source, 'utf8'))
  if (legacyRefs.length === 0) return
  const homeRefs = new Set(credentialRefs(readFileSync(destination, 'utf8')))
  const missing = legacyRefs.filter(name => !homeRefs.has(name))
  if (missing.length === 0) return
  // The predecessor store is a superset of this one: keep a copy and adopt it whole, so the account
  // grants it also holds stay consistent with the keys.
  copyFileSync(destination, `${destination}.before-legacy-migration`)
  copyFileSync(source, destination)
  note(`[legacy] adopted ${CREDENTIALS_FILE} with ${missing.join(', ')}`)
}

/** One workspace entry of the client's registry, as far as the migration needs to know it. */
interface WorkspaceEntry {
  path?: unknown
  title?: unknown
  sessionIds?: unknown
  [key: string]: unknown
}

/** View of the workspace registry this reconciliation understands. */
interface WorkspaceStore {
  global?: { workspaceIds?: unknown; archivedSessionIds?: unknown; pinnedSessionIds?: unknown; [key: string]: unknown }
  tables?: { workspaces?: Record<string, WorkspaceEntry>; [key: string]: unknown }
  [key: string]: unknown
}

/** Union two string arrays, keeping the first order and appending what only the second has. */
function unionStrings(primary: unknown, extra: unknown): string[] {
  const result = Array.isArray(primary) ? primary.filter((item): item is string => typeof item === 'string') : []
  const seen = new Set(result)
  if (Array.isArray(extra)) {
    for (const item of extra) {
      if (typeof item === 'string' && !seen.has(item)) {
        seen.add(item)
        result.push(item)
      }
    }
  }
  return result
}

/** Normalize a workspace path for comparison: the same folder, written differently. */
function workspaceKey(entry: WorkspaceEntry): string | undefined {
  return typeof entry.path === 'string'
    ? entry.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    : undefined
}

/**
 * Merge the predecessor workspace registry into the home's registry.
 *
 * The client groups sessions by workspace membership, so a registry that only knows the folders of
 * an older install leaves every other session in the ungrouped bucket. Membership is merged, never
 * replaced: folders are matched by path and their session lists are united.
 * @param legacyDir - Predecessor home.
 * @param homeDir - This build's home.
 * @param note - Decision sink.
 */
function reconcileWorkspaces(legacyDir: string, homeDir: string, note: (message: string) => void): void {
  const source = join(legacyDir, WORKSPACE_STORE)
  if (!existsSync(source)) return
  const destination = join(homeDir, WORKSPACE_STORE)
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
    note(`[legacy] carried ${WORKSPACE_STORE}`)
    return
  }
  let legacy: WorkspaceStore
  let home: WorkspaceStore
  try {
    legacy = JSON.parse(readFileSync(source, 'utf8')) as WorkspaceStore
    home = JSON.parse(readFileSync(destination, 'utf8')) as WorkspaceStore
  } catch (error) {
    note(`[legacy] ${WORKSPACE_STORE} unreadable, kept as is: ${String(error)}`)
    return
  }
  const legacyWorkspaces = legacy.tables?.workspaces ?? {}
  const homeWorkspaces = home.tables?.workspaces ?? {}
  const byPath = new Map<string, string>()
  for (const [id, entry] of Object.entries(homeWorkspaces)) {
    const key = workspaceKey(entry)
    if (key !== undefined) byPath.set(key, id)
  }
  let changed = 0
  for (const [id, entry] of Object.entries(legacyWorkspaces)) {
    const key = workspaceKey(entry)
    const existingId = key === undefined ? undefined : byPath.get(key)
    if (existingId !== undefined) {
      const existing = homeWorkspaces[existingId]
      if (existing === undefined) continue
      const before = Array.isArray(existing.sessionIds) ? existing.sessionIds.length : 0
      const merged = unionStrings(existing.sessionIds, entry.sessionIds)
      if (merged.length !== before) {
        existing.sessionIds = merged
        changed += 1
      }
      continue
    }
    if (homeWorkspaces[id] !== undefined) continue
    homeWorkspaces[id] = { ...entry, sessionIds: unionStrings([], entry.sessionIds) }
    if (key !== undefined) byPath.set(key, id)
    changed += 1
  }
  if (changed === 0) return
  home.tables = { ...home.tables, workspaces: homeWorkspaces }
  const global = home.global ?? {}
  home.global = {
    ...global,
    initialized: global.initialized ?? true,
    workspaceIds: unionStrings(global.workspaceIds, legacy.global?.workspaceIds),
    archivedSessionIds: unionStrings(global.archivedSessionIds, legacy.global?.archivedSessionIds),
    pinnedSessionIds: unionStrings(global.pinnedSessionIds, legacy.global?.pinnedSessionIds),
  }
  writeFileSync(destination, `${JSON.stringify(home, undefined, 2)}\n`)
  note(`[legacy] merged ${changed} workspace entries into ${WORKSPACE_STORE}`)
}

/** Send each note both to the caller and to the product log on disk. */
function withMigrationLog(attempt: LegacyMigrationOptions): LegacyMigrationOptions {
  const path = join(attempt.homeDir, LEGACY_MIGRATION_LOG)
  return {
    ...attempt,
    note: (message: string) => {
      attempt.note(message)
      try {
        mkdirSync(join(attempt.homeDir, 'logs'), { recursive: true })
        appendFileSync(path, `${new Date().toISOString()} ${message}\n`)
      } catch (error) {
        attempt.note(`[legacy] could not append ${path}: ${String(error)}`)
      }
    },
  }
}

/**
 * Carry the predecessor home's user content into this build's home, once.
 *
 * The content copy runs on a home without a marker; the identity reconciliation runs for any marker
 * older than the current schema, so a build that already migrated — and showed the setup screen to a
 * configured user — repairs itself on the next launch.
 * Never throws: a failed attempt leaves the marker unwritten, so the next launch retries it, and
 * startup continues with whatever the home already has. Nothing is deleted from the predecessor.
 * @param attempt - Predecessor home, this home, and a note sink.
 * @returns Which decision was taken, with the failure text when the attempt was incomplete.
 */
export async function migrateLegacyHome(attempt: LegacyMigrationOptions): Promise<LegacyMigrationResult> {
  const options = withMigrationLog(attempt)
  try {
    const version = readMarkerVersion(options.homeDir)
    if (version === LEGACY_MIGRATION_VERSION) return { outcome: 'skipped' }
    if (!existsSync(options.legacyDir)) return { outcome: 'absent' }
    let carried = 0
    if (version === undefined) {
      for (const name of LEGACY_CONTENT_DIRS) {
        const source = join(options.legacyDir, name)
        if (!existsSync(source)) continue
        mergeEntry(source, join(options.homeDir, name), options.note)
        carried += 1
        options.note(`[legacy] carried ${name}`)
      }
      // The predecessor MCP store is the manager's legacy path; copy it only when the new home has
      // neither that file nor the manager's own store, so the manager can still pick it up once.
      const mcpSource = join(options.legacyDir, LEGACY_MCP_STORE)
      if (existsSync(mcpSource) && !existsSync(join(options.homeDir, LEGACY_MCP_STORE))) {
        mergeEntry(mcpSource, join(options.homeDir, LEGACY_MCP_STORE), options.note)
        options.note(`[legacy] carried ${LEGACY_MCP_STORE}`)
      }
    } else {
      options.note(`[legacy] marker schema ${version}, reconciling identity files`)
    }
    reconcileCredentials(options.legacyDir, options.homeDir, options.note)
    reconcileWorkspaces(options.legacyDir, options.homeDir, options.note)
    const marker = {
      version: LEGACY_MIGRATION_VERSION,
      legacyDir: options.legacyDir,
      migratedAt: new Date().toISOString(),
    }
    mkdirSync(options.homeDir, { recursive: true })
    writeFileSync(join(options.homeDir, LEGACY_MIGRATION_MARKER), `${JSON.stringify(marker, undefined, 2)}\n`)
    options.note(`[legacy] migrated ${carried} content trees into ${options.homeDir}`)
    return { outcome: 'applied' }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    options.note(`[legacy] migration failed, retrying on the next launch: ${detail}`)
    return { outcome: 'partial', detail }
  }
}
