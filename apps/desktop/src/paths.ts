/** Filesystem ownership for the Electron-managed desktop installation. */

import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Stable desktop installation paths under the shared Harness home. */
export interface DesktopPaths {
  readonly profile: string
  readonly lock: string
}

/**
 * Resolve every Electron-owned path without changing the shared data roots.
 * @param dshHome - Harness home shared with npm-installed dsh.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(dshHome: string = resolveDshHome()): DesktopPaths {
  return {
    profile: join(dshHome, 'profiles', 'desktop'),
    lock: join(dshHome, 'profiles', 'desktop', 'lock'),
  }
}

/** Where the shell keeps the data snapshots it took, the installers it archived, and its update history. */
export interface DesktopRecoveryPaths {
  readonly root: string
  readonly guard: string
  readonly snapshots: string
  readonly installers: string
  /** `electron-updater`'s own cache, holding the installer of the release being installed. */
  readonly updaterCache?: string
}

/**
 * Resolve recovery storage.
 *
 * Snapshots carry sessions, which on a long-lived profile reach hundreds of megabytes; on Windows
 * that must not ride the roaming profile, so it lives under LOCALAPPDATA beside the installation.
 * The update history is a few dozen bytes and stays with the other shell settings in userData.
 * @param input - Electron paths, platform, and the updater cache directory name from `app-update.yml`.
 * @returns Absolute recovery paths; `updaterCache` is absent when its name is unknown.
 */
export function resolveDesktopRecoveryPaths(input: {
  readonly userData: string
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly localAppData?: string
  readonly updaterCacheDirName?: string
}): DesktopRecoveryPaths {
  const windows = input.platform === 'win32'
  const root = windows && input.localAppData !== undefined
    ? join(input.localAppData, 'dsh-desktop', 'recovery')
    : join(input.userData, 'recovery')
  const updaterCache = input.updaterCacheDirName === undefined ? undefined
    : windows
      ? (input.localAppData === undefined ? undefined : join(input.localAppData, input.updaterCacheDirName))
      : input.platform === 'darwin'
        ? join(input.home, 'Library', 'Caches', input.updaterCacheDirName)
        : join(input.home, '.cache', input.updaterCacheDirName)
  return {
    root,
    guard: join(input.userData, 'desktop', 'update-guard.json'),
    snapshots: join(root, 'snapshots'),
    installers: join(root, 'installers'),
    ...(updaterCache === undefined ? {} : { updaterCache }),
  }
}
