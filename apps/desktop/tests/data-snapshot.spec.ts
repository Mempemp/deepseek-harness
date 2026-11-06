import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  createDataSnapshot,
  DATA_SNAPSHOT_MIN_FREE_BYTES,
  dataSnapshotId,
  pruneDataSnapshots,
  readDataSnapshots,
  restoreDataSnapshot,
  writeAtomic,
} from '../src/data-snapshot.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-snapshot-'))
  roots.push(root)
  return root
}

/** A home with the sections a real one has, plus the trees a snapshot must not descend into. */
async function home(): Promise<string> {
  const root = await scratch()
  await mkdir(join(root, 'sessions', '--C-Users-me-project--', 'abc'), { recursive: true })
  await writeFile(join(root, 'sessions', '--C-Users-me-project--', 'abc', 'session.v4.jsonl.zstd'), 'session bytes')
  await mkdir(join(root, 'storages', 'session_projcache'), { recursive: true })
  await writeFile(join(root, 'storages', 'workspace.json'), '{"tables":{}}')
  await writeFile(join(root, 'storages', 'session_projcache', 'cache.bin'), 'projection')
  await writeFile(join(root, '.credentials.yaml'), 'version: 1\n')
  await writeFile(join(root, 'mcp-servers.json'), '{"version":1,"servers":[]}')
  await mkdir(join(root, 'profiles', 'desktop', 'node_modules', 'left-pad'), { recursive: true })
  await writeFile(join(root, 'profiles', 'desktop', 'cordis.patch.yml'), '- id: ui-theme\n')
  await writeFile(join(root, 'profiles', 'desktop', 'node_modules', 'left-pad', 'index.js'), 'module')
  await mkdir(join(root, 'plugins', 'state'), { recursive: true })
  await writeFile(join(root, 'plugins', 'state', 'installed.json'), '[]')
  await mkdir(join(root, 'memos-plugin'), { recursive: true })
  await writeFile(join(root, 'memos-plugin', 'memory.db'), 'not a section')
  return root
}

it('captures the data sections, the profile patch, and nothing regenerable', async () => {
  const source = await home()
  const root = await scratch()
  const now = new Date('2026-10-22T18:00:00.000Z')
  const result = await createDataSnapshot({ home: source, root, appVersion: '0.2.1-rc.2-1', reason: 'update', now })
  expect(result.outcome).toBe('created')
  expect(result.manifest?.id).toBe('2026-10-22T18-00-00-000Z-update-v0.2.1-rc.2-1')
  const paths = (result.manifest?.entries ?? []).map(entry => entry.path).sort()
  expect(paths).toEqual([
    '.credentials.yaml',
    'mcp-servers.json',
    'plugins/state/installed.json',
    'profiles/desktop/cordis.patch.yml',
    'sessions/--C-Users-me-project--/abc/session.v4.jsonl.zstd',
    'storages/workspace.json',
  ])
  // Sessions are appended in place, so every captured file is a real copy.
  expect(result.manifest?.totals.storedBytes).toBe(result.manifest?.totals.bytes)
  expect(result.manifest?.entries.every(entry => !entry.linked)).toBe(true)
})

it('stores real copies, and links the next snapshot to files that did not change', async () => {
  const source = await home()
  const root = await scratch()
  const first = await createDataSnapshot({ home: source, root, appVersion: '1.0.0', reason: 'update' })
  expect(first.manifest?.totals.storedBytes).toBe(first.manifest?.totals.bytes)
  expect(first.manifest?.entries.every(entry => !entry.linked)).toBe(true)

  // An appended session log must be copied: the first snapshot may not grow with it.
  const log = join(source, 'sessions', '--C-Users-me-project--', 'abc', 'session.v4.jsonl.zstd')
  const appended = `${await readFile(log, 'utf8')} and more`
  await writeFile(log, appended)

  const second = await createDataSnapshot({
    home: source, root, appVersion: '1.1.0', reason: 'update', now: new Date('2026-10-22T19:00:00.000Z'),
  })
  expect(second.outcome).toBe('created')
  const sessionEntry = second.manifest?.entries.find(entry => entry.path.startsWith('sessions/'))
  expect(sessionEntry?.linked).toBe(false)
  // Everything unchanged since the first snapshot is linked to its copy, not written again.
  expect((second.manifest?.totals.storedBytes ?? 0)).toBeLessThan((second.manifest?.totals.bytes ?? 0))
  expect(second.manifest?.entries.some(entry => entry.linked)).toBe(true)
  expect(await readFile(log, 'utf8')).toBe(appended)
  expect(await readFile(join(first.directory as string, 'files', 'sessions', '--C-Users-me-project--', 'abc', 'session.v4.jsonl.zstd'), 'utf8'))
    .toBe('session bytes')
})

it('enforces the stored-byte ceiling and leaves no half-written snapshot behind', async () => {
  const source = await home()
  const root = await scratch()
  const oversized = await createDataSnapshot({
    home: source, root, appVersion: '1.0.1', reason: 'update', dedupe: false, maxStoredBytes: 4,
  })
  expect(oversized.outcome).toBe('oversized')
  expect(await readDataSnapshots(root)).toEqual([])
})

it('refuses to write when free space is below the floor', async () => {
  const source = await home()
  const root = await scratch()
  const result = await createDataSnapshot({
    home: source, root, appVersion: '1.0.0', reason: 'update', minFreeBytes: DATA_SNAPSHOT_MIN_FREE_BYTES * 1_000_000,
  })
  expect(result.outcome).toBe('low-space')
  expect(await readDataSnapshots(root)).toEqual([])
})

it('reports an empty home instead of writing an unusable snapshot', async () => {
  const source = await scratch()
  const root = await scratch()
  expect((await createDataSnapshot({ home: source, root, appVersion: '1.0.0', reason: 'update' })).outcome).toBe('empty')
  expect(await readDataSnapshots(root)).toEqual([])
})

it('restores files over the home, keeps newer files, and does not link restored bytes to the snapshot', async () => {
  const source = await home()
  const root = await scratch()
  const created = await createDataSnapshot({ home: source, root, appVersion: '1.0.0', reason: 'update' })
  const directory = created.directory as string
  await writeFile(join(source, 'sessions', '--C-Users-me-project--', 'abc', 'session.v4.jsonl.zstd'), 'overwritten by the bad release')
  await writeFile(join(source, 'settings.yaml'), 'created after the snapshot')

  const restored = await restoreDataSnapshot(directory, source)
  expect(restored.failed).toEqual([])
  expect(await readFile(join(source, 'sessions', '--C-Users-me-project--', 'abc', 'session.v4.jsonl.zstd'), 'utf8')).toBe('session bytes')
  // Additive: a file the snapshot never saw survives.
  expect(await readFile(join(source, 'settings.yaml'), 'utf8')).toBe('created after the snapshot')

  // Writing through the restored file must not change the snapshot's copy.
  await writeFile(join(source, '.credentials.yaml'), 'rotated after restore')
  expect(await readFile(join(directory, 'files', '.credentials.yaml'), 'utf8')).toBe('version: 1\n')
})

it('prunes by count and by bytes, keeping the newest', async () => {
  const source = await home()
  const root = await scratch()
  for (const minute of [0, 1, 2, 3]) {
    await createDataSnapshot({
      home: source, root, appVersion: '1.0.0', reason: 'update',
      now: new Date(`2026-10-22T18:0${String(minute)}:00.000Z`), dedupe: false,
    })
  }
  expect(await readDataSnapshots(root)).toHaveLength(4)
  const removed = await pruneDataSnapshots(root, { keep: 2 })
  expect(removed).toHaveLength(2)
  const names = (await readDataSnapshots(root)).map(manifest => manifest.id)
  expect(names).toEqual([
    '2026-10-22T18-03-00-000Z-update-v1.0.0',
    '2026-10-22T18-02-00-000Z-update-v1.0.0',
  ])

  // Room for one snapshot only: the byte floor drops the older of the two survivors.
  const one = (await readDataSnapshots(root))[0]?.totals.bytes ?? 0
  expect(await pruneDataSnapshots(root, { keep: 2, maxBytes: one })).toHaveLength(1)
  expect(await readDataSnapshots(root)).toHaveLength(1)
})

it('names snapshots by sortable time, reason, and version', () => {
  expect(dataSnapshotId(new Date('2026-10-22T18:00:00.500Z'), 'restore', '0.2.1-rc.2-1'))
    .toBe('2026-10-22T18-00-00-500Z-restore-v0.2.1-rc.2-1')
})

it('writes documents atomically and leaves no temporary file behind', async () => {
  const root = await scratch()
  const path = join(root, 'nested', 'state.json')
  await writeAtomic(path, '{"a":1}\n')
  expect(await readFile(path, 'utf8')).toBe('{"a":1}\n')
  const names = await import('node:fs/promises').then(fs => fs.readdir(join(root, 'nested')))
  expect(names).toEqual(['state.json'])
  expect(await stat(path).then(info => info.size)).toBe(8)
})
