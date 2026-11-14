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
import { dump, load } from 'js-yaml'

/** Home-relative marker recording that the predecessor data has already been carried over. */
export const LEGACY_MIGRATION_MARKER = '.legacy-migrated'

/**
 * Marker schema written by this build.
 * 1 — content trees only; 2 — also reconciles credentials and the workspace registry;
 * 3 — also merges the MCP manager's server list; 4 — also merges the model and provider choices.
 */
export const LEGACY_MIGRATION_VERSION = 4

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

/** MCP manager store that holds the servers a user configured in its panel. */
export const LEGACY_MCP_MANAGER_STORE = '@wingsky-1/dsh-mcp-manager/mcp.json'

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
interface LegacyMarker { version?: number; modelSettings?: boolean }

/** The marker as written by whichever build migrated this home first. */
function readMarker(homeDir: string): LegacyMarker {
  const path = join(homeDir, LEGACY_MIGRATION_MARKER)
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(parsed)) return { version: 1 }
    const version = parsed.version
    const modelSettings = parsed.modelSettings
    return {
      version: typeof version === 'number' ? version : 1,
      ...typeof modelSettings === 'boolean' ? { modelSettings } : {},
    }
  } catch {
    return { version: 1 }
  }
}

/** Marker schema version recorded in the home, or undefined when there is no marker. */
function readMarkerVersion(homeDir: string): number | undefined {
  const path = join(homeDir, LEGACY_MIGRATION_MARKER)
  if (!existsSync(path)) return undefined
  return readMarker(homeDir).version
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

/**
 * Merge the predecessor MCP server list into the manager's store.
 *
 * The panel keeps its servers in the plugin's own store, which the content copy never touches. Servers
 * are matched by name and merged, never replaced: a home that already runs the catalog's entries keeps
 * them and gains the ones the user configured before.
 * @param legacyDir - Predecessor home.
 * @param homeDir - This build's home.
 * @param note - Decision sink.
 */
function reconcileMcpServers(legacyDir: string, homeDir: string, note: (message: string) => void): void {
  const source = join(legacyDir, LEGACY_MCP_MANAGER_STORE)
  if (!existsSync(source)) return
  const destination = join(homeDir, LEGACY_MCP_MANAGER_STORE)
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
    note(`[legacy] carried ${LEGACY_MCP_MANAGER_STORE}`)
    return
  }
  interface Server { name?: string; id?: string }
  interface Store { version?: number; servers?: Server[] }
  let legacyStore: Store
  let homeStore: Store
  try {
    legacyStore = JSON.parse(readFileSync(source, 'utf8')) as Store
    homeStore = JSON.parse(readFileSync(destination, 'utf8')) as Store
  } catch (error) {
    note(`[legacy] ${LEGACY_MCP_MANAGER_STORE} unreadable, kept as is: ${String(error)}`)
    return
  }
  const servers = Array.isArray(homeStore.servers) ? [...homeStore.servers] : []
  const known = new Set(servers.map(server => String(server.name ?? server.id ?? '')).filter(Boolean))
  let added = 0
  for (const server of Array.isArray(legacyStore.servers) ? legacyStore.servers : []) {
    const name = String(server.name ?? server.id ?? '')
    if (name === '' || known.has(name)) continue
    servers.push(server)
    known.add(name)
    added += 1
  }
  if (added === 0) return
  homeStore.servers = servers
  writeFileSync(destination, `${JSON.stringify(homeStore, undefined, 2)}\n`)
  note(`[legacy] merged ${added} MCP server(s) into ${LEGACY_MCP_MANAGER_STORE}`)
}

/** Plugin entries whose config carries the user's provider and model choices. */
const MODEL_CONFIG_ENTRY = /^(?:agent-default-model|llm-.+)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Union two config values, keeping everything the home already has. */
function mergeConfigValue(kept: unknown, carried: unknown): unknown {
  if (kept === undefined) return carried
  if (isRecord(kept) && isRecord(carried)) {
    const merged: Record<string, unknown> = { ...kept }
    for (const [key, value] of Object.entries(carried)) merged[key] = mergeConfigValue(merged[key], value)
    return merged
  }
  if (Array.isArray(kept) && Array.isArray(carried)) {
    const identity = (item: unknown): string => {
      if (isRecord(item)) {
        if (typeof item.id === 'string') return item.id
        if (typeof item.name === 'string') return item.name
      }
      return JSON.stringify(item)
    }
    const known = new Set(kept.map(identity))
    return [...kept, ...carried.filter(item => !known.has(identity(item)))]
  }
  return kept
}

/** Read a loader patch file as its entry list, or nothing when it does not parse. */
function readPatchEntries(path: string): unknown[] | undefined {
  try {
    const parsed: unknown = load(readFileSync(path, 'utf8'))
    if (parsed === null) return []
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function modelEntries(entries: unknown[]): Record<string, unknown>[] {
  return entries.filter((entry): entry is Record<string, unknown> =>
    isRecord(entry) && typeof entry.id === 'string' && MODEL_CONFIG_ENTRY.test(entry.id))
}

/** The predecessor profile that holds the model choices: the one patch carrying `llm-*` entries. */
function legacyProfilePatch(legacyDir: string): string | undefined {
  const root = join(legacyDir, 'profiles')
  if (!existsSync(root)) return undefined
  const candidates = readdirSync(root)
    .map(name => join(root, name, 'cordis.patch.yml'))
    .filter(path => existsSync(path))
  return candidates.find(path => modelEntries(readPatchEntries(path) ?? []).length > 0)
}

/** This build's profile patch; undefined while the host has not created the profile yet. */
function homeProfilePatch(homeDir: string): string | undefined {
  const root = join(homeDir, 'profiles')
  if (!existsSync(root)) return undefined
  if (existsSync(join(root, 'desktop'))) return join(root, 'desktop', 'cordis.patch.yml')
  const patches = readdirSync(root)
    .map(name => join(root, name, 'cordis.patch.yml'))
    .filter(path => existsSync(path))
  return patches.length === 1 ? patches[0] : undefined
}

/** Write the patch back, keeping the comment header the loader ships with. */
function writePatchEntries(path: string, entries: unknown[]): void {
  const header = existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter((_, index, all) => all.slice(0, index + 1).every(part => part.startsWith('#'))).join('\n')
    : ''
  const body = dump(entries, { lineWidth: -1, noRefs: true })
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, header.length > 0 ? `${header}\n${body}` : body)
}

/**
 * Carry the user's models and provider choices into this build's profile.
 *
 * The predecessor kept them in its profile patch (`agent-default-model`, `llm-*`), which the content
 * copy never sees. Entries are merged by id and their configs by key, arrays by model id: everything
 * the new profile already carries stays exactly as it is, and nothing is dropped.
 * @param legacyDir - Predecessor home.
 * @param homeDir - This build's home.
 * @param note - Decision sink.
 * @returns True when nothing is left to do, so the marker may record the step as finished.
 */
function reconcileModelSettings(legacyDir: string, homeDir: string, note: (message: string) => void): boolean {
  const source = legacyProfilePatch(legacyDir)
  if (source === undefined) return true
  const carried = modelEntries(readPatchEntries(source) ?? [])
  if (carried.length === 0) return true
  const destination = homeProfilePatch(homeDir)
  // A home the host has not started yet has no profile; the next launch retries this step.
  if (destination === undefined) return false
  const current = existsSync(destination) ? readPatchEntries(destination) : []
  if (current === undefined) {
    note(`[legacy] ${destination} unreadable, model settings left as is`)
    return true
  }
  const merged = [...current]
  let changed = 0
  for (const entry of carried) {
    const index = merged.findIndex(candidate => isRecord(candidate) && candidate.id === entry.id)
    if (index < 0) {
      merged.push(entry)
      changed += 1
      continue
    }
    const target = merged[index] as Record<string, unknown>
    const before = JSON.stringify(target.config ?? null)
    const config = mergeConfigValue(target.config, entry.config)
    if (JSON.stringify(config ?? null) === before) continue
    merged[index] = { ...target, config }
    changed += 1
  }
  if (changed === 0) return true
  if (existsSync(destination)) copyFileSync(destination, `${destination}.before-legacy-migration`)
  writePatchEntries(destination, merged)
  note(`[legacy] merged ${changed} model/provider section(s) into ${destination}`)
  return true
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
    const marker = readMarker(options.homeDir)
    const version = marker.version
    // The model step waits for the host to create the profile, so it may still be pending on a home
    // whose marker already names the current schema.
    const modelsPending = marker.version === LEGACY_MIGRATION_VERSION && marker.modelSettings !== true
    if (marker.version === LEGACY_MIGRATION_VERSION && !modelsPending) return { outcome: 'skipped' }
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
    reconcileMcpServers(options.legacyDir, options.homeDir, options.note)
    const modelSettings = reconcileModelSettings(options.legacyDir, options.homeDir, options.note)
    const next = {
      version: LEGACY_MIGRATION_VERSION,
      legacyDir: options.legacyDir,
      migratedAt: new Date().toISOString(),
      modelSettings,
    }
    mkdirSync(options.homeDir, { recursive: true })
    writeFileSync(join(options.homeDir, LEGACY_MIGRATION_MARKER), `${JSON.stringify(next, undefined, 2)}\n`)
    options.note(`[legacy] migrated ${carried} content trees into ${options.homeDir}`)
    return { outcome: 'applied' }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    options.note(`[legacy] migration failed, retrying on the next launch: ${detail}`)
    return { outcome: 'partial', detail }
  }
}
