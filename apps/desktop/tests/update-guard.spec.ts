import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  beginBoot,
  clearSkip,
  EMPTY_UPDATE_GUARD,
  isSkipped,
  readUpdateGuard,
  reachReady,
  shouldOfferRollback,
  skipRelease,
  UPDATE_ROLLBACK_AFTER_FAILED_BOOTS,
  writeUpdateGuard,
} from '../src/update-guard.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function guardPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-guard-'))
  roots.push(root)
  return join(root, 'desktop', 'update-guard.json')
}

it('counts consecutive starts of one release and resets on a new one', () => {
  const first = beginBoot(EMPTY_UPDATE_GUARD, '0.2.1-rc.2-1')
  expect(first).toEqual({ version: 1, bootVersion: '0.2.1-rc.2-1', bootAttempts: 1 })
  expect(beginBoot(first, '0.2.1-rc.2-1').bootAttempts).toBe(2)
  expect(beginBoot(first, '0.2.1-rc.2-2')).toEqual({ version: 1, bootVersion: '0.2.1-rc.2-2', bootAttempts: 1 })
})

it('clears the counter and records the release once a window is usable', () => {
  const failing = beginBoot(beginBoot(EMPTY_UPDATE_GUARD, '0.2.1-rc.2-1'), '0.2.1-rc.2-1')
  expect(shouldOfferRollback(failing)).toBe(true)
  const ready = reachReady(failing, '0.2.1-rc.2-1')
  expect(ready.bootAttempts).toBe(0)
  expect(ready.lastGoodVersion).toBe('0.2.1-rc.2-1')
  expect(shouldOfferRollback(ready)).toBe(false)
})

it('offers a rollback only from the second failed start', () => {
  expect(shouldOfferRollback(EMPTY_UPDATE_GUARD)).toBe(false)
  expect(shouldOfferRollback({ version: 1, bootAttempts: UPDATE_ROLLBACK_AFTER_FAILED_BOOTS - 1 })).toBe(false)
  expect(shouldOfferRollback({ version: 1, bootAttempts: UPDATE_ROLLBACK_AFTER_FAILED_BOOTS })).toBe(true)
})

it('hides a rolled-back release from unattended checks until the user checks again', () => {
  const skipped = skipRelease(EMPTY_UPDATE_GUARD, '0.2.1-rc.2-1', '0.2.0-rc.2-2')
  expect(isSkipped(skipped, '0.2.1-rc.2-1')).toBe(true)
  expect(isSkipped(skipped, '0.2.1-rc.2-2')).toBe(false)
  expect(skipped.rollbackTo).toBe('0.2.0-rc.2-2')
  const cleared = clearSkip(skipped)
  expect(isSkipped(cleared, '0.2.1-rc.2-1')).toBe(false)
  expect(cleared.rollbackTo).toBe('0.2.0-rc.2-2')
})

it('round-trips through disk and treats a damaged document as no history', async () => {
  const path = await guardPath()
  expect(readUpdateGuard(path)).toEqual(EMPTY_UPDATE_GUARD)
  await writeUpdateGuard(path, { version: 1, bootVersion: '1.0.0', bootAttempts: 2, skippedVersion: '1.1.0' })
  expect(readUpdateGuard(path)).toEqual({ version: 1, bootVersion: '1.0.0', bootAttempts: 2, skippedVersion: '1.1.0' })
})

it('rejects a document whose counters are impossible', async () => {
  const path = await guardPath()
  await writeUpdateGuard(path, { version: 1, bootAttempts: 1 })
  const { writeFile } = await import('node:fs/promises')
  for (const contents of ['not json', '[]', '{"bootAttempts":-1}', '{"bootAttempts":1.5}']) {
    await writeFile(path, contents)
    expect(readUpdateGuard(path)).toEqual(EMPTY_UPDATE_GUARD)
  }
})
