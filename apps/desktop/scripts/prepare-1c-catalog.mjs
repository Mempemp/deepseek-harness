#!/usr/bin/env node
/**
 * Offline installer catalog for the 1C build of DSH Desktop.
 *
 * Reads the delivery flavor of the 1C bundle (our DSH-1C-deskop-bundle repository,
 * `installer-flavor.yml`), fetches every declared source, packs it, and writes the
 * result into `apps/desktop/installer-catalog/` so the installer ships it:
 *
 *   installer-catalog/
 *     manifest.json      items[] = name, version, digest, bytes, file/path, origin
 *     plugins/*.tgz      npm / git plugin tarballs
 *     mcp/               tarballs for packaged MCP servers (none in the 1C flavor)
 *     payload/<id>/      content trees another component unpacks (1c-rules)
 *     skills/<id>/       skill trees (none in the 1C flavor)
 *
 * The catalog is offline: a shipped tarball must carry its own non-host production
 * dependencies inside the file (`bundleDependencies` via a vendored `node_modules`),
 * because first run seeds the profile from these files and never touches a registry.
 * Host singletons (react, react-dom, `@deepseek-ai/*`) stay out of the tarballs — the
 * application vendors them and bundling them would pull the whole core from npmjs.
 *
 * Deliberate differences from scripts/prepare-installer-catalog.mjs in the bundle
 * repository (this script is self-contained by requirement — one file, no lib/):
 *   - yaml subset parser instead of the `yaml` package (the flavor is scalar mappings);
 *   - `from: market` / `from: backup` / `kind: catalog` are not supported and are
 *     reported as skipped, never guessed;
 *   - a source that cannot be fetched or packed is recorded in `skipped[]` and the run
 *     continues, so a partly unreachable flavor still yields the rest of the catalog;
 *   - a `from: local` tree is copied into the work directory before packing, so the
 *     source repository is never mutated by a catalog run.
 *
 * Usage: node apps/desktop/scripts/prepare-1c-catalog.mjs [--dry-run] [--resume] [--budget <seconds>]
 *        --resume reuses the sources an earlier run already built (per-source state lives
 *        in the catalog directory), and --budget stops starting new sources after N
 *        seconds, so a long catalog can be built in several bounded runs. Both are no-ops
 *        for a plain run; the state file is removed once every source has been built.
 * Env:   DSH_1C_FLAVOR        explicit flavor file (default: <bundle>/installer-flavor.yml)
 *        DSH_1C_BUNDLE_ROOT   bundle repository root (default: the path below)
 *        DSH_1C_CATALOG_ROOT  catalog output root (default: apps/desktop)
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'

const scriptPath = fileURLToPath(import.meta.url)
/** Native path separator, used by the tree-copy filter. */
const sep = process.platform === 'win32' ? '\\' : '/'
/** apps/desktop — the catalog ships beside the desktop application. */
const appDir = resolve(dirname(scriptPath), '..')
/** Fork root (the deepseek-harness monorepo), used to resolve the host package list. */
const repoRoot = resolve(appDir, '..', '..')
const LOG_PREFIX = '[1c-catalog]'

/** Bundle repository that owns installer-flavor.yml. Override with DSH_1C_BUNDLE_ROOT. */
const DEFAULT_BUNDLE_ROOT = 'D:/cursor projects/DSH-1C-deskop-bundle'
const bundleRoot = process.env.DSH_1C_BUNDLE_ROOT?.trim() || DEFAULT_BUNDLE_ROOT

/**
 * @param {...unknown} args
 */
function log(...args) {
  console.log(LOG_PREFIX, ...args)
}

/**
 * @param {...unknown} args
 */
function logError(...args) {
  console.error(LOG_PREFIX, ...args)
}

/* ------------------------------------------------------------------ *
 * Flavor file: a YAML subset parser, validation, and path resolution
 * ------------------------------------------------------------------ */

export const FLAVOR_KINDS = Object.freeze(['plugin', 'mcp', 'skill', 'rules', 'payload', 'catalog'])
export const FLAVOR_FROMS = Object.freeze(['git', 'local', 'npm', 'market', 'backup', 'remote'])

/**
 * Flavor files are hand-written mappings of scalars (`docs`: comments carrying `#`
 * inside a URL must survive, so a comment starts only after whitespace or at the
 * start of a line).
 * @param {string} line
 */
function stripYamlComment(line) {
  let quote
  for (let at = 0; at < line.length; at += 1) {
    const ch = line[at]
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (at === 0 || /\s/u.test(line[at - 1]))) return line.slice(0, at)
  }
  return line
}

/**
 * @param {string} text
 */
function yamlEntries(text) {
  /** @type {Array<{ indent: number; text: string; line: number }>} */
  const entries = []
  let line = 0
  for (const raw of text.split(/\r?\n/u)) {
    line += 1
    const content = stripYamlComment(raw)
    const trimmed = content.trim()
    if (trimmed === '' || trimmed === '---') continue
    entries.push({
      indent: content.length - content.trimStart().length,
      text: trimmed,
      line
    })
  }
  return entries
}

/**
 * @param {string} value
 * @returns {unknown}
 */
function parseScalar(value) {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1)
  }
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null' || trimmed === '~') return null
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((part) => parseScalar(part))
      .filter((part) => part !== undefined)
  }
  return trimmed
}

/**
 * @param {string} text
 * @returns {{ key: string; hasValue: boolean; value: string } | undefined}
 */
function splitPair(text) {
  if (text.endsWith(':') && !text.includes(': ')) {
    return { key: text.slice(0, -1).trim(), hasValue: false, value: '' }
  }
  const at = text.indexOf(': ')
  if (at === -1) return undefined
  return { key: text.slice(0, at).trim(), hasValue: true, value: text.slice(at + 2).trim() }
}

/**
 * @param {Array<{ indent: number; text: string; line: number }>} entries
 * @param {{ i: number }} state
 * @param {number} indent
 * @returns {unknown}
 */
function parseNode(entries, state, indent) {
  const first = entries[state.i]
  if (first === undefined || first.indent < indent) return null
  if (first.text === '-' || first.text.startsWith('- ')) {
    return parseSequence(entries, state, first.indent)
  }
  return parseMapping(entries, state, first.indent)
}

/**
 * @param {Array<{ indent: number; text: string; line: number }>} entries
 * @param {{ i: number }} state
 * @param {number} indent
 * @returns {unknown[]}
 */
function parseSequence(entries, state, indent) {
  /** @type {unknown[]} */
  const list = []
  while (state.i < entries.length) {
    const entry = entries[state.i]
    if (entry.indent !== indent) break
    if (entry.text !== '-' && !entry.text.startsWith('- ')) break
    state.i += 1
    const rest = entry.text === '-' ? '' : entry.text.slice(2).trim()
    if (rest === '') {
      const child = entries[state.i]
      list.push(child !== undefined && child.indent > indent ? parseNode(entries, state, child.indent) : null)
      continue
    }
    const pair = splitPair(rest)
    if (pair === undefined) {
      list.push(parseScalar(rest))
      continue
    }
    /** @type {Record<string, unknown>} */
    const row = {}
    assignPair(row, pair, entry.indent + 2, entries, state)
    parseMappingInto(row, entries, state, entry.indent + 2)
    list.push(row)
  }
  return list
}

/**
 * @param {Record<string, unknown>} target
 * @param {Array<{ indent: number; text: string; line: number }>} entries
 * @param {{ i: number }} state
 * @param {number} indent
 */
function parseMappingInto(target, entries, state, indent) {
  while (state.i < entries.length) {
    const entry = entries[state.i]
    if (entry.indent !== indent) break
    if (entry.text === '-' || entry.text.startsWith('- ')) break
    state.i += 1
    const pair = splitPair(entry.text)
    if (pair === undefined) throw new Error(`flavor line ${entry.line} is not a mapping entry: ${entry.text}`)
    assignPair(target, pair, indent, entries, state)
  }
  return target
}

/**
 * @param {Array<{ indent: number; text: string; line: number }>} entries
 * @param {{ i: number }} state
 * @param {number} indent
 * @returns {Record<string, unknown>}
 */
function parseMapping(entries, state, indent) {
  /** @type {Record<string, unknown>} */
  const target = {}
  parseMappingInto(target, entries, state, indent)
  return target
}

/**
 * @param {Record<string, unknown>} target
 * @param {{ key: string; hasValue: boolean; value: string }} pair
 * @param {number} indent
 * @param {Array<{ indent: number; text: string; line: number }>} entries
 * @param {{ i: number }} state
 */
function assignPair(target, pair, indent, entries, state) {
  if (pair.hasValue) {
    target[pair.key] = parseScalar(pair.value)
    return
  }
  const next = entries[state.i]
  target[pair.key] = next !== undefined && next.indent > indent ? parseNode(entries, state, next.indent) : null
}

/**
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseFlavorYaml(text) {
  const entries = yamlEntries(text)
  if (entries.length === 0) return {}
  const state = { i: 0 }
  const value = parseNode(entries, state, entries[0].indent)
  if (state.i < entries.length) {
    throw new Error(`flavor YAML is malformed at line ${entries[state.i].line}: ${entries[state.i].text}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('installer flavor must be a mapping with sources[]')
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * @param {unknown} source
 * @param {number} index
 * @returns {FlavorSource}
 */
export function validateFlavorSource(source, index) {
  const at = `sources[${index}]`
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`${at} must be a mapping`)
  }
  const row = /** @type {Record<string, unknown>} */ (source)
  const kind = requireString(row.kind, `${at}.kind`)
  const from = requireString(row.from, `${at}.from`)
  if (!FLAVOR_KINDS.includes(kind)) {
    throw new Error(`${at}.kind must be one of ${FLAVOR_KINDS.join(', ')}`)
  }
  if (!FLAVOR_FROMS.includes(from)) {
    throw new Error(`${at}.from must be one of ${FLAVOR_FROMS.join(', ')}`)
  }
  if ((from === 'market' || from === 'backup') && kind !== 'plugin') {
    throw new Error(`${at}: from: ${from} is only valid for kind: plugin`)
  }
  if (from === 'git') requireString(row.url, `${at}.url`)
  if (from === 'local' || from === 'backup') requireString(row.path, `${at}.path`)
  if (from === 'npm') requireString(row.spec, `${at}.spec`)
  if (from === 'market') requireString(row.id, `${at}.id`)
  if (kind === 'mcp') {
    requireString(row.id, `${at}.id`)
    const transport = requireString(row.transport ?? 'stdio', `${at}.transport`)
    if (transport !== 'stdio' && transport !== 'streamable-http') {
      throw new Error(`${at}.transport must be stdio or streamable-http`)
    }
    if (from === 'remote') {
      requireString(row.url, `${at}.url`)
      if (transport === 'stdio') throw new Error(`${at}: from: remote needs a network transport, not stdio`)
    }
  }
  if (kind === 'payload') {
    requireString(row.id, `${at}.id`)
    requireString(row.version, `${at}.version`)
  }
  return /** @type {FlavorSource} */ (row)
}

/**
 * @typedef {object} FlavorSource
 * @property {'plugin' | 'mcp' | 'skill' | 'rules' | 'payload' | 'catalog'} kind
 * @property {'git' | 'local' | 'npm' | 'market' | 'backup' | 'remote'} from
 * @property {string} [url]
 * @property {string} [path]
 * @property {string} [spec]
 * @property {string} [id]
 * @property {string} [version]
 * @property {string} [name]
 * @property {'stdio' | 'streamable-http'} [transport]
 * @property {string} [command]
 * @property {string[]} [args]
 * @property {string} [serverName]
 * @property {Record<string, string>} [headers]
 */

/**
 * @typedef {object} InstallerFlavor
 * @property {string} name
 * @property {string} version
 * @property {string} id
 * @property {FlavorSource[]} sources
 * @property {string} filePath
 */

/**
 * @param {string} filePath
 * @returns {InstallerFlavor}
 */
export function loadInstallerFlavor(filePath) {
  const data = parseFlavorYaml(readFileSync(filePath, 'utf8'))
  const sources = data.sources ?? []
  if (!Array.isArray(sources)) throw new Error(`${filePath}: sources must be an array`)
  const name = typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim() : 'DSH Desktop'
  const version = typeof data.version === 'string' && data.version.trim() !== '' ? data.version.trim() : '0.0.0'
  const id = typeof data.id === 'string' && data.id.trim() !== '' ? data.id.trim() : slugify(name)
  return {
    name,
    version,
    id,
    sources: sources.map((source, index) => validateFlavorSource(source, index)),
    filePath
  }
}

/**
 * @param {string} name
 */
export function slugify(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return slug || 'dsh-desktop'
}

/**
 * Where the catalog lives. `root` is `apps/desktop` unless DSH_1C_CATALOG_ROOT says otherwise.
 * @param {string} [root]
 */
export function catalogOutputPaths(root = appDir) {
  const catalogDir = join(root, 'installer-catalog')
  return {
    catalogDir,
    pluginsDir: join(catalogDir, 'plugins'),
    mcpDir: join(catalogDir, 'mcp'),
    skillsDir: join(catalogDir, 'skills'),
    rulesDir: join(catalogDir, 'rules'),
    payloadDir: join(catalogDir, 'payload'),
    manifestPath: join(catalogDir, 'manifest.json')
  }
}

/**
 * @param {{ flavorPath?: string; appDir?: string }} [options]
 */
export function resolveFlavorPath(options = {}) {
  const explicit = options.flavorPath ?? process.env.DSH_1C_FLAVOR?.trim()
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit)
  const local = join(options.appDir ?? appDir, 'installer-flavor.yml')
  if (existsSync(local)) return local
  return join(bundleRoot, 'installer-flavor.yml')
}

/**
 * @param {string} relativePath
 * @param {string} flavorFilePath
 * @param {string} [fallbackRoot]
 */
export function resolveFlavorLocalPath(relativePath, flavorFilePath, fallbackRoot) {
  if (isAbsolute(relativePath)) return relativePath
  const base = flavorFilePath ? dirname(flavorFilePath) : fallbackRoot
  if (!base) throw new Error(`cannot resolve relative path ${relativePath} without a flavor file`)
  return resolve(base, relativePath)
}

/* ------------------------------------------------------------------ *
 * Host package inventory and plugin manifest checks
 * ------------------------------------------------------------------ */

/**
 * Every host package this revision of the monorepo provides: the `@deepseek-ai/*`
 * packages in the app / root `node_modules` scopes plus the workspace manifests of
 * `packages/*`, `vendor/*`, `apps/*` and `native/**`. A plugin peer or client
 * injection that names a package absent from this set is drift worth failing on:
 * the row would be rejected or silently disabled in the delivered build.
 * @param {string} [root]
 * @param {string} [monorepo]
 * @returns {Set<string>|undefined}
 */
export function hostCorePackages(root = appDir, monorepo = repoRoot) {
  /** @type {Set<string>} */
  const names = new Set()
  const addName = (value) => {
    if (typeof value === 'string' && value.startsWith('@deepseek-ai/')) {
      names.add(value.slice('@deepseek-ai/'.length))
    }
  }
  const scanScope = (directory) => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory)) addName(`@deepseek-ai/${entry}`)
  }
  scanScope(join(root, 'node_modules', '@deepseek-ai'))
  scanScope(join(monorepo, 'node_modules', '@deepseek-ai'))

  const walk = (directory, depth, maxDepth) => {
    if (depth > maxDepth || !existsSync(directory)) return
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        addName(JSON.parse(readFileSync(manifestPath, 'utf8')).name)
      } catch {
        // A malformed workspace manifest is not this script's business to report.
      }
      return
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      walk(join(directory, entry.name), depth + 1, maxDepth)
    }
  }
  walk(join(monorepo, 'packages'), 0, 2)
  walk(join(monorepo, 'vendor'), 0, 1)
  walk(join(monorepo, 'apps'), 0, 1)
  walk(join(monorepo, 'native'), 0, 3)

  return names.size === 0 ? undefined : names
}

/**
 * Host packages a plugin manifest references but this core does not provide: required
 * peers plus client injections (`dsh.client.inject`).
 * @param {Record<string, unknown>|undefined} manifest
 * @param {Set<string>|undefined} [hostNames]
 * @returns {string[]}
 */
export function hostReferenceGaps(manifest, hostNames = hostCorePackages()) {
  if (hostNames === undefined || manifest === undefined) return []
  const optional = /** @type {Record<string, { optional?: boolean }>} */ (manifest.peerDependenciesMeta ?? {})
  const declared = [
    ...Object.keys(/** @type {Record<string, unknown>} */ (manifest.peerDependencies ?? {})).filter(
      (name) => optional[name]?.optional !== true
    ),
    ...(Array.isArray(/** @type {{ client?: { inject?: unknown } }} */ (manifest.dsh ?? {}).client?.inject)
      ? /** @type {{ client: { inject: string[] } }} */ (manifest.dsh).client.inject
      : [])
  ]
  return [...new Set(declared)]
    .filter((name) => typeof name === 'string' && name.startsWith('@deepseek-ai/'))
    .filter((name) => !hostNames.has(name.slice('@deepseek-ai/'.length)))
}

/* ------------------------------------------------------------------ *
 * Tarball helpers
 * ------------------------------------------------------------------ */

/**
 * @param {string} file
 */
export function fileSha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * Content digest of a whole tree: every file's relative POSIX path paired with its
 * own hash, sorted. Directory items (payloads, skills) need it — two revisions of
 * the same tree would otherwise be indistinguishable and never reach an install.
 * @param {string} directory
 */
export function treeSha256(directory) {
  /** @type {string[]} */
  const rows = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        rows.push(`${relative(directory, full).replaceAll('\\', '/')}\u0000${fileSha256(full)}`)
      }
    }
  }
  walk(directory)
  return createHash('sha256').update(rows.join('\n')).digest('hex')
}

/**
 * In git-bash the PATH starts with MSYS tar, which reads `C:\...` as a remote host.
 * Windows ships bsdtar in System32; resolve it explicitly instead of trusting PATH.
 */
export function tarBinary() {
  if (process.platform === 'win32') {
    const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(systemTar)) return systemTar
  }
  return 'tar'
}

/**
 * Quote a spawn argument when Windows `shell: true` would otherwise split it.
 * @param {string} value
 */
function winShellArg(value) {
  if (process.platform !== 'win32' || !/[\s&<>|^()"]/u.test(value)) return value
  return `"${value.replaceAll('"', '\\"')}"`
}

/**
 * `package.json` straight out of a tarball — no extraction, so a 76 MB archive does
 * not have to be unpacked just to learn its name and version.
 * @param {string} archive
 * @returns {Record<string, unknown>}
 */
export function readTarballManifest(archive) {
  for (const member of ['package/package.json', 'package.json']) {
    const result = spawnSync(tarBinary(), ['-xOf', archive, member], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    })
    if (result.status === 0 && (result.stdout ?? '').trim() !== '') {
      return JSON.parse(result.stdout)
    }
  }
  throw new Error(`cannot read package.json from ${archive}`)
}

/**
 * @param {string} stdout
 * @param {string} needle
 */
function tarListMatchesNeedle(stdout, needle) {
  return (stdout || '').split(/\r?\n/u).some((name) => {
    const normalized = name.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '')
    return normalized === `package/${needle}` || normalized === needle || normalized.endsWith(`/${needle}`)
  })
}

/**
 * @param {string} archive
 * @param {string} relativePath
 */
export function tarballContainsPath(archive, relativePath) {
  const needle = relativePath.replaceAll('\\', '/')
  const options = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  for (const member of [`package/${needle}`, needle]) {
    const targeted = spawnSync(tarBinary(), ['-tzf', archive, member], options)
    if (targeted.status === 0 && tarListMatchesNeedle(targeted.stdout, needle)) return true
  }
  const result = spawnSync(tarBinary(), ['-tzf', archive], options)
  return result.status === 0 && tarListMatchesNeedle(result.stdout, needle)
}

/**
 * @param {string} archive
 * @param {string} destination
 */
export function extractArchive(archive, destination) {
  mkdirSync(destination, { recursive: true })
  const result = spawnSync(tarBinary(), ['-xf', archive, '-C', destination], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`tar extract failed for ${archive}: ${(result.stderr || result.stdout || '').trim()}`)
  }
}

/**
 * @param {string} name
 */
function safeFileToken(name) {
  return name.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'item'
}

/**
 * @param {string} name
 */
function safePackageDir(name) {
  return name.replaceAll('/', '+')
}

/* ------------------------------------------------------------------ *
 * Downloading
 * ------------------------------------------------------------------ */

const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_EOCD_SIZE = 22
const ZIP_MAX_COMMENT = 0xffff

/**
 * codeload streams chunked archives without a content-length, so a cut download
 * still closes cleanly and only fails later, mid-extraction. Reading the end of
 * central directory record tells a complete zip from a truncated one immediately.
 * @param {string} archive
 */
export function assertArchiveComplete(archive) {
  if (!archive.endsWith('.zip')) return
  const size = statSync(archive).size
  const window = Math.min(size, ZIP_EOCD_SIZE + ZIP_MAX_COMMENT)
  if (window < ZIP_EOCD_SIZE) throw new Error(`incomplete zip archive: ${size} bytes`)
  const handle = openSync(archive, 'r')
  try {
    const tail = Buffer.alloc(window)
    readSync(handle, tail, 0, window, size - window)
    let at = -1
    for (let offset = tail.length - ZIP_EOCD_SIZE; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
        at = offset
        break
      }
    }
    if (at < 0) throw new Error('incomplete zip archive: no end of central directory record')
    const declared = tail.readUInt32LE(at + 16) + tail.readUInt32LE(at + 12)
    if (declared > size) {
      throw new Error(`incomplete zip archive: ${declared} bytes declared, ${size} downloaded`)
    }
  } finally {
    closeSync(handle)
  }
}

/**
 * @param {string} url
 * @param {string} destination
 */
export async function downloadFile(url, destination) {
  const attempts = 3
  /** @type {unknown} */
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      log(`download start ${url} (attempt ${attempt}/${attempts})`)
      const response = await fetch(url)
      if (!response.ok || !response.body) {
        throw new Error(`download failed (${response.status} ${response.statusText}): ${url}`)
      }
      mkdirSync(dirname(destination), { recursive: true })
      await pipeline(response.body, createWriteStream(destination))
      assertArchiveComplete(destination)
      log(`download wrote ${destination} (${statSync(destination).size} bytes)`)
      return
    } catch (error) {
      lastError = error
      logError(`download failed ${url} (attempt ${attempt}/${attempts})`)
      if (existsSync(destination)) rmSync(destination, { force: true })
      if (attempt === attempts) break
      await new Promise((done) => setTimeout(done, 1500 * attempt))
    }
  }
  throw lastError
}

/**
 * Parse `https://github.com/owner/repo.git#ref` or `github:owner/repo#ref`.
 * @param {string} url
 */
export function parseGitSourceUrl(url) {
  const raw = url.trim()
  const hash = raw.indexOf('#')
  const head = hash === -1 ? raw : raw.slice(0, hash)
  const fragment = hash === -1 ? '' : raw.slice(hash + 1)
  let ref = 'HEAD'
  let subpath = ''
  for (const part of fragment.split('&')) {
    if (part.startsWith('path:/')) subpath = part.slice('path:/'.length)
    else if (part.startsWith('path:')) subpath = part.slice('path:'.length)
    else if (part !== '') ref = part
  }
  let ownerRepo
  const shortcut = /^github:([^#]+)/u.exec(head)
  if (shortcut) {
    ownerRepo = shortcut[1].replace(/\.git$/u, '')
  } else {
    const hosted = /github\.com[/:]([^/]+\/[^/#]+)/u.exec(head)
    if (!hosted) throw new Error(`unsupported git url: ${url}`)
    ownerRepo = hosted[1].replace(/\.git$/u, '')
  }
  return { ownerRepo, ref, subpath, archiveUrl: `https://codeload.github.com/${ownerRepo}/zip/${ref}` }
}

/**
 * @param {string} extractedRoot
 */
function firstExtractedDirectory(extractedRoot) {
  const entries = readdirSync(extractedRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  if (entries.length === 1) return join(extractedRoot, entries[0].name)
  return extractedRoot
}

/**
 * Download `owner/repo#ref` as a codeload zip and return the requested subtree.
 * @param {{ url: string; path?: string; workDir: string; download?: typeof downloadFile }} options
 */
export async function checkoutGitSource(options) {
  const parsed = parseGitSourceUrl(options.url)
  const archive = join(options.workDir, `${safeFileToken(parsed.ownerRepo)}-${safeFileToken(parsed.ref)}.zip`)
  const download = options.download ?? downloadFile
  await download(parsed.archiveUrl, archive)
  const extracted = join(options.workDir, 'extracted')
  extractArchive(archive, extracted)
  const root = firstExtractedDirectory(extracted)
  const nested = options.path || parsed.subpath
  const checkout = nested ? join(root, nested) : root
  if (!existsSync(checkout)) throw new Error(`git checkout path does not exist: ${checkout}`)
  log(`git checkout ${parsed.ownerRepo}#${parsed.ref} -> ${checkout}`)
  return checkout
}

/* ------------------------------------------------------------------ *
 * npm packing with embedded production dependencies
 * ------------------------------------------------------------------ */

function isHostSingletonDependency(name) {
  return name === 'react' || name === 'react-dom' || name.startsWith('@deepseek-ai/')
}

/**
 * @param {Record<string, unknown>} manifest
 */
export function productionDependenciesToBundle(manifest) {
  const dependencies = /** @type {Record<string, unknown>} */ (manifest.dependencies ?? {})
  return Object.keys(dependencies).filter((name) => !isHostSingletonDependency(name))
}

/**
 * @param {string} directory
 * @param {string[]} args
 */
function npmRun(directory, args) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const options = { cwd: directory, encoding: 'utf8', shell: process.platform === 'win32' }
  const first = spawnSync(npm, args, options)
  if (first.status === 0) return first
  return spawnSync(npm, [...args, '--legacy-peer-deps'], options)
}

/**
 * Install the non-host production dependencies into the package and mark them
 * `bundleDependencies`, so `npm pack` embeds `node_modules` inside the tarball and
 * the first-run seed unpacks offline. devDependencies are dropped for this install
 * only: npm still resolves them first, and a pinned dev dependency that has since
 * been unpublished fails the whole production install with ETARGET.
 * @param {string} directory
 * @returns {string[]} names that were vendored
 */
export function ensureBundledProductionDependencies(directory) {
  const manifestPath = join(directory, 'package.json')
  const original = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(original)
  const names = productionDependenciesToBundle(manifest)
  if (names.length === 0) return names

  log(`vendoring ${names.length} production dep(s) in ${directory}: ${names.join(', ')}`)
  const installManifest = {
    ...manifest,
    dependencies: Object.fromEntries(
      Object.entries(/** @type {Record<string, unknown>} */ (manifest.dependencies ?? {})).filter(
        ([name]) => !isHostSingletonDependency(name)
      )
    )
  }
  delete installManifest.devDependencies
  writeFileSync(manifestPath, `${JSON.stringify(installManifest, undefined, 2)}\n`)
  try {
    const install = npmRun(directory, [
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-package-lock',
      '--install-strategy=nested'
    ])
    if (install.status !== 0) {
      throw new Error(
        `cannot vendor production dependencies for ${manifest.name || directory}: ${(
          install.stderr ||
          install.stdout ||
          ''
        ).trim()}`
      )
    }
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, bundleDependencies: names }, undefined, 2)}\n`)
    return names
  } catch (error) {
    writeFileSync(manifestPath, original)
    throw error
  }
}

/**
 * Pack a directory the way npm does (`package/` prefix, gzip).
 * @param {string} directory
 * @param {string} destinationDir
 */
export function packDirectoryAsTgz(directory, destinationDir) {
  mkdirSync(destinationDir, { recursive: true })
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['pack', '--ignore-scripts', '--pack-destination', winShellArg(destinationDir)], {
    cwd: directory,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) {
    throw new Error(`npm pack failed in ${directory}: ${(result.stderr || result.stdout || '').trim()}`)
  }
  const line = (result.stdout || '')
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .at(-1)
  if (!line) throw new Error(`npm pack produced no tarball in ${directory}`)
  const packed = join(destinationDir, line.trim())
  if (!existsSync(packed)) throw new Error(`npm pack reported ${packed} but the file is missing`)
  return packed
}

/**
 * Re-pack a published npm tarball after embedding its production closure.
 * @param {string} archive
 * @param {string} destinationDir
 */
export function repackTarballWithBundledDependencies(archive, destinationDir) {
  const work = mkdtempSync(join(tmpdir(), 'dsh-1c-repack-'))
  try {
    extractArchive(archive, work)
    const packageDir = existsSync(join(work, 'package')) ? join(work, 'package') : firstExtractedDirectory(work)
    const names = ensureBundledProductionDependencies(packageDir)
    if (names.length === 0) return archive
    const repacked = packDirectoryAsTgz(packageDir, destinationDir)
    if (repacked !== archive && dirname(archive) === destinationDir && existsSync(archive)) {
      rmSync(archive, { force: true })
    }
    return repacked
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * `npm pack <spec>` into the catalog, then embed the production closure.
 * @param {string} spec
 * @param {string} destinationDir
 */
export function packNpmSpec(spec, destinationDir) {
  mkdirSync(destinationDir, { recursive: true })
  log(`npm pack start ${spec}`)
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['pack', winShellArg(spec), '--pack-destination', winShellArg(destinationDir)], {
    cwd: destinationDir,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) {
    throw new Error(`npm pack ${spec} failed: ${(result.stderr || result.stdout || '').trim()}`)
  }
  const line = (result.stdout || '')
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .at(-1)
  if (!line) throw new Error(`npm pack ${spec} produced no tarball`)
  const packed = join(destinationDir, line.trim())
  log(`npm pack wrote ${packed}`)
  return repackTarballWithBundledDependencies(packed, destinationDir)
}

/**
 * Every runtime entry a package declares: what the host may execute (`bin`), the
 * subpath it publishes at `.` (`exports["."]`), and what it may import (`main`). A
 * plugin whose `bin` is missing packs fine and then dies at tool time with
 * MODULE_NOT_FOUND, so all of them must exist in the artifact.
 * @param {Record<string, unknown>} manifest
 * @returns {string[]}
 */
export function packageEntryPaths(manifest) {
  /** @type {string[]} */
  const entries = []
  const push = (value) => {
    if (typeof value !== 'string') return
    const entry = value.trim().replace(/^\.\//u, '')
    if (entry === '' || entries.includes(entry)) return
    entries.push(entry)
  }
  const bin = manifest.bin
  if (typeof bin === 'string') push(bin)
  else if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    for (const value of Object.values(bin)) push(value)
  }
  const exportsField = manifest.exports
  if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const dot = /** @type {Record<string, unknown>} */ (exportsField)['.']
    if (typeof dot === 'string') push(dot)
    else if (dot && typeof dot === 'object' && !Array.isArray(dot)) push(dot.default)
  }
  push(manifest.main)
  if (entries.length === 0) entries.push('index.js')
  return entries
}

/**
 * Pack a plugin checkout for the catalog.
 *
 * Git checkouts of TypeScript DSH plugins usually omit their build output (`lib/`,
 * `dist/`), so every declared entry is checked. Prefer the published npm tarball
 * (it already ran prepublish), then a local build of the checkout.
 * @param {string} directory
 * @param {string} destinationDir
 * @returns {string} the packed tarball
 */
export function packPluginDirectory(directory, destinationDir) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const name = typeof manifest.name === 'string' ? manifest.name : ''
  const version = typeof manifest.version === 'string' ? manifest.version : ''
  const entries = packageEntryPaths(manifest)
  const label = name ? `${name}@${version || '?'}` : directory
  const missingInTree = () => entries.filter((entry) => !existsSync(join(directory, entry)))
  const missing = missingInTree()

  if (missing.length > 0 && name) {
    // Exact version only — an unversioned `name` would pack latest, not the pinned tag.
    log(`pack: ${missing.join(', ')} missing in git tree for ${label}; trying the published npm tarball`)
    const specs = version ? [`${name}@${version}`] : [name]
    for (const spec of new Set(specs)) {
      try {
        const packed = packNpmSpec(spec, destinationDir)
        const absent = entries.filter((entry) => !tarballContainsPath(packed, entry))
        if (absent.length === 0) {
          log(`pack: npm fallback packed ${spec} -> ${packed}`)
          return packed
        }
        log(`pack: npm fallback ${spec} is missing ${absent.join(', ')}; continuing`)
        rmSync(packed, { force: true })
      } catch (error) {
        log(`pack: npm fallback ${spec} failed (${error instanceof Error ? error.message : String(error)})`)
      }
    }
  }

  if (missing.length > 0) {
    log(`pack: local build start for ${label} (missing ${missing.join(', ')})`)
    const install = npmRun(directory, ['install', '--ignore-scripts'])
    if (install.status !== 0) {
      throw new Error(
        `cannot install build deps for ${name || directory}: ${(install.stderr || install.stdout || '').trim()}`
      )
    }
    const scripts = /** @type {Record<string, unknown>} */ (manifest.scripts ?? {})
    const candidates = ['build', 'bundle', 'prepare'].filter((script) => typeof scripts[script] === 'string')
    if (candidates.length === 0) {
      throw new Error(`git plugin ${name || directory} is missing ${missing.join(', ')} and has no build script`)
    }
    const failures = []
    let used = ''
    for (const script of candidates) {
      log(`pack: npm run ${script} (${label})`)
      const built = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
        cwd: directory,
        encoding: 'utf8',
        shell: process.platform === 'win32'
      })
      if (missingInTree().length === 0) {
        used = script
        break
      }
      failures.push(
        `${script} (exit ${built.status}): ${(built.stderr || '').trim()}\n${(built.stdout || '').trim()}`
      )
    }
    const stillMissing = missingInTree()
    if (stillMissing.length > 0) {
      throw new Error(
        `git plugin ${name || directory} failed to produce ${stillMissing.join(', ')}: ${failures.join('\n')}`
      )
    }
    log(`pack: local build produced ${missing.join(', ')} via npm run ${used}`)
  }

  ensureBundledProductionDependencies(directory)
  const packed = packDirectoryAsTgz(directory, destinationDir)
  const absentFromTarball = entries.filter((entry) => !tarballContainsPath(packed, entry))
  if (absentFromTarball.length > 0) {
    throw new Error(
      `packed ${name || directory} does not contain ${absentFromTarball.join(', ')} — the packed tree is missing a declared entry`
    )
  }
  log(`pack: packed ${label} -> ${packed}`)
  return packed
}

/* ------------------------------------------------------------------ *
 * Source materialization
 * ------------------------------------------------------------------ */

/**
 * Top-level entries a `kind: payload` tree never ships: source-repository tooling
 * and host metadata a consumer of the payload does not read. The content itself
 * (`content/`, `adapters/`, `openspec/`) travels whole — dropping a section would
 * reproduce exactly the broken cross-references this kind exists to prevent.
 */
const PAYLOAD_EXCLUDED_ENTRIES = Object.freeze([
  '.git',
  '.github',
  '.claude-plugin',
  '.cursor-plugin',
  '.agents',
  'plugins',
  'tools',
  'node_modules',
  'install.ps1',
  'AGENT-INSTALL.md',
  'README.md',
  'References.md'
])

/**
 * @param {string} source
 * @param {string} destination
 */
export function copyPayloadTree(source, destination) {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (PAYLOAD_EXCLUDED_ENTRIES.includes(entry.name)) continue
    cpSync(join(source, entry.name), join(destination, entry.name), { recursive: true })
  }
}

/**
 * A tree to pack for a source that needs one, in the work directory. `from: local`
 * trees are copied first: a catalog run must not rewrite the bundle repository it
 * reads (vendoring writes `bundleDependencies` and a `node_modules`).
 * @param {FlavorSource} source
 * @param {number|string} index
 * @param {string} workRoot
 * @param {string} flavorFilePath
 * @returns {Promise<string>}
 */
async function materializeTree(source, index, workRoot, flavorFilePath) {
  const slot = join(workRoot, `src-${index}`)
  mkdirSync(slot, { recursive: true })
  if (source.from === 'local') {
    const local = resolveFlavorLocalPath(source.path ?? '', flavorFilePath, bundleRoot)
    if (!existsSync(local)) throw new Error(`local path does not exist: ${local}`)
    const destination = join(slot, basename(local))
    cpSync(local, destination, {
      recursive: true,
      filter: (entry) => !entry.includes(`${sep}node_modules`) && !entry.includes(`${sep}.git`)
    })
    log(`local tree copied ${local} -> ${destination}`)
    return destination
  }
  if (source.from === 'git') {
    return checkoutGitSource({ url: source.url ?? '', path: source.path, workDir: slot })
  }
  if (source.from === 'npm') {
    const packed = packNpmSpec(source.spec ?? '', slot)
    const extracted = join(slot, 'pkg')
    extractArchive(packed, extracted)
    const root = firstExtractedDirectory(extracted)
    return source.path ? join(root, source.path) : root
  }
  throw new Error(`cannot materialize from: ${source.from}`)
}

/* ------------------------------------------------------------------ *
 * Catalog build
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} CatalogItem
 * @property {'plugin' | 'mcp' | 'skill' | 'rules' | 'payload'} kind
 * @property {string} id
 * @property {string} [label]
 * @property {string} [name]
 * @property {string} [version]
 * @property {string} [file]
 * @property {string} [path]
 * @property {string} [digest]
 * @property {number} [bytes]
 * @property {string} [origin]
 * @property {string} [transport]
 * @property {string} [serverName]
 * @property {string} [url]
 */

/**
 * @param {string} kind
 * @param {string} title
 */
function catalogListLabel(kind, title) {
  switch (kind) {
    case 'plugin':
      return `Plugin: ${title}`
    case 'mcp':
      return `MCP: ${title}`
    case 'skill':
      return `Skill: ${title}`
    case 'rules':
      return `Rules: ${title}`
    case 'payload':
      return `Payload: ${title}`
    default:
      return title
  }
}

/**
 * @param {string} directory
 */
function emptyDir(directory) {
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
}

/**
 * One-line identity of a flavor source, for logs and the manifest.
 * @param {FlavorSource} source
 */
export function describeSource(source) {
  const parts = [source.kind, `from=${source.from}`]
  if (source.id) parts.push(`id=${source.id}`)
  if (source.name) parts.push(`name=${source.name}`)
  if (source.spec) parts.push(`spec=${source.spec}`)
  if (source.url) parts.push(`url=${source.url}`)
  if (source.path) parts.push(`path=${source.path}`)
  return parts.join(' ')
}

/**
 * Where a source came from, as the report and manifest state it: `npm <spec>`,
 * `git <url>`, `local <path>`, `remote <url>`.
 * @param {FlavorSource} source
 */
function sourceOrigin(source) {
  if (source.from === 'npm') return `npm ${source.spec ?? ''}`.trim()
  if (source.from === 'git') return `git ${source.url ?? ''}`.trim()
  if (source.from === 'local') return `local ${source.path ?? ''}`.trim()
  return `${source.from} ${source.url ?? source.spec ?? source.path ?? ''}`.trim()
}

/**
 * @param {string} directory
 * @param {Set<string>|undefined} hostNames
 */
function pluginManifestGaps(directory, hostNames) {
  try {
    return hostReferenceGaps(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')), hostNames)
  } catch {
    return []
  }
}

/**
 * @param {FlavorSource} source
 * @param {number|string} index
 * @param {ReturnType<typeof catalogOutputPaths>} paths
 * @param {string} workRoot
 * @param {string} flavorFilePath
 * @param {Set<string>|undefined} hostNames
 * @returns {Promise<CatalogItem[]>}
 */
async function vendorOneSource(source, index, paths, workRoot, flavorFilePath, hostNames) {
  const at = `sources[${index}]`
  log(`${at} start ${describeSource(source)}`)

  if (source.kind === 'catalog') {
    throw new Error(`${at} kind: catalog (a nested flavor file) is not supported by this script`)
  }
  if (source.from === 'market' || source.from === 'backup') {
    throw new Error(`${at} from: ${source.from} is not supported by this script — pin the source to npm or git`)
  }

  if (source.kind === 'plugin') {
    let packed
    if (source.from === 'npm') {
      packed = packNpmSpec(source.spec ?? '', paths.pluginsDir)
    } else {
      const tree = await materializeTree(source, index, workRoot, flavorFilePath)
      if (statSync(tree).isFile() && tree.endsWith('.tgz')) {
        const destination = join(paths.pluginsDir, basename(tree))
        cpSync(tree, destination)
        packed = destination
      } else {
        const treeGaps = pluginManifestGaps(tree, hostNames)
        if (treeGaps.length > 0) {
          throw new Error(`plugin references packages absent from this core: ${treeGaps.join(', ')}`)
        }
        packed = packPluginDirectory(tree, paths.pluginsDir)
      }
    }
    // The tarball is what ships, so the identity and the peer drift check read it,
    // not the checkout or the published package they were derived from.
    const manifest = readTarballManifest(packed)
    const gaps = hostReferenceGaps(manifest, hostNames)
    if (gaps.length > 0) {
      throw new Error(`plugin references packages absent from this core: ${gaps.join(', ')}`)
    }
    const name = typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : source.id ?? 'plugin'
    const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
    return [
      {
        kind: 'plugin',
        id: source.id ?? name,
        name,
        version,
        label: catalogListLabel('plugin', name),
        file: relative(paths.catalogDir, packed).replaceAll('\\', '/'),
        digest: fileSha256(packed),
        bytes: statSync(packed).size,
        origin: sourceOrigin(source)
      }
    ]
  }

  if (source.kind === 'mcp') {
    const id = source.id ?? `mcp-${index}`
    /** @type {CatalogItem} */
    const item = {
      kind: 'mcp',
      id,
      label: catalogListLabel('mcp', id),
      transport: source.transport ?? 'stdio',
      serverName: source.serverName ?? id,
      url: source.from !== 'git' ? source.url : undefined,
      origin: sourceOrigin(source)
    }
    if (source.from === 'local' || source.from === 'git' || source.from === 'npm') {
      const tree = await materializeTree(source, index, workRoot, flavorFilePath)
      if (statSync(tree).isDirectory() && existsSync(join(tree, 'package.json'))) {
        const packed = packDirectoryAsTgz(tree, paths.mcpDir)
        const manifest = readTarballManifest(packed)
        item.file = relative(paths.catalogDir, packed).replaceAll('\\', '/')
        item.digest = fileSha256(packed)
        item.bytes = statSync(packed).size
        item.name = typeof manifest.name === 'string' ? manifest.name : undefined
        item.version = typeof manifest.version === 'string' ? manifest.version : undefined
      }
    }
    return [item]
  }

  if (source.kind === 'payload') {
    const tree = await materializeTree(source, index, workRoot, flavorFilePath)
    const id = source.id ?? `payload-${index}`
    const version = source.version ?? '0.0.0'
    const destination = join(paths.payloadDir, safeFileToken(id))
    log(`${at} payload: copying tree ${tree} -> ${destination}`)
    copyPayloadTree(tree, destination)
    if (!existsSync(join(destination, 'content'))) {
      throw new Error(`payload has no content/ directory: ${tree}`)
    }
    return [
      {
        kind: 'payload',
        id,
        name: source.name ?? id,
        version,
        label: catalogListLabel('payload', id),
        path: relative(paths.catalogDir, destination).replaceAll('\\', '/'),
        digest: treeSha256(destination),
        bytes: dirBytes(destination),
        origin: sourceOrigin(source)
      }
    ]
  }

  if (source.kind === 'skill') {
    const tree = await materializeTree(source, index, workRoot, flavorFilePath)
    const roots = collectSkillRoots(tree)
    if (roots.length === 0) throw new Error(`skill has no SKILL.md under ${tree}`)
    return roots.map((root) => {
      const id = roots.length === 1 && source.id ? source.id : basename(root)
      const destination = join(paths.skillsDir, safeFileToken(id))
      rmSync(destination, { recursive: true, force: true })
      mkdirSync(dirname(destination), { recursive: true })
      cpSync(root, destination, { recursive: true })
      return {
        kind: 'skill',
        id,
        label: catalogListLabel('skill', id),
        path: relative(paths.catalogDir, destination).replaceAll('\\', '/'),
        digest: treeSha256(destination),
        bytes: dirBytes(destination),
        origin: sourceOrigin(source)
      }
    })
  }

  if (source.kind === 'rules') {
    const tree = await materializeTree(source, index, workRoot, flavorFilePath)
    const sourceFile = statSync(tree).isDirectory()
      ? ['AGENTS.md', 'cordis.patch.yml'].map((name) => join(tree, name)).find((file) => existsSync(file))
      : tree
    if (!sourceFile) throw new Error(`rules path has no AGENTS.md or cordis.patch.yml: ${tree}`)
    const destination = join(paths.rulesDir, basename(sourceFile))
    mkdirSync(paths.rulesDir, { recursive: true })
    cpSync(sourceFile, destination)
    return [
      {
        kind: 'rules',
        id: source.id ?? basename(sourceFile),
        label: catalogListLabel('rules', basename(sourceFile)),
        path: relative(paths.catalogDir, destination).replaceAll('\\', '/'),
        digest: fileSha256(destination),
        bytes: statSync(destination).size,
        origin: sourceOrigin(source)
      }
    ]
  }

  throw new Error(`unsupported kind: ${source.kind}`)
}

/**
 * @param {string} directory
 */
function dirBytes(directory) {
  let total = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) total += statSync(full).size
    }
  }
  walk(directory)
  return total
}

/**
 * @param {string} directory
 * @returns {string[]}
 */
export function collectSkillRoots(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return []
  if (existsSync(join(directory, 'SKILL.md'))) return [directory]
  /** @type {string[]} */
  const roots = []
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue
    roots.push(...collectSkillRoots(join(directory, entry.name)))
  }
  return roots
}

/**
 * @typedef {object} PrepareOptions
 * @property {string} [appDir]
 * @property {string} [flavorPath]
 * @property {string} [workRoot]
 * @property {boolean} [dryRun]
 * @property {boolean} [resume] Reuse sources already built by an earlier run.
 * @property {number} [budget] Stop starting new sources after this many seconds.
 */

/** Per-source state file: written after every source, removed when the catalog is complete. */
const STATE_FILE = '.state.json'

/**
 * @typedef {object} StateRecord
 * @property {number|string} index
 * @property {string} source
 * @property {CatalogItem[]} items
 * @property {string} [skipped]
 * @property {number} [seconds]
 */

/**
 * Catalog manifest assembled from the per-source records, in flavor order — a stable
 * order matters, because the first-run seed fingerprints the manifest file itself.
 * @param {InstallerFlavor} flavor
 * @param {Record<string, StateRecord>} records
 */
function manifestOfRecords(flavor, records) {
  const ordered = Object.keys(records)
    .map((key) => Number(key))
    .sort((left, right) => left - right)
  /** @type {CatalogItem[]} */
  const items = []
  /** @type {string[]} */
  const skipped = []
  for (const index of ordered) {
    const record = records[index]
    if (record === undefined) continue
    items.push(...(record.items ?? []))
    if (typeof record.skipped === 'string') skipped.push(record.skipped)
  }
  return {
    name: flavor.name,
    version: flavor.version,
    id: flavor.id,
    generatedBy: 'apps/desktop/scripts/prepare-1c-catalog.mjs',
    flavor: flavor.filePath,
    items,
    skipped
  }
}

/**
 * Build the catalog: fetch every flavor source, pack it, write the manifest.
 * A source that cannot be fetched or packed is recorded in `skipped[]` and the run
 * continues — a partly unreachable flavor still yields the rest of the catalog.
 * @param {PrepareOptions} [options]
 */
export async function prepareCatalog(options = {}) {
  const root = options.appDir ?? process.env.DSH_1C_CATALOG_ROOT?.trim() ?? appDir
  const paths = catalogOutputPaths(root)
  const flavorPath = resolveFlavorPath({ flavorPath: options.flavorPath, appDir: root })
  if (!existsSync(flavorPath)) {
    throw new Error(`installer flavor not found: ${flavorPath} (set DSH_1C_FLAVOR or DSH_1C_BUNDLE_ROOT)`)
  }
  const flavor = loadInstallerFlavor(flavorPath)
  log(`flavor ${flavorPath} -> ${flavor.name} ${flavor.version}, ${flavor.sources.length} source(s)`)

  if (options.dryRun) {
    flavor.sources.forEach((source, index) => log(`plan sources[${index}] ${describeSource(source)}`))
    return {
      manifest: { name: flavor.name, version: flavor.version, id: flavor.id, items: [], skipped: [] },
      paths,
      skipped: [],
      flavor,
      dryRun: true
    }
  }

  const resume = options.resume === true
  const budgetSeconds = options.budget ?? 0
  const startedAt = Date.now()

  if (!resume) emptyDir(paths.catalogDir)
  for (const directory of [paths.pluginsDir, paths.mcpDir, paths.skillsDir, paths.rulesDir, paths.payloadDir]) {
    mkdirSync(directory, { recursive: true })
  }
  /** Per-source result kept between runs, so a long catalog can be built in chunks. */
  const statePath = join(paths.catalogDir, STATE_FILE)
  /** @type {Record<string, StateRecord>} */
  const records =
    resume && existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, 'utf8')).records ?? {}
      : {}
  if (!resume) rmSync(statePath, { force: true })
  const manifestFromRecords = () => manifestOfRecords(flavor, records)
  const flush = () => {
    writeFileSync(statePath, `${JSON.stringify({ flavor: flavor.filePath, records }, null, 2)}\n`)
    writeFileSync(paths.manifestPath, `${JSON.stringify(manifestFromRecords(), null, 2)}\n`)
  }

  const hostNames = hostCorePackages()
  log(
    hostNames === undefined
      ? 'host package inventory unavailable — skipping the plugin/peer drift check'
      : `host package inventory: ${hostNames.size} @deepseek-ai/* package(s)`
  )

  const workRoot = options.workRoot ?? mkdtempSync(join(tmpdir(), 'dsh-1c-catalog-'))

  try {
    for (const [index, source] of flavor.sources.entries()) {
      if (records[index] !== undefined) {
        log(`sources[${index}] ${describeSource(source)}: already built, reusing it`)
        continue
      }
      if (budgetSeconds > 0 && (Date.now() - startedAt) / 1000 >= budgetSeconds) {
        log(`time budget ${budgetSeconds}s reached before sources[${index}] — run again to continue`)
        break
      }
      const startedSource = Date.now()
      try {
        const built = await vendorOneSource(source, index, paths, workRoot, flavor.filePath, hostNames)
        records[index] = {
          index,
          source: describeSource(source),
          items: built,
          seconds: Number(((Date.now() - startedSource) / 1000).toFixed(1))
        }
        log(
          `sources[${index}] done in ${records[index].seconds}s: ` +
            `${built.map((item) => `${item.kind}/${item.id}`).join(', ') || '(rows only)'}`
        )
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const name = source.id ?? source.name ?? source.spec ?? source.url ?? source.path ?? ''
        const entry = `sources[${index}] ${source.kind} ${name} (${sourceOrigin(source)}) — ${detail}`
        logError(`SKIPPED ${entry}`)
        records[index] = { index, source: describeSource(source), items: [], skipped: entry }
      }
      // Written after every source: a run stopped mid-source loses only that source.
      flush()
    }
  } finally {
    if (options.workRoot === undefined) rmSync(workRoot, { recursive: true, force: true })
  }

  const manifest = manifestFromRecords()
  const pending = flavor.sources.map((_, index) => index).filter((index) => records[index] === undefined)
  mkdirSync(paths.catalogDir, { recursive: true })
  writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  if (pending.length === 0) rmSync(statePath, { force: true })

  const plugins = manifest.items.filter((item) => item.kind === 'plugin').length
  const payloads = manifest.items.filter((item) => item.kind === 'payload').length
  const mcp = manifest.items.filter((item) => item.kind === 'mcp').length
  const skills = manifest.items.filter((item) => item.kind === 'skill').length
  log(
    `done: ${manifest.items.length} item(s) built (plugins=${plugins} payloads=${payloads} mcp=${mcp} skills=${skills}), ` +
      `${manifest.skipped.length} skipped, ${dirBytes(paths.catalogDir)} bytes in ${paths.catalogDir}`
  )
  if (pending.length > 0) {
    log(`${pending.length} of ${flavor.sources.length} source(s) still pending: ${pending.join(', ')}`)
  }
  return { manifest, paths, skipped: manifest.skipped, flavor, dryRun: false, pending }
}

/**
 * @param {number} value
 */
function humanBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function invokedDirectly() {
  const entry = process.argv[1]
  if (!entry) return false
  return pathToFileURL(resolve(entry)).href === import.meta.url
}

function cliArg(name) {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return undefined
  const value = process.argv[at + 1]
  return value === undefined || value.startsWith('--') ? '' : value
}

if (invokedDirectly()) {
  const dryRun = process.argv.includes('--dry-run')
  const resume = process.argv.includes('--resume')
  const budget = Number.parseInt(cliArg('budget') ?? '', 10)
  log('CLI start')
  const started = Date.now()
  const prepared = await prepareCatalog({
    dryRun,
    resume,
    budget: Number.isFinite(budget) ? budget : 0
  })
  if (!dryRun) {
    for (const item of prepared.manifest.items) {
      log(
        `ITEM ${item.kind} | ${item.name ?? item.id} | ${item.version ?? '-'} | ${humanBytes(item.bytes ?? 0)} | ` +
          `${item.file ?? item.path ?? item.url ?? '-'} | ${item.origin ?? '-'}`
      )
    }
    log(`catalog: ${prepared.paths.catalogDir}`)
    log(`manifest: ${prepared.paths.manifestPath}`)
    if (prepared.skipped.length > 0) {
      log(`${prepared.skipped.length} source(s) skipped:`)
      for (const entry of prepared.skipped) log(`  - ${entry}`)
    }
    log(
      `finished in ${((Date.now() - started) / 1000).toFixed(1)}s: ` +
        `${prepared.manifest.items.length} item(s) built, ${prepared.skipped.length} skipped, ` +
        `${prepared.pending.length} source(s) pending`
    )
    log(prepared.pending.length === 0 ? 'CATALOG COMPLETE' : `CATALOG INCOMPLETE (pending: ${prepared.pending.join(', ')})`)
  } else {
    log('dry run: nothing downloaded or written')
  }
}
