/**
 * Update bookkeeping that has to survive restarts: how many times the current release failed to
 * reach a usable window, and which release the user asked to skip after rolling back.
 *
 * A single JSON document under the shell's userData. Both facts are read at startup, so the file
 * is written atomically and validated strictly: a damaged document must not stop the application,
 * and it must not silently claim a healthy release either, so an unreadable file reads as "no
 * history" and is rewritten on the next successful start.
 */

import { readFileSync } from 'node:fs'
import { writeAtomic } from './data-snapshot.ts'

/** Persisted update history of the shell. */
export interface UpdateGuardState {
  readonly version: 1
  /** Release whose startup is being counted; changed only by a new install. */
  readonly bootVersion?: string
  /** Consecutive starts of `bootVersion` that did not reach a usable window. */
  readonly bootAttempts: number
  /** Release the user rolled back from; automatic update checks stop offering it. */
  readonly skippedVersion?: string
  /** Last release that reached a usable window. */
  readonly lastGoodVersion?: string
  /** Release the user asked to return to, kept until the installer takes over. */
  readonly rollbackTo?: string
}

/** Starts that may fail before the recovery dialog offers a rollback. */
export const UPDATE_ROLLBACK_AFTER_FAILED_BOOTS = 2

/** The empty history of a first run. */
export const EMPTY_UPDATE_GUARD: UpdateGuardState = { version: 1, bootAttempts: 0 }

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= 128 ? value : undefined
}

/**
 * Read the update history.
 * @param path - Document path under the shell's userData.
 * @returns The stored state, or {@link EMPTY_UPDATE_GUARD} when the file is absent or invalid.
 */
export function readUpdateGuard(path: string): UpdateGuardState {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return EMPTY_UPDATE_GUARD }
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return EMPTY_UPDATE_GUARD
    const fields = value as Record<string, unknown>
    const attempts = fields.bootAttempts
    if (attempts !== undefined && (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0)) {
      return EMPTY_UPDATE_GUARD
    }
    const bootVersion = text(fields.bootVersion)
    const skippedVersion = text(fields.skippedVersion)
    const lastGoodVersion = text(fields.lastGoodVersion)
    const rollbackTo = text(fields.rollbackTo)
    return {
      version: 1,
      ...(bootVersion === undefined ? {} : { bootVersion }),
      bootAttempts: attempts ?? 0,
      ...(skippedVersion === undefined ? {} : { skippedVersion }),
      ...(lastGoodVersion === undefined ? {} : { lastGoodVersion }),
      ...(rollbackTo === undefined ? {} : { rollbackTo }),
    }
  } catch {
    return EMPTY_UPDATE_GUARD
  }
}

/**
 * Persist the update history.
 * @param path - Document path under the shell's userData.
 * @param state - State to write.
 * @returns Completion; a failed write is reported to the caller, never swallowed silently here.
 */
export async function writeUpdateGuard(path: string, state: UpdateGuardState): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * Count this start against the running release.
 * @param state - Stored history.
 * @param version - Running application version.
 * @returns State whose `bootAttempts` covers the start in progress.
 */
export function beginBoot(state: UpdateGuardState, version: string): UpdateGuardState {
  return state.bootVersion === version
    ? { ...state, bootAttempts: state.bootAttempts + 1 }
    : { ...state, bootVersion: version, bootAttempts: 1 }
}

/**
 * Record that the release reached a usable window.
 * @param state - Stored history.
 * @param version - Running application version.
 * @returns State with a cleared boot counter and this release as the last good one.
 */
export function reachReady(state: UpdateGuardState, version: string): UpdateGuardState {
  return { ...state, bootVersion: version, bootAttempts: 0, lastGoodVersion: version }
}

/**
 * Stop offering one release to automatic checks.
 * @param state - Stored history.
 * @param version - The release being rolled back from.
 * @param rollbackTo - The release the user asked to return to.
 * @returns State that hides `version` from unattended checks.
 */
export function skipRelease(state: UpdateGuardState, version: string, rollbackTo?: string): UpdateGuardState {
  return { ...state, skippedVersion: version, ...(rollbackTo === undefined ? {} : { rollbackTo }) }
}

/** Forget the skip: an explicit check means the user wants to see everything the feed offers. */
export function clearSkip(state: UpdateGuardState): UpdateGuardState {
  const { skippedVersion: _skipped, ...rest } = state
  return rest
}

/**
 * Whether the startup sequence should offer a rollback.
 * @param state - Stored history.
 * @returns True once the running release has failed to start {@link UPDATE_ROLLBACK_AFTER_FAILED_BOOTS} times.
 */
export function shouldOfferRollback(state: UpdateGuardState): boolean {
  return state.bootAttempts >= UPDATE_ROLLBACK_AFTER_FAILED_BOOTS
}

/**
 * Whether an unattended update check must ignore a feed entry.
 * @param state - Stored history.
 * @param candidate - Version offered by the feed.
 * @returns True when the user rolled back from this exact release.
 */
export function isSkipped(state: UpdateGuardState, candidate: string): boolean {
  return state.skippedVersion === candidate
}
