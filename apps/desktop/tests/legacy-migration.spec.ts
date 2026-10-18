/** First-run legacy migration: what it decides, what it copies, and what it leaves alone. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
    const f = fixture()
    mkdirSync(f.homeDir, { recursive: true })
    writeFileSync(join(f.homeDir, LEGACY_MIGRATION_MARKER), '{"version":2,"legacyDir":"x"}\n')
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
    expect(JSON.parse(readFileSync(join(f.homeDir, LEGACY_MIGRATION_MARKER), 'utf8')).version).toBe(2)
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
})
