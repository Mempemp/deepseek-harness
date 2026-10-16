/** First-run catalog seeding: what it decides, what it writes, and what it leaves alone. */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CATALOG_MARKER_NAME,
  MCP_MANAGER_DIR,
  MCP_MANAGER_LEGACY_STORE,
  MCP_MANAGER_STORE,
  PAYLOAD_HOME_DIR,
  catalogFingerprint,
  readCatalogManifest,
  seedShippedCatalog,
  type CatalogSeedOptions,
} from '../src/catalog-seed.ts'

/** One throwaway catalog, profile, and home per case; seeding never touches the test runner's own paths. */
function fixture(files: Readonly<Record<string, string>>, options: { readonly legacyMcpStore?: boolean } = {}): {
  options: CatalogSeedOptions
  catalogDir: string
  written: string[]
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-catalog-'))
  const catalogDir = join(root, 'resources', 'installer-catalog')
  const profileDir = join(root, 'home', 'profiles', 'desktop')
  const homeDir = join(root, 'home')
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(catalogDir, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-desktop', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, undefined, 2)}\n`)
  if (options.legacyMcpStore === true) {
    writeFileSync(join(homeDir, MCP_MANAGER_LEGACY_STORE), `${JSON.stringify({ version: 1, servers: [{ name: 'v8std', url: 'https://old.example/mcp' }] }, undefined, 2)}\n`)
  }
  const written: string[] = []
  return {
    catalogDir, written,
    options: {
      catalogDir, profileDir, homeDir,
      node: process.execPath, pnpm: join(root, 'pnpm.mjs'), nodeBin: root,
      note: message => written.push(message),
    },
  }
}

const payloadItem = { kind: 'payload', id: '1c-rules', version: '2026.10.14', path: 'payload/1c-rules' }
const mcpItem = { kind: 'mcp', id: 'v8std', serverName: 'v8std', transport: 'streamable-http', url: 'https://ai.v8std.ru/mcp' }

function manifestFile(items: readonly unknown[]): string {
  return `${JSON.stringify({ id: 'dsh-1c', version: '0.1.0', items }, undefined, 2)}\n`
}

describe('catalog seeding', () => {
  it('reports no catalog when the build ships none', async () => {
    const empty = fixture({})
    expect(readCatalogManifest(empty.catalogDir)).toBeUndefined()
    await expect(seedShippedCatalog(empty.options)).resolves.toEqual({ outcome: 'absent' })
  })

  it('installs a payload tree and mounts an MCP row, then skips the same revision', async () => {
    const files = {
      'manifest.json': manifestFile([payloadItem, mcpItem]),
      'payload/1c-rules/content/rules/1c.md': '# правила\n',
    }
    const first = fixture(files)
    await expect(seedShippedCatalog(first.options)).resolves.toEqual({ outcome: 'applied' })
    const home = first.options.homeDir
    expect(readFileSync(join(home, PAYLOAD_HOME_DIR, 'content', 'rules', '1c.md'), 'utf8')).toBe('# правила\n')
    const store = JSON.parse(readFileSync(join(home, MCP_MANAGER_DIR, MCP_MANAGER_STORE), 'utf8')) as { servers: { name: string; url?: string; enabled?: boolean }[] }
    expect(store.servers).toHaveLength(1)
    expect(store.servers[0]).toMatchObject({ name: 'v8std', url: 'https://ai.v8std.ru/mcp', enabled: true })
    const marker = JSON.parse(readFileSync(join(first.options.profileDir, CATALOG_MARKER_NAME), 'utf8')) as { fingerprint: string }
    expect(marker.fingerprint).toBe(catalogFingerprint(first.catalogDir))

    // The same revision is not applied twice, and a changed manifest is.
    await expect(seedShippedCatalog(first.options)).resolves.toEqual({ outcome: 'skipped' })
    writeFileSync(join(first.catalogDir, 'manifest.json'), manifestFile([payloadItem, mcpItem, { kind: 'mcp', id: 'second', serverName: 'second', url: 'https://second.example/mcp' }]))
    await expect(seedShippedCatalog(first.options)).resolves.toEqual({ outcome: 'applied' })
  })

  it('keeps rows the profile already had and replaces its own', async () => {
    const files = { 'manifest.json': manifestFile([mcpItem]) }
    const seeded = fixture(files)
    mkdirSync(join(seeded.options.homeDir, MCP_MANAGER_DIR), { recursive: true })
    writeFileSync(join(seeded.options.homeDir, MCP_MANAGER_DIR, MCP_MANAGER_STORE),
      `${JSON.stringify({ version: 1, servers: [{ name: 'mine', url: 'https://mine.example/mcp' }, { name: 'v8std', url: 'https://stale.example/mcp' }] }, undefined, 2)}\n`)
    await expect(seedShippedCatalog(seeded.options)).resolves.toEqual({ outcome: 'applied' })
    const store = JSON.parse(readFileSync(join(seeded.options.homeDir, MCP_MANAGER_DIR, MCP_MANAGER_STORE), 'utf8')) as { servers: { name: string; url?: string }[] }
    expect(store.servers.map(server => server.name).sort()).toEqual(['mine', 'v8std'])
    expect(store.servers.find(server => server.name === 'v8std')?.url).toBe('https://ai.v8std.ru/mcp')
  })

  it('writes the predecessor store when only it exists, and never loses its rows', async () => {
    const seeded = fixture({ 'manifest.json': manifestFile([mcpItem]) }, { legacyMcpStore: true })
    await expect(seedShippedCatalog(seeded.options)).resolves.toEqual({ outcome: 'applied' })
    const store = JSON.parse(readFileSync(join(seeded.options.homeDir, MCP_MANAGER_LEGACY_STORE), 'utf8')) as { servers: { name: string; url?: string }[] }
    expect(store.servers.map(server => server.name).sort()).toEqual(['v8std'])
    expect(store.servers[0]?.url).toBe('https://ai.v8std.ru/mcp')
    expect(existsSync(join(seeded.options.homeDir, MCP_MANAGER_DIR, MCP_MANAGER_STORE))).toBe(false)
  })

  it('stages the catalog inside the profile and drops the revision before it', async () => {
    const files = { 'manifest.json': manifestFile([payloadItem]), 'payload/1c-rules/content/rules/1c.md': '# правила\n' }
    const seeded = fixture(files)
    await expect(seedShippedCatalog(seeded.options)).resolves.toEqual({ outcome: 'applied' })
    const stageRoot = join(seeded.options.profileDir, '.1c-catalog')
    const before = readdirSync(stageRoot)
    expect(before).toHaveLength(1)
    expect(existsSync(join(stageRoot, before[0] ?? '', 'payload', '1c-rules', 'content', 'rules', '1c.md'))).toBe(true)

    writeFileSync(join(seeded.catalogDir, 'manifest.json'), manifestFile([payloadItem, mcpItem]))
    await expect(seedShippedCatalog(seeded.options)).resolves.toEqual({ outcome: 'applied' })
    const after = readdirSync(stageRoot)
    expect(after).toHaveLength(1)
    expect(after[0]).not.toBe(before[0])
  })

  it('records what it did in the product log', async () => {
    const seeded = fixture({ 'manifest.json': manifestFile([payloadItem]), 'payload/1c-rules/content/rules/1c.md': '# правила\n' })
    await expect(seedShippedCatalog(seeded.options)).resolves.toEqual({ outcome: 'applied' })
    const log = readFileSync(join(seeded.options.homeDir, 'logs', 'catalog-seed.log'), 'utf8')
    expect(log).toContain('[catalog] staged')
    expect(log).toContain('[catalog] applied')
  })

  it('leaves the marker unwritten when the catalog it names is incomplete', async () => {
    const seeded = fixture({ 'manifest.json': manifestFile([{ kind: 'plugin', id: '@vendor/plugin', file: 'plugins/plugin-1.0.0.tgz' }]) })
    const result = await seedShippedCatalog(seeded.options)
    expect(result.outcome).toBe('partial')
    expect(result.detail).toContain('plugin-1.0.0.tgz')
    expect(existsSync(join(seeded.options.profileDir, CATALOG_MARKER_NAME))).toBe(false)
    expect(seeded.written.some(message => message.includes('[catalog] seeding failed'))).toBe(true)
  })
})
