import { join } from 'node:path'
import { expect, it } from 'vitest'
import { resolveDesktopRecoveryPaths } from '../src/paths.ts'

it('keeps snapshots off the roaming profile on Windows and beside the shell elsewhere', () => {
  const windows = resolveDesktopRecoveryPaths({
    userData: 'C:\\Users\\me\\AppData\\Roaming\\DSH Desktop',
    platform: 'win32',
    home: 'C:\\Users\\me',
    localAppData: 'C:\\Users\\me\\AppData\\Local',
    updaterCacheDirName: '@deepseek-aidsh-desktop-updater',
  })
  expect(windows.root).toBe(join('C:\\Users\\me\\AppData\\Local', 'dsh-desktop', 'recovery'))
  expect(windows.snapshots).toBe(join(windows.root, 'snapshots'))
  expect(windows.installers).toBe(join(windows.root, 'installers'))
  // The update history stays with the shell's own settings, next to settings.json.
  expect(windows.guard).toBe(join('C:\\Users\\me\\AppData\\Roaming\\DSH Desktop', 'desktop', 'update-guard.json'))
  // The updater cache the archiver reads is the one electron-updater itself uses.
  expect(windows.updaterCache).toBe(join('C:\\Users\\me\\AppData\\Local', '@deepseek-aidsh-desktop-updater'))

  const macos = resolveDesktopRecoveryPaths({
    userData: '/Users/me/Library/Application Support/DSH Desktop',
    platform: 'darwin',
    home: '/Users/me',
    updaterCacheDirName: 'dsh-updater',
  })
  expect(macos.root).toBe(join('/Users/me/Library/Application Support/DSH Desktop', 'recovery'))
  expect(macos.updaterCache).toBe(join('/Users/me', 'Library', 'Caches', 'dsh-updater'))
})

it('omits what it cannot resolve instead of guessing a path', () => {
  const windows = resolveDesktopRecoveryPaths({
    userData: 'C:\\Users\\me\\AppData\\Roaming\\DSH Desktop',
    platform: 'win32',
    home: 'C:\\Users\\me',
  })
  // No LOCALAPPDATA: snapshots fall back under userData rather than to a fabricated drive path.
  expect(windows.root).toBe(join('C:\\Users\\me\\AppData\\Roaming\\DSH Desktop', 'recovery'))
  // Without a known cache name the archiver must not search an invented directory.
  expect(windows.updaterCache).toBeUndefined()
})
