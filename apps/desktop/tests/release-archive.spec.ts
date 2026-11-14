import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  archiveInstaller,
  findPendingInstaller,
  listArchivedInstallers,
  pruneArchivedInstallers,
  selectRollbackInstaller,
} from '../src/release-archive.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-release-'))
  roots.push(root)
  return root
}

/** An updater cache shaped like the real one: a `pending` directory with the downloaded installer. */
async function cache(files: Record<string, string>): Promise<string> {
  const root = await scratch()
  await mkdir(join(root, 'pending'), { recursive: true })
  for (const [name, contents] of Object.entries(files)) await writeFile(join(root, 'pending', name), contents)
  return root
}

it('finds the pending installer for one exact version', async () => {
  const updater = await cache({
    'DSH-1C-Setup-0.2.1-rc.2-1-win-x64-unsigned.exe': 'current',
    'DSH-1C-Setup-0.2.0-rc.2-2-win-x64-unsigned.exe': 'older',
    'update-info.json': '{}',
  })
  await expect(findPendingInstaller(join(updater, 'pending'), '0.2.1-rc.2-1')).resolves
    .toBe(join(updater, 'pending', 'DSH-1C-Setup-0.2.1-rc.2-1-win-x64-unsigned.exe'))
  await expect(findPendingInstaller(join(updater, 'pending'), '9.9.9')).resolves.toBeUndefined()
})

it('archives the running release installer, then reports it as already present', async () => {
  const updater = await cache({ 'DSH-1C-Setup-0.2.1-rc.2-1-win-x64-unsigned.exe': 'installer bytes' })
  const archive = await scratch()
  const first = await archiveInstaller({ cacheDirectory: updater, archiveDirectory: join(archive, 'installers'), version: '0.2.1-rc.2-1' })
  expect(first.outcome).toBe('archived')
  expect(first.path).toBe(join(archive, 'installers', '0.2.1-rc.2-1.exe'))
  const second = await archiveInstaller({ cacheDirectory: updater, archiveDirectory: join(archive, 'installers'), version: '0.2.1-rc.2-1' })
  expect(second.outcome).toBe('present')
})

it('reports a missing installer instead of failing when the cache was cleared', async () => {
  const updater = await cache({})
  const archive = await scratch()
  const result = await archiveInstaller({ cacheDirectory: updater, archiveDirectory: archive, version: '0.2.1-rc.2-1' })
  expect(result.outcome).toBe('missing')
  expect(await readdir(archive)).toEqual([])
})

it('offers the newest archived release that is not the one running', async () => {
  const archive = await scratch()
  for (const version of ['0.1.9', '0.2.0', '0.2.1']) await writeFile(join(archive, `${version}.exe`), version)
  await writeFile(join(archive, 'notes.txt'), 'ignored')
  const installers = await listArchivedInstallers(archive)
  expect(installers.map(installer => installer.version)).toEqual(['0.2.1', '0.2.0', '0.1.9'])
  expect(selectRollbackInstaller(installers, '0.2.1')?.version).toBe('0.2.0')
  expect(selectRollbackInstaller(installers, '0.1.9')?.version).toBe('0.2.1')
  expect(selectRollbackInstaller([{ version: '0.2.1', path: '' }], '0.2.1')).toBeUndefined()
})

it('prunes to the newest installers only', async () => {
  const archive = await scratch()
  for (const version of ['0.1.8', '0.1.9', '0.2.0', '0.2.1']) await writeFile(join(archive, `${version}.exe`), version)
  expect(await pruneArchivedInstallers(archive, 2)).toEqual(['0.1.9', '0.1.8'])
  expect((await listArchivedInstallers(archive)).map(installer => installer.version)).toEqual(['0.2.1', '0.2.0'])
})
