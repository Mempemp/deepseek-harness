/** First-run legacy migration: what it decides, what it copies, and what it leaves alone. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import {
  LEGACY_CONTENT_DIRS,
  LEGACY_MIGRATION_MARKER,
  LEGACY_MCP_STORE,
  legacyMigrationMarked,
  migrateLegacyHome,
  type LegacyMigrationOptions,
} from '../src/legacy-migration.ts'

/** One throwaway predecessor home and target home per case. */
function fixture(legacyFiles: Readonly<Record<string, string>> = {}, homeFiles: Readonly<Record<string, string>> = {}): {
  options: LegacyMigrationOptions
  legacyDir: string
  homeDir: string
  written: string[]
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-legacy-'))
  const legacyDir = join(root, 'appdata', 'dsh-desktop', 'harness')
  const homeDir = join(root, 'home')
  for (const [relative, contents] of Object.entries(legacyFiles)) {
    const path = join(legacyDir, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }
  for (const [relative, contents] of Object.entries(homeFiles)) {
    const path = join(homeDir, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }
  const written: string[] = []
  return { legacyDir, homeDir, written, options: { legacyDir, homeDir, note: message => written.push(message) } }
}

describe('legacy home migration', () => {
  it('reports no predecessor when its home is absent', async () => {
    const f = fixture()
    expect((await migrateLegacyHome(f.options)).outcome).toBe('absent')
    expect(legacyMigrationMarked(f.homeDir)).toBe(false)
  })

  it('skips when the home already records a migration of the current schema', async () => {
    const f = fixture(
      { 'sessions/project-a/s1/session.v4.jsonl.zstd': 'session' },
      { [LEGACY_MIGRATION_MARKER]: '{"version":4,"legacyDir":"x","modelSettings":true}\n' },
    )
    expect((await migrateLegacyHome(f.options)).outcome).toBe('skipped')
  })

  it('repairs a home migrated by schema 1: adopts the predecessor credentials', async () => {
    const f = fixture(
      {
        '.credentials.yaml': "version: 1\nrecords:\n  grant:\n    kind: grant\nrefs:\n  DEEPSEEK_API_KEY: 'sk-predecessor'\n",
      },
      {
        [LEGACY_MIGRATION_MARKER]: '{"legacyDir":"x"}\n',
        '.credentials.yaml': 'version: 1\nrecords:\n  grant:\n    kind: grant\n',
      },
    )
    const result = await migrateLegacyHome(f.options)
    expect(result.outcome).toBe('applied')
    expect(readFileSync(join(f.homeDir, '.credentials.yaml'), 'utf8')).toContain('DEEPSEEK_API_KEY')
    expect(existsSync(join(f.homeDir, '.credentials.yaml.before-legacy-migration'))).toBe(true)
    expect(JSON.parse(readFileSync(join(f.homeDir, LEGACY_MIGRATION_MARKER), 'utf8')).version).toBe(4)
  })

  it('keeps home credentials that already hold every predecessor key', async () => {
    const text = "version: 1\nrecords:\n  grant:\n    kind: grant\nrefs:\n  DEEPSEEK_API_KEY: 'sk-home'\n"
    const f = fixture({ '.credentials.yaml': text }, { '.credentials.yaml': text })
    await migrateLegacyHome(f.options)
    expect(readFileSync(join(f.homeDir, '.credentials.yaml'), 'utf8')).toBe(text)
    expect(existsSync(join(f.homeDir, '.credentials.yaml.before-legacy-migration'))).toBe(false)
  })

  it('merges workspace membership left behind by a stale registry', async () => {
    const legacy = JSON.stringify({
      global: { initialized: true, workspaceIds: ['w1', 'w2'], archivedSessionIds: ['s9'] },
      tables: { workspaces: {
        w1: { path: 'D:\\work\\a', title: 'a', sessionIds: ['s1', 's2'] },
        w2: { path: 'D:\\work\\b', title: 'b', sessionIds: ['s3'] },
      } },
    })
    const home = JSON.stringify({
      global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [] },
      tables: { workspaces: { w1: { path: 'D:/work/a/', title: 'a', sessionIds: ['s1'] } } },
    })
    const f = fixture(
      { 'storages/workspace.json': legacy },
      { [LEGACY_MIGRATION_MARKER]: '{"legacyDir":"x"}\n', 'storages/workspace.json': home },
    )
    await migrateLegacyHome(f.options)
    const merged = JSON.parse(readFileSync(join(f.homeDir, 'storages', 'workspace.json'), 'utf8'))
    expect(merged.tables.workspaces.w1.sessionIds).toEqual(['s1', 's2'])
    expect(merged.tables.workspaces.w2.sessionIds).toEqual(['s3'])
    expect(merged.global.archivedSessionIds).toEqual(['s9'])
  })

  it('carries user content into the home and writes the marker', async () => {
    const f = fixture({
      'sessions/project-a/s1/session.v4.jsonl.zstd': 'session',
      'storages/workspace.json': '{}',
      '1c-project-properties/map.json': '{}',
      'dsh-mcp.json': '{"servers":[]}',
    })
    const result = await migrateLegacyHome(f.options)
    expect(result.outcome).toBe('applied')
    expect(existsSync(join(f.homeDir, 'sessions', 'project-a', 's1', 'session.v4.jsonl.zstd'))).toBe(true)
    expect(existsSync(join(f.homeDir, 'storages', 'workspace.json'))).toBe(true)
    expect(existsSync(join(f.homeDir, '1c-project-properties', 'map.json'))).toBe(true)
    expect(existsSync(join(f.homeDir, LEGACY_MCP_STORE))).toBe(true)
    expect(legacyMigrationMarked(f.homeDir)).toBe(true)
  })

  it('never overwrites files the home already has', async () => {
    const f = fixture(
      { 'sessions/project-a/s1/session.v4.jsonl.zstd': 'old' },
      { 'sessions/project-a/s1/session.v4.jsonl.zstd': 'new' },
    )
    await migrateLegacyHome(f.options)
    expect(readFileSync(join(f.homeDir, 'sessions', 'project-a', 's1', 'session.v4.jsonl.zstd'), 'utf8')).toBe('new')
  })

  it('leaves the marker unwritten when a copy fails', async () => {
    const f = fixture({ 'sessions/s1': 'content' }, { 'sessions': 'not a directory' })
    const result = await migrateLegacyHome(f.options)
    expect(result.outcome).toBe('partial')
    expect(legacyMigrationMarked(f.homeDir)).toBe(false)
  })

  it('migrates only the declared content directories', async () => {
    const f = fixture({ 'settings.yaml': 'stale', 'unexpected-dir/x': 'y' })
    await migrateLegacyHome(f.options)
    expect(existsSync(join(f.homeDir, 'settings.yaml'))).toBe(false)
    expect(existsSync(join(f.homeDir, 'unexpected-dir'))).toBe(false)
    expect(LEGACY_CONTENT_DIRS).toContain('sessions')
  })

  it('carries the MCP manager store and merges it into the one the home already has', async () => {
    const store = (servers: string[]): string => JSON.stringify({ version: 1, servers: servers.map(name => ({ name, transport: 'streamable-http', enabled: true })) })
    const fresh = fixture({ '@wingsky-1/dsh-mcp-manager/mcp.json': store(['rlm', 'v8std']) })
    await migrateLegacyHome(fresh.options)
    const carried = JSON.parse(readFileSync(join(fresh.homeDir, '@wingsky-1/dsh-mcp-manager/mcp.json'), 'utf8')) as { servers: { name: string }[] }
    expect(carried.servers.map(server => server.name)).toEqual(['rlm', 'v8std'])

    const merge = fixture(
      { '@wingsky-1/dsh-mcp-manager/mcp.json': store(['rlm', 'v8std']) },
      { '@wingsky-1/dsh-mcp-manager/mcp.json': store(['v8std', '1c-docs']) },
    )
    await migrateLegacyHome(merge.options)
    const merged = JSON.parse(readFileSync(join(merge.homeDir, '@wingsky-1/dsh-mcp-manager/mcp.json'), 'utf8')) as { servers: { name: string }[] }
    expect(merged.servers.map(server => server.name)).toEqual(['v8std', '1c-docs', 'rlm'])
  })

  it('merges the model and provider choices into the profile patch without dropping the home entries', async () => {
    const legacyPatch = [
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: deepseek-official',
      '    model: deepseek-flash',
      '- id: llm-deepseek',
      '  name: "@deepseek-ai/dsh-llm-deepseek-api-key"',
      '  config:',
      '    models:',
      '      - id: deepseek-flash',
      '        name: DeepSeek-V41-Flash',
      '',
    ].join('\n')
    const homePatch = [
      '# Your patch layer for this dsh profile, applied after every bundle layer.',
      '- id: ui-theme',
      '  name: "@deepseek-ai/dsh-client-ui-theme"',
      '  config:',
      '    preference: dark',
      '- id: llm-deepseek',
      '  name: "@deepseek-ai/dsh-llm-deepseek-api-key"',
      '  config:',
      '    models:',
      '      - id: deepseek-v4-pro',
      '        name: DeepSeek-V4-Pro',
      '',
    ].join('\n')
    const f = fixture(
      { 'profiles/web/cordis.patch.yml': legacyPatch },
      { 'profiles/desktop/cordis.patch.yml': homePatch },
    )
    await migrateLegacyHome(f.options)

    const patchPath = join(f.homeDir, 'profiles', 'desktop', 'cordis.patch.yml')
    const text = readFileSync(patchPath, 'utf8')
    const entries = load(text) as { id: string; config: { preference?: string; provider?: string; models?: { id: string }[] } }[]
    expect(entries.map(entry => entry.id)).toEqual(['ui-theme', 'llm-deepseek', 'agent-default-model'])
    expect(entries[0]?.config.preference).toBe('dark')
    expect(entries[1]?.config.models?.map(model => model.id)).toEqual(['deepseek-v4-pro', 'deepseek-flash'])
    expect(entries[2]?.config.provider).toBe('deepseek-official')
    expect(text.startsWith('# Your patch layer')).toBe(true)
    // The home keeps a copy of what it had before the merge.
    expect(readFileSync(`${patchPath}.before-legacy-migration`, 'utf8')).toBe(homePatch)
  })

  it('retries the model step on the next launch when the host has not created the profile yet', async () => {
    const legacyPatch = '- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: deepseek-official\n'
    const f = fixture({ 'profiles/web/cordis.patch.yml': legacyPatch })
    await migrateLegacyHome(f.options)
    expect(existsSync(join(f.homeDir, 'profiles', 'desktop', 'cordis.patch.yml'))).toBe(false)
    expect(JSON.parse(readFileSync(join(f.homeDir, LEGACY_MIGRATION_MARKER), 'utf8')).modelSettings).toBe(false)

    mkdirSync(join(f.homeDir, 'profiles', 'desktop'), { recursive: true })
    writeFileSync(join(f.homeDir, 'profiles', 'desktop', 'cordis.patch.yml'), '- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n')
    expect((await migrateLegacyHome(f.options)).outcome).toBe('applied')
    expect(readFileSync(join(f.homeDir, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')).toContain('agent-default-model')
    expect(JSON.parse(readFileSync(join(f.homeDir, LEGACY_MIGRATION_MARKER), 'utf8')).modelSettings).toBe(true)
  })

  it('deletes nothing: every file the home already had is left byte for byte', async () => {
    const before = {
      '.credentials.yaml': 'version: 1\nrecords:\n  grant:\n    kind: grant\n',
      'storages/workspace.json': '{"tables":{"workspaces":{"keep":{"path":"C:\\\\work","sessionIds":["session-1"]}}}}',
      'profiles/desktop/cordis.patch.yml': '# header\n- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n',
      'notes/mine.txt': 'mine',
    }
    const f = fixture(
      {
        '.credentials.yaml': "version: 1\nrecords:\n  grant:\n    kind: grant\nrefs:\n  DEEPSEEK_API_KEY: '«redacted:sk-…»'\n",
        'storages/workspace.json': '{"tables":{"workspaces":{"other":{"path":"C:\\\\other","sessionIds":["session-2"]}}}}',
        'profiles/web/cordis.patch.yml': '- id: llm-deepseek\n  name: "@deepseek-ai/dsh-llm-deepseek-api-key"\n  config:\n    models:\n      - id: deepseek-flash\n',
        'sessions/project-a/s1/session.v4.jsonl.zstd': 'session',
      },
      before,
    )
    await migrateLegacyHome(f.options)
    // The registry and the patch are rewritten in place, so they are compared through their backups.
    expect(readFileSync(join(f.homeDir, 'notes', 'mine.txt'), 'utf8')).toBe('mine')
    expect(readFileSync(join(f.homeDir, 'sessions', 'project-a', 's1', 'session.v4.jsonl.zstd'), 'utf8')).toBe('session')
    expect(readFileSync(join(f.homeDir, '.credentials.yaml'), 'utf8')).toContain('DEEPSEEK_API_KEY')
    expect(readFileSync(join(f.homeDir, '.credentials.yaml.before-legacy-migration'), 'utf8')).toBe(before['.credentials.yaml'])
    expect(readFileSync(join(f.homeDir, 'storages', 'workspace.json'), 'utf8')).toContain('session-1')
    expect(readFileSync(join(f.homeDir, 'storages', 'workspace.json'), 'utf8')).toContain('session-2')
    expect(readFileSync(join(f.homeDir, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')).toContain('ui-theme')
    expect(readFileSync(join(f.homeDir, 'profiles', 'desktop', 'cordis.patch.yml.before-legacy-migration'), 'utf8')).toBe(before['profiles/desktop/cordis.patch.yml'])
  })
})
