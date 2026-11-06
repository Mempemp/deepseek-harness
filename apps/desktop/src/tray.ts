/** Windows system tray: the always-present way back to a hidden window and the explicit quit entry. */

import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import type { DesktopLocale } from './locale.ts'

/** Main-process actions the tray triggers; both run the same paths as the window and application menu. */
export interface DesktopTrayOptions {
  /** Multi-size ICO rendered by `scripts/render-tray-icon.ts`; Windows picks the bitmap for the display scale. */
  readonly iconPath: string
  readonly locale: () => DesktopLocale
  /** Show and focus the primary window. */
  readonly open: () => void
  /** Request quit through the same confirmation as every other quit entry. */
  readonly quit: () => void
  /**
   * Recovery entries appended above Quit: return to the previous release, restore data from a
   * snapshot. Empty when the shell has nothing to offer, so the menu keeps its original shape.
   */
  readonly extras?: () => readonly MenuItemConstructorOptions[]
}

/** Tray icon present for the whole run, not only while the window is hidden. */
export class DesktopTray {
  private tray: Tray | undefined

  /** @param options - Icon path, locale reader, and the open and quit actions. */
  constructor(private readonly options: DesktopTrayOptions) {
    const tray = new Tray(nativeImage.createFromPath(options.iconPath))
    this.tray = tray
    tray.on('click', () => { options.open() })
    this.relabel()
  }

  /** Rebuild the tooltip and context menu in the current locale. */
  relabel(): void {
    const tray = this.tray
    if (tray === undefined) return
    const { messages } = this.options.locale()
    tray.setToolTip(messages.aboutProduct)
    const extras = this.options.extras?.() ?? []
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: messages.openApplication, click: () => { this.options.open() } },
      ...(extras.length === 0 ? [] : [{ type: 'separator' as const }, ...extras]),
      { type: 'separator' },
      { label: messages.quitApplication, click: () => { this.options.quit() } },
    ]))
  }

  /** Remove the icon; called once the quit is confirmed so no dead icon outlives the process. */
  dispose(): void {
    const tray = this.tray
    this.tray = undefined
    tray?.destroy()
  }
}
