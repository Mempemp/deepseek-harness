/** Electron Node-mode startup, with private shell launchers scoped to package installation. */

import { delimiter } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * Select Electron's Node mode and the shell launcher used by package scripts.
 * @param executable - Electron executable running the application.
 * @param bin - Directory containing the node shell launcher.
 * @param environment - Caller environment preserved for plugin execution.
 * @returns Environment for a Node-mode child process.
 */
export function desktopNodeEnvironment(executable: string, bin: string | undefined, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    // Plugins resolve the Harness home from DSH_HOME. The desktop keeps it implicit, so a plugin
    // that reads the variable falls back to its own default — for engram that is the predecessor
    // product's home, and its MCP row lands where this build never looks.
    DSH_HOME: environment.DSH_HOME ?? resolveDshHome(),
    ELECTRON_RUN_AS_NODE: '1',
    ...(bin === undefined ? {} : { DSH_DESKTOP_NODE_EXECUTABLE: executable, PATH: `${bin}${delimiter}${environment.PATH ?? ''}` }),
  }
}
