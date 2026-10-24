/** Import the factory without evaluating an ordinary release configuration. */
export { createElectronBuilderConfig } from '../electron-builder.config.mjs'

/**
 * Name template of the installer this product ships.
 * @param suffix - Signature state marker, e.g. `-unsigned`.
 */
export function createDesktopArtifactName(suffix?: string): string

/** Update feed every build of this product publishes to. */
export const DESKTOP_UPDATE_PUBLIC_URL: string
