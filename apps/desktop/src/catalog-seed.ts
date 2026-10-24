/**
 * First-run installation of the catalog this build ships.
 *
 * The catalog is packed beside the application and installed into the Desktop profile once per
 * catalog revision: plugins through the bundled package manager, content trees into the Harness
 * home, and MCP rows into the store their manager reads. A `kind: tool` tree is a runtime the
 * components expect to find by name in the Harness home (git for the 1C editor), so it is
 * unpacked there rather than installed as a package. Nothing here runs when the catalog is
 * absent (a stock build) or when the profile already carries the same revision.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'

/** Directory beside the packaged application resources holding the packed catalog. */
export const CATALOG_RESOURCES_DIR = 'installer-catalog'

/** Profile-relative marker recording which catalog revision the profile carries. */
export const CATALOG_MARKER_NAME = '.1c-catalog-applied'

/**
 * Profile-relative directory holding the catalog revision the profile installed from.
 * The packed catalog also lives beside the application, but that directory changes with every
 * installation and update, while the profile's own `file:` dependencies must keep resolving.
 */
export const CATALOG_STAGE_DIR = '.1c-catalog'

/** Home-relative directory receiving a `kind: payload` content tree. */
export const PAYLOAD_HOME_DIR = '1c-rules'

/** Store a `kind: mcp` row is written to, and the file name it is read from. */
export const MCP_MANAGER_DIR = '@wingsky-1/dsh-mcp-manager'
export const MCP_MANAGER_STORE = 'mcp.json'

/** Predecessor store file the manager migrates from; used when only it exists. */
export const MCP_MANAGER_LEGACY_STORE = 'dsh-mcp.json'

/** Manager version that moved its store from the home root into its own directory. */
const MCP_MANAGER_SPLIT_MAJOR = 0
const MCP_MANAGER_SPLIT_MINOR = 2
const MCP_MANAGER_SPLIT_PATCH = 5

/** One catalog entry as the packer writes it. */
interface CatalogItem {
  readonly kind?: unknown
  readonly id?: unknown
  readonly version?: unknown
  readonly file?: unknown
  readonly path?: unknown
  readonly serverName?: unknown
  readonly transport?: unknown
  readonly url?: unknown
  readonly spec?: unknown
  readonly bin?: unknown
}

/** Сколько ждём `uv tool install`: он качает Python и колёса пакета. */
const PYTHON_TOOL_TIMEOUT_MS = 20 * 60 * 1000

/** Имя исполняемого файла uv на текущей платформе. */
const UV_BINARY_NAME = process.platform === 'win32' ? 'uv.exe' : 'uv'

/** The catalog manifest written by the packer. */
interface CatalogManifest {
  readonly version?: unknown
  readonly items?: unknown
}

/** What one seeding attempt decided, for the caller's diagnostics. */
export interface CatalogSeedResult {
  readonly outcome: 'absent' | 'skipped' | 'applied' | 'partial'
  readonly detail?: string
}

/** Paths and log sink one seeding attempt works with. */
export interface CatalogSeedOptions {
  /** Directory holding the packed catalog, normally `<resources>/installer-catalog`. */
  readonly catalogDir: string
  /** Desktop profile that receives the plugins. */
  readonly profileDir: string
  /** Harness home receiving content trees and MCP rows. */
  readonly homeDir: string
  /** Electron executable, run in Node mode for the package manager. */
  readonly node: string
  /** Bundled pnpm entry, `runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs` when packaged. */
  readonly pnpm: string
  /** Directory of the Node launcher added to the package manager's PATH. */
  readonly nodeBin: string
  /** Receives every decision and failure; the seeding never throws into startup. */
  readonly note: (message: string) => void
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read the packed catalog manifest, or undefined when this build ships no catalog. */
export function readCatalogManifest(catalogDir: string): CatalogManifest | undefined {
  const path = join(catalogDir, 'manifest.json')
  if (!existsSync(path)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!record(parsed)) throw new Error(`catalog manifest is not an object: ${path}`)
  return parsed as CatalogManifest
}

/** Digest identifying one catalog revision; a profile carrying it is not seeded again. */
export function catalogFingerprint(catalogDir: string): string {
  const manifest = readFileSync(join(catalogDir, 'manifest.json'))
  return createHash('sha256').update(manifest).digest('hex')
}

function catalogItems(manifest: CatalogManifest): readonly CatalogItem[] {
  const items = manifest.items
  if (!Array.isArray(items)) return []
  return items.filter(record) as readonly CatalogItem[]
}

function markedFingerprint(profileDir: string): string | undefined {
  const path = join(profileDir, CATALOG_MARKER_NAME)
  if (!existsSync(path)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return record(parsed) ? text(parsed.fingerprint) : undefined
  }
  catch {
    return undefined
  }
}

function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, contents, { mode: 0o600 })
  renameSync(temporary, path)
}

/** Run the bundled package manager in the profile with the bounded output startup can hold. */
async function runPackageManager(options: CatalogSeedOptions, specs: readonly string[], action: 'add' | 'remove' = 'add'): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: options.homeDir,
    PATH: `${options.nodeBin}${delimiter}${process.env.PATH ?? ''}`,
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.node, [options.pnpm, action, '--reporter=append-only', ...specs], {
      cwd: options.profileDir, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const collect = (chunk: Buffer): void => {
      if (output.length < 16_384) output += chunk.toString('utf8')
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`catalog package manager ${action} exited with ${String(code)}: ${output.trim()}`))
    })
  })
}

/**
 * Catalog-owned package names recorded by the previous seeding run.
 *
 * The catalog stops shipping plugins over time: `dsh-rlm-tools-bsl` is the real case, its engine
 * moved inside `dsh-1c-project-properties`. Without this record the retired package stays in the
 * profile and keeps loading, and two plugins that own the same routes cannot both apply — the
 * second one throws and takes every route it was going to register with it.
 * @param profileDir - Desktop profile whose manifest is read.
 * @returns Package names the catalog installed last time, empty when nothing is recorded.
 */
function readCatalogPackages(profileDir: string): string[] {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!record(manifest)) return []
    const dsh = record(manifest.dsh) ? manifest.dsh : {}
    const profile = record(dsh.profile) ? dsh.profile : {}
    return Array.isArray(profile.catalogPackages) ? profile.catalogPackages.filter(text) : []
  }
  catch {
    return []
  }
}

/**
 * Plugins a previous catalog installed and this one no longer ships.
 * @param profileDir - Desktop profile whose manifest is read.
 * @param current - Package names shipped by the catalog being seeded.
 * @returns Names to uninstall from the profile.
 */
function retiredPackages(profileDir: string, current: readonly string[]): string[] {
  return readCatalogPackages(profileDir).filter(name => !current.includes(name))
}

/**
 * Make the profile's plugin selection match what the catalog ships.
 *
 * Two edits, both of which the profile cannot make for itself: drop bundle rows whose package is
 * not on disk (a row without a package loads nothing and is how a retired plugin keeps a stale
 * claim), and record the catalog-owned set so the next seeding can retire the next departure.
 * @param profileDir - Desktop profile whose manifest is rewritten.
 * @param packages - Package names the install added.
 * @param note - Receives the resulting selection.
 */
function reconcileProfile(
  profileDir: string,
  packages: readonly string[],
  note: (message: string) => void,
  extraRetired: readonly string[] = [],
): void {
  const manifestPath = join(profileDir, 'package.json')
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!record(manifest)) throw new Error(`profile manifest is not an object: ${manifestPath}`)
  const dsh = record(manifest.dsh) ? manifest.dsh : {}
  const profile = record(dsh.profile) ? dsh.profile : {}
  const current = Array.isArray(profile.bundles) ? profile.bundles.filter(text) : []
  const manifestOf = (name: string): unknown => {
    const path = join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(path)) return undefined
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    }
    catch {
      return undefined
    }
  }
  const recorded = readCatalogPackages(profileDir)
  // A retired plugin may still sit on disk: dropping its row is what stops it from loading and
  // claiming routes its successor now owns.
  const retired = [...new Set([...recorded.filter(name => !packages.includes(name)), ...extraRetired])]
    .filter(name => !packages.includes(name))
  // Only rows this catalog retires are dropped. A row without a profile-local package is not
  // stale by itself: base bundles resolve from the application, not from the profile.
  const alive = current.filter(name => !retired.includes(name))
  const dropped = current.filter(name => retired.includes(name))
  const selected = [...alive]
  for (const name of packages) {
    const installed: unknown = manifestOf(name)
    if (!record(installed) || !record(installed.dsh) || !record(installed.dsh.bundle)) continue
    if (!selected.includes(name)) selected.push(name)
  }
  const unchanged = dropped.length === 0
    && selected.length === current.length
    && recorded.length === packages.length
    && recorded.every((name, index) => name === packages[index])
  if (unchanged) return
  if (dropped.length > 0) note(`[catalog] dropped bundle rows without a package: ${dropped.join(', ')}`)
  note(`[catalog] profile bundles selected: ${selected.length}`)
  writeAtomic(manifestPath, `${JSON.stringify({ ...manifest, dsh: { ...dsh, profile: { ...profile, bundles: selected, catalogPackages: [...packages] } } }, undefined, 2)}\n`)
}

/**
 * Copy this catalog revision into the profile and drop the revisions before it.
 * The packed catalog lives beside the application, whose directory changes with every installation
 * and update; the profile's own `file:` dependencies must keep resolving after such a change.
 * @param options - Seeding attempt whose profile receives the copy.
 * @param fingerprint - Digest identifying the revision being staged.
 * @returns Directory holding the staged revision.
 */
function stageCatalog(options: CatalogSeedOptions, fingerprint: string): string {
  const root = join(options.profileDir, CATALOG_STAGE_DIR)
  const stagedDir = join(root, fingerprint.slice(0, 16))
  if (!existsSync(stagedDir)) {
    mkdirSync(root, { recursive: true })
    cpSync(options.catalogDir, stagedDir, { recursive: true })
  }
  for (const entry of readdirSync(root)) {
    if (entry !== basename(stagedDir)) rmSync(join(root, entry), { recursive: true, force: true })
  }
  options.note(`[catalog] staged ${basename(stagedDir)} in the profile`)
  return stagedDir
}

/** Copy one content tree into the Harness home, replacing a tree this catalog owns. */
async function installContentTree(
  stagedDir: string,
  options: CatalogSeedOptions,
  item: CatalogItem,
  destination: string,
  label: string,
): Promise<void> {
  const relative = text(item.path)
  if (relative === undefined) throw new Error(`catalog ${label} ${String(item.id)} is missing a path`)
  const source = join(stagedDir, relative)
  if (!existsSync(source)) throw new Error(`catalog ${label} tree is missing: ${source}`)
  // Windows returns EPERM/EBUSY for a tree an anti-virus scanner or the indexer is reading at
  // that moment. A short bounded retry turns a one-off lock into a slow copy instead of a
  // missing runtime: the tool tree is 86 MB and was lost exactly this way once.
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(destination, { recursive: true, force: true })
      mkdirSync(join(destination, '..'), { recursive: true })
      cpSync(source, destination, { recursive: true })
      options.note(`[catalog] installed ${label} ${String(item.id)}${item.version === undefined ? '' : `@${String(item.version)}`}`)
      return
    }
    catch (error) {
      lastError = error
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function managerStorePath(homeDir: string, profileDir: string): string {
  if (existsSync(join(homeDir, MCP_MANAGER_DIR))) return join(homeDir, MCP_MANAGER_DIR, MCP_MANAGER_STORE)
  const managerManifest = join(profileDir, 'node_modules', ...MCP_MANAGER_DIR.split('/'), 'package.json')
  if (existsSync(managerManifest)) {
    const installed: unknown = JSON.parse(readFileSync(managerManifest, 'utf8'))
    const version = record(installed) ? text(installed.version) : undefined
    const parts = version?.split('.').map(part => Number.parseInt(part, 10)) ?? []
    const [major, minor, patch] = parts
    const split = major !== undefined && minor !== undefined && patch !== undefined
      && (major > MCP_MANAGER_SPLIT_MAJOR
        || (major === MCP_MANAGER_SPLIT_MAJOR && (minor > MCP_MANAGER_SPLIT_MINOR
          || (minor === MCP_MANAGER_SPLIT_MINOR && patch >= MCP_MANAGER_SPLIT_PATCH))))
    if (split) return join(homeDir, MCP_MANAGER_DIR, MCP_MANAGER_STORE)
  }
  const legacy = join(homeDir, MCP_MANAGER_LEGACY_STORE)
  if (existsSync(legacy)) return legacy
  return join(homeDir, MCP_MANAGER_DIR, MCP_MANAGER_STORE)
}

/** Найти uv, который привёз каталог: архив распаковывается как есть. */
function resolveUvBinary(homeDir: string): string | undefined {
  const root = join(homeDir, 'uv')
  if (!existsSync(root)) return undefined
  const dirs = [root]
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) dirs.push(join(root, entry.name))
  }
  for (const dir of dirs) {
    const candidate = join(dir, UV_BINARY_NAME)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Поставить Python-инструмент комплектным uv.
 *
 * Индекс кода строит `rlm-bsl-index` из пакета `rlm-tools-bsl`, то есть это не дерево файлов, а
 * пакет из индекса. Раньше его ставил плагин при первом открытии карточки — то есть у
 * пользователя и с сетью в момент клика. Здесь тот же путь выполняется один раз при раскатке
 * каталога: venv и бинарник встают в дом, в те же каталоги, где их ищет компонент
 * (`<home>/<id>/bin`), поэтому самому плагину ставить уже нечего.
 */
function installPythonTool(options: CatalogSeedOptions, item: CatalogItem): void {
  const spec = text(item.spec)
  if (spec === undefined) throw new Error(`catalog python ${String(item.id)} is missing a spec`)
  const id = String(item.id)
  const uv = resolveUvBinary(options.homeDir)
  if (uv === undefined) throw new Error('uv не найден в доме: инструмент uv должен идти в каталоге раньше python-инструментов')
  const version = text(item.version)
  const target = version === undefined ? spec : `${spec}==${version}`
  const home = join(options.homeDir, id)
  const result = spawnSync(uv, ['tool', 'install', target], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: PYTHON_TOOL_TIMEOUT_MS,
    env: {
      ...process.env,
      UV_TOOL_DIR: join(home, 'tool'),
      UV_TOOL_BIN_DIR: join(home, 'bin'),
      UV_PYTHON_INSTALL_DIR: join(home, 'python'),
      UV_NO_MODIFY_PATH: '1',
      UV_DISABLE_UPDATE: '1',
    },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) {
    throw new Error(`uv tool install ${target} завершился с кодом ${String(result.status)}: ${output.slice(-500)}`)
  }
  const bin = text(item.bin)
  if (bin !== undefined) {
    const placed = join(home, 'bin', process.platform === 'win32' ? `${bin}.exe` : bin)
    if (!existsSync(placed)) throw new Error(`uv tool install ${target} прошёл, но ${placed} не появился`)
  }
  options.note(`[catalog] installed python ${id}`)
}

/** Mount one `kind: mcp` row in the store its manager reads, leaving other rows untouched. */
function installMcpRow(options: CatalogSeedOptions, item: CatalogItem): void {
  const serverName = text(item.serverName) ?? text(item.id)
  if (serverName === undefined) throw new Error('catalog mcp row is missing a server name')
  const path = managerStorePath(options.homeDir, options.profileDir)
  const existing: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, servers: [] }
  if (!record(existing) || !Array.isArray(existing.servers)) throw new Error(`mcp store is not a server list: ${path}`)
  const servers = existing.servers.filter(entry => !(record(entry) && text(entry.name) === serverName))
  servers.push({
    name: serverName,
    transport: text(item.transport) ?? 'streamable-http',
    url: text(item.url),
    enabled: true,
    description: 'DSH для 1С',
  })
  mkdirSync(join(path, '..'), { recursive: true })
  writeAtomic(path, `${JSON.stringify({ ...existing, version: 1, servers }, undefined, 2)}\n`)
  options.note(`[catalog] mcp server mounted: ${serverName}`)
}

/** Harness-home log recording what seeding did: a packaged window has no console to read. */
export const CATALOG_LOG_PATH = 'logs/catalog-seed.log'

/** Send each note both to the caller and to the product log on disk. */
function withCatalogLog(attempt: CatalogSeedOptions): CatalogSeedOptions {
  const path = join(attempt.homeDir, CATALOG_LOG_PATH)
  return {
    ...attempt,
    note: (message: string) => {
      attempt.note(message)
      try {
        mkdirSync(join(attempt.homeDir, 'logs'), { recursive: true })
        appendFileSync(path, `${new Date().toISOString()} ${message}\n`)
      } catch (error) {
        attempt.note(`[catalog] could not append ${path}: ${String(error)}`)
      }
    },
  }
}

/**
 * Install the catalog this build ships into the profile, once per catalog revision.
 *
 * Never throws: a failed attempt leaves the marker unwritten, so the next launch retries it, and
 * startup continues with whatever the profile already has.
 * @param attempt - Packed catalog, profile, Harness home, and the bundled package manager.
 * @returns Which decision was taken, with the failure text when the attempt was incomplete.
 */
export async function seedShippedCatalog(attempt: CatalogSeedOptions): Promise<CatalogSeedResult> {
  const options = withCatalogLog(attempt)
  try {
    const manifest = readCatalogManifest(options.catalogDir)
    if (manifest === undefined) return { outcome: 'absent' }
    const fingerprint = catalogFingerprint(options.catalogDir)
    if (markedFingerprint(options.profileDir) === fingerprint) return { outcome: 'skipped' }
    const items = catalogItems(manifest)
    const stagedDir = stageCatalog(options, fingerprint)
    const tarballs = items
      .filter(item => item.kind === 'plugin')
      .flatMap((item) => {
        const file = text(item.file)
        return file === undefined ? [] : [join(stagedDir, file)]
      })
    const missing = tarballs.filter(path => !existsSync(path))
    if (missing.length > 0) throw new Error(`catalog tarball is missing: ${missing.join(', ')}`)
    const packageNames = items
      .filter(item => item.kind === 'plugin' && text(item.file) !== undefined)
      .map(item => text(item.id) ?? '')
      .filter(name => name !== '')
    // The flavor names plugins it dropped, so an upgrade from a catalog that predates the
    // `catalogPackages` record still retires them.
    const declaredRaw: unknown = record(manifest) ? manifest.retired : undefined
    const declared = Array.isArray(declaredRaw) ? declaredRaw.filter(text).filter(name => !packageNames.includes(name)) : []
    const retired = [...new Set([...retiredPackages(options.profileDir, packageNames), ...declared])]
    if (retired.length > 0) {
      // Best effort: the row drop below already keeps the retired plugin out of the process, and a
      // package manager that refuses to remove must not cost the user the rest of the catalog.
      try {
        await runPackageManager(options, retired, 'remove')
        options.note(`[catalog] uninstalled plugins the catalog no longer ships: ${retired.join(', ')}`)
      }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        options.note(`[catalog] could not uninstall ${retired.join(', ')}: ${reason}`)
      }
    }
    // Content trees are independent of the package set: a failure in one of them must not cost
    // the others, because a missing runtime tree (git) silently disables editor features while
    // the plugins look installed. Failures are collected and reported as a partial attempt.
    const failures: string[] = []
    if (tarballs.length > 0) {
      try {
        await runPackageManager(options, tarballs)
      }
      catch (error) {
        // A registry that cannot resolve a peer must not cost the profile its reconciliation:
        // dropping a retired row is what stops the old plugin from breaking the new one, and it
        // needs no network. The install failure is still reported as a partial attempt.
        failures.push(`plugin install failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    reconcileProfile(options.profileDir, packageNames, options.note, declared)
    for (const item of items) {
      const label = `${String(item.kind)} ${String(item.id)}`
      try {
        if (item.kind === 'payload') await installContentTree(stagedDir, options, item, join(options.homeDir, PAYLOAD_HOME_DIR), 'payload')
        else if (item.kind === 'skill') await installContentTree(stagedDir, options, item, join(options.homeDir, 'skills', String(item.id)), 'skill')
        // A tool lives directly under its id in the Harness home: `git` -> `<home>/git`, which is
        // the second place the 1C editor looks for the binary after an explicit settings path.
        else if (item.kind === 'tool') await installContentTree(stagedDir, options, item, join(options.homeDir, String(item.id)), 'tool')
        // A Python tool is installed with the uv the catalog ships, not unpacked: the runtime is a
        // package from an index, so provisioning it belongs to this step rather than to a plugin
        // that would otherwise need uv, Python and network on the user's first click.
        else if (item.kind === 'python') installPythonTool(options, item)
        else if (item.kind === 'mcp') installMcpRow(options, item)
      }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failures.push(`${label}: ${reason}`)
        options.note(`[catalog] ${label} failed: ${reason}`)
      }
    }
    if (failures.length > 0) {
      const detail = failures.join('; ')
      options.note(`[catalog] seeding incomplete, retrying on the next launch: ${detail}`)
      return { outcome: 'partial', detail }
    }
    writeAtomic(join(options.profileDir, CATALOG_MARKER_NAME), `${JSON.stringify({
      fingerprint,
      catalog: text(manifest.version) ?? '',
      appliedAt: new Date().toISOString(),
    }, undefined, 2)}\n`)
    options.note(`[catalog] applied ${String(manifest.version ?? '')} (${String(items.length)} items)`)
    return { outcome: 'applied' }
  }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    options.note(`[catalog] seeding failed, retrying on the next launch: ${detail}`)
    return { outcome: 'partial', detail }
  }
}
