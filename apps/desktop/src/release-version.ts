/**
 * The 1C bundle numbers its own builds as `<core version>-<sub-release>` (for example
 * `0.2.0-rc.2-1`), while the bundled runtime packages keep reporting the plain core
 * version. Compare the two under that rule instead of requiring an exact match.
 * @param coreVersion - Version declared by the bundled runtime packages.
 * @param productVersion - Version of the desktop build.
 * @returns True when the product version is the core version or its numbered sub-release.
 */
export function matchesReleaseVersion(coreVersion: string, productVersion: string): boolean {
  if (coreVersion === productVersion) return true
  if (!productVersion.startsWith(`${coreVersion}-`)) return false
  return /^\d+$/u.test(productVersion.slice(coreVersion.length + 1))
}
