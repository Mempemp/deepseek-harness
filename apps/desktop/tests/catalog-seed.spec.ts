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
function fixture(
  files: Readonly<Record<string, string>>,
  options: { readonly legacyMcpStore?: boolean; readonly pnpmStub?: boolean } = {},
): {
  options: CatalogSeedOptions
  catalogDir: string
  profileDir: string
  pnpmLog: string
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
  const pnpmLog = join(profileDir, 'pnpm.log')
  // The seeding only talks to the package manager through a child process, so a stub script that
  // records its calls and edits node_modules is what lets a test see install and removal.
  const pnpm = join(root, 'pnpm.mjs')
  if (options.pnpmStub === true) {
    writeFileSync(pnpm, [
      "import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'",
      "import { basename, join } from 'node:path'",
      'const [, , action, ...rest] = process.argv',
      "const specs = rest.filter(argument => !argument.startsWith('--'))",
      "appendFileSync(join(process.cwd(), 'pnpm.log'), action + ' ' + specs.join(' ') + '\\n')",
      'for (const spec of specs) {',
      "  const name = spec.endsWith('.tgz') ? basename(spec).replace(/-\\d+\\.\\d+\\.\\d+.*$/, '') : spec",
      "  const dir = join(process.cwd(), 'node_modules', ...name.split('/'))",
      "  if (action === 'remove') { rmSync(dir, { recursive: true, force: true }); continue }",
      '  mkdirSync(dir, { recursive: true })',
      "  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))",
      '}',
      '',
    ].join('\n'))
  }
  return {
    catalogDir, profileDir, pnpmLog, written,
    options: {
      catalogDir, profileDir, homeDir,
      node: process.execPath, pnpm, nodeBin: root,
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

  it('unpacks a tool tree into the Harness home under its id', async () => {
    const files = {
      'manifest.json': manifestFile([{ kind: 'tool', id: 'git', version: '2.56.0.3', path: 'tools/git' }]),
      'tools/git/cmd/git.exe': 'MZ',
    }
    const seeded = fixture(files)
    await expect(seedShippedCatalog(seeded.options)).resolves.toEqual({ outcome: 'applied' })
    // The 1C editor looks for `<DSH_HOME>/git/cmd/git.exe` when nothing else provides git.
    expect(readFileSync(join(seeded.options.homeDir, 'git', 'cmd', 'git.exe'), 'utf8')).toBe('MZ')
  })

  it('keeps installing content trees when one of them fails', async () => {
    // The tool tree is absent from the catalog on purpose: a broken runtime must not cost the
    // payload and the MCP row, and the attempt has to say which item failed.
    const files = {
      'manifest.json': manifestFile([{ kind: 'tool', id: 'git', version: '2.56.0.3', path: 'tools/git' }, payloadItem, mcpItem]),
      'payload/1c-rules/content/rules/1c.md': '# правила\n',
    }
    const seeded = fixture(files)
    const result = await seedShippedCatalog(seeded.options)
    expect(result.outcome).toBe('partial')
    expect(result.detail).toContain('tool git')
    expect(existsSync(join(seeded.options.homeDir, PAYLOAD_HOME_DIR, 'content', 'rules', '1c.md'))).toBe(true)
    const store = JSON.parse(readFileSync(join(seeded.options.homeDir, MCP_MANAGER_DIR, MCP_MANAGER_STORE), 'utf8')) as { servers: { name: string }[] }
    expect(store.servers.some(server => server.name === 'v8std')).toBe(true)
    expect(existsSync(join(seeded.options.profileDir, CATALOG_MARKER_NAME))).toBe(false)
    expect(seeded.written.some(message => message.includes('tool git failed'))).toBe(true)
  })

  it('reports a python tool it cannot install without the bundled uv', async () => {
    // python-инструмент ставит комплектный uv; без него раскатка обязана назвать элемент, а не
    // промолчать, иначе на машине просто не появится rlm-bsl-index без следов в логе.
    const files = {
      'manifest.json': manifestFile([{ kind: 'python', id: 'rlm-tools-bsl', spec: 'rlm-tools-bsl', version: '1.46.0', bin: 'rlm-bsl-index' }]),
    }
    const seeded = fixture(files)
    const result = await seedShippedCatalog(seeded.options)
    expect(result.outcome).toBe('partial')
    expect(result.detail).toContain('python rlm-tools-bsl')
    expect(result.detail).toContain('uv')
    expect(seeded.written.some(message => message.includes('python rlm-tools-bsl failed'))).toBe(true)
  })

  it('retires a plugin the flavor dropped even when the profile has no catalog record', async () => {
    // Обновление с любой прошлой сборки: маркера catalogPackages ещё нет, поэтому ушедший
    // плагин называется в самом каталоге.
    const seeded = fixture({
      'manifest.json': `${JSON.stringify({
        id: 'dsh-1c', version: '0.2.1', retired: ['dsh-rlm-tools-bsl'],
        items: [{ kind: 'plugin', id: 'dsh-1c-project-properties', version: '0.9.2', file: 'plugins/dsh-1c-project-properties-0.9.2.tgz' }],
      }, undefined, 2)}\n`,
      'plugins/dsh-1c-project-properties-0.9.2.tgz': 'tar',
    }, { pnpmStub: true })
    writeFileSync(join(seeded.profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-rlm-tools-bsl'] } },
    }, undefined, 2))
    mkdirSync(join(seeded.profileDir, 'node_modules', 'dsh-rlm-tools-bsl'), { recursive: true })
    writeFileSync(join(seeded.profileDir, 'node_modules', 'dsh-rlm-tools-bsl', 'package.json'), JSON.stringify({ name: 'dsh-rlm-tools-bsl', dsh: { bundle: {} } }))

    await expect(seedShippedCatalog(seeded.options)).resolves.toEqual({ outcome: 'applied' })
    const manifest = JSON.parse(readFileSync(join(seeded.profileDir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-1c-project-properties'])
    expect(readFileSync(seeded.pnpmLog, 'utf8')).toContain('remove dsh-rlm-tools-bsl')
  })

  it('uninstalls a plugin the new catalog no longer ships and drops its bundle row', async () => {
    // Реальный случай: движок rlm переехал из отдельного плагина внутрь «Параметров проектов».
    // Старый пакет остался в профиле, оба плагина владеют /rlm/*, второй apply падает — и вместе
    // с ним пропадают все маршруты, которые он собирался зарегистрировать (/1cprops/state).
    const first = fixture({
      'manifest.json': manifestFile([{ kind: 'plugin', id: 'dsh-rlm-tools-bsl', version: '0.1.10', file: 'plugins/dsh-rlm-tools-bsl-0.1.10.tgz' }]),
      'plugins/dsh-rlm-tools-bsl-0.1.10.tgz': 'tar',
    }, { pnpmStub: true })
    await expect(seedShippedCatalog(first.options)).resolves.toEqual({ outcome: 'applied' })
    expect(existsSync(join(first.profileDir, 'node_modules', 'dsh-rlm-tools-bsl', 'package.json'))).toBe(true)

    const second = fixture({
      'manifest.json': manifestFile([{ kind: 'plugin', id: 'dsh-1c-project-properties', version: '0.9.2', file: 'plugins/dsh-1c-project-properties-0.9.2.tgz' }]),
      'plugins/dsh-1c-project-properties-0.9.2.tgz': 'tar',
    }, { pnpmStub: true })
    writeFileSync(join(second.profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-rlm-tools-bsl'], catalogPackages: ['dsh-rlm-tools-bsl'] } },
    }, undefined, 2))
    mkdirSync(join(second.profileDir, 'node_modules', 'dsh-rlm-tools-bsl'), { recursive: true })
    writeFileSync(join(second.profileDir, 'node_modules', 'dsh-rlm-tools-bsl', 'package.json'), JSON.stringify({ name: 'dsh-rlm-tools-bsl', dsh: { bundle: {} } }))

    await expect(seedShippedCatalog(second.options)).resolves.toEqual({ outcome: 'applied' })
    const manifest = JSON.parse(readFileSync(join(second.profileDir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[]; catalogPackages: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-1c-project-properties'])
    expect(manifest.dsh.profile.catalogPackages).toEqual(['dsh-1c-project-properties'])
    expect(readFileSync(second.pnpmLog, 'utf8')).toContain('remove dsh-rlm-tools-bsl')
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
