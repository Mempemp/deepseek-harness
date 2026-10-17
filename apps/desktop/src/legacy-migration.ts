/**
 * One-time carry-over of the predecessor product's user data into this build's Harness home.
 *
 * The predecessor (DSH Desktop, core 0.1.7) kept its Harness home under
 * `%APPDATA%\dsh-desktop\harness`; this build uses `~/.dsh`. The sessions there are written in the
 * same format this build reads (`session.v4.jsonl.zstd` — version 4 is the current session
 * format), so carrying them over is a plain copy with no conversion. Settings and credentials are
 * deliberately not migrated: their schema differs from this build's, and copying them blind could
 * pin stale values into a fresh profile.
 */

import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Home-relative marker recording that the predecessor data has already been carried over. */
export const LEGACY_MIGRATION_MARKER = '.legacy-migrated'

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

/** True when the new home already recorded a completed migration. */
export function legacyMigrationMarked(homeDir: string): boolean {
  return existsSync(join(homeDir, LEGACY_MIGRATION_MARKER))
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
 * Never throws: a failed attempt leaves the marker unwritten, so the next launch retries it, and
 * startup continues with whatever the home already has. Nothing is deleted from the predecessor.
 * @param attempt - Predecessor home, this home, and a note sink.
 * @returns Which decision was taken, with the failure text when the attempt was incomplete.
 */
export async function migrateLegacyHome(attempt: LegacyMigrationOptions): Promise<LegacyMigrationResult> {
  const options = withMigrationLog(attempt)
  try {
    if (legacyMigrationMarked(options.homeDir)) return { outcome: 'skipped' }
    if (!existsSync(options.legacyDir)) return { outcome: 'absent' }
    let carried = 0
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
    const marker = { legacyDir: options.legacyDir, migratedAt: new Date().toISOString() }
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
