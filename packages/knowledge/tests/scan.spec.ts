/**
 * KnowledgeScanner 单测：项目层/全局层扫描、排除规则、幂等、分类归属、
 * Windows 路径兼容（正斜杠规范化 + YAML 无损往返）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EntryStore, parseEntry, serializeEntry } from '@dsh-plugins/shared'
import { KnowledgeScanner, globToRegExp, isProjectExcluded, toPosix } from '../src/scan'

describe('toPosix（Windows 路径规范化）', () => {
  it('反斜杠统一转正斜杠', () => {
    expect(toPosix('C:\\Users\\demo\\proj')).toBe('C:/Users/demo/proj')
    expect(toPosix('C:/Users/demo/proj')).toBe('C:/Users/demo/proj')
  })

  it('正斜杠路径 YAML 序列化往返无损（幂等键稳定的前提）', () => {
    const entry = {
      id: 'kb-20260822-001', scope: 'project' as const, workspace: 'C:/Users/demo/proj',
      category: 'fact' as const, tags: ['architecture', 'scanned'], title: 'docs/a.md', body: 'x',
      created: '2026-08-22', lastUsed: '2026-08-22', hitCount: 0, confidence: 0.6,
      source: 'C:/Users/demo/proj/docs/a.md', status: 'raw' as const,
    }
    const parsed = parseEntry(serializeEntry(entry))
    expect(parsed?.source).toBe(entry.source)
    expect(parsed?.workspace).toBe(entry.workspace)
    expect(parsed?.title).toBe(entry.title)
  })
})

describe('globToRegExp', () => {
  it('* 匹配单段、** 匹配跨段、**/ 匹配零目录', () => {
    expect(globToRegExp('docs/architecture*.md').test('docs/architecture.md')).toBe(true)
    expect(globToRegExp('docs/architecture*.md').test('docs/architecture-2026.md')).toBe(true)
    expect(globToRegExp('docs/architecture*.md').test('docs/architecture/a.md')).toBe(false)
    expect(globToRegExp('docs/adr/**/*.md').test('docs/adr/001-x.md')).toBe(true)
    expect(globToRegExp('docs/adr/**/*.md').test('docs/adr/sub/001-x.md')).toBe(true)
    expect(globToRegExp('docs/adr/**/*.md').test('docs/other/001-x.md')).toBe(false)
    expect(globToRegExp('config/**/*.yaml').test('config/app.yaml')).toBe(true)
    expect(globToRegExp('eslint.config.*').test('eslint.config.mjs')).toBe(true)
  })
})

describe('isProjectExcluded', () => {
  it('排除 .git/node_modules/.dsh/.env/锁文件', () => {
    expect(isProjectExcluded('.git/config')).toBe(true)
    expect(isProjectExcluded('node_modules/x/index.js')).toBe(true)
    expect(isProjectExcluded('proj/.dsh/knowledge/kb.md')).toBe(true)
    expect(isProjectExcluded('.env')).toBe(true)
    expect(isProjectExcluded('config/.env.prod')).toBe(true)
    expect(isProjectExcluded('pnpm-lock.yaml')).toBe(true)
    expect(isProjectExcluded('.env.example')).toBe(false)
    expect(isProjectExcluded('README.md')).toBe(false)
  })
})

describe('KnowledgeScanner.scanProject', () => {
  let dshHome: string
  let workspace: string
  let store: EntryStore
  let scanner: KnowledgeScanner

  beforeEach(() => {
    dshHome = mkdtempSync(join(tmpdir(), 'kb-scan-home-'))
    workspace = mkdtempSync(join(tmpdir(), 'kb-scan-ws-'))
    mkdirSync(join(workspace, 'docs', 'adr'), { recursive: true })
    mkdirSync(join(workspace, 'node_modules'), { recursive: true })
    writeFileSync(join(workspace, 'README.md'), '# 示例项目\n\n架构说明：pnpm monorepo。\n\n## 小节\n\n内容。')
    writeFileSync(join(workspace, 'docs', 'architecture.md'), '# 架构\n\n模块划分：A / B。')
    writeFileSync(join(workspace, 'docs', 'adr', '001-pnpm.md'), '# ADR-001：pnpm\n\n选型：pnpm。')
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({
      name: 'demo', description: 'demo pkg',
      scripts: { dev: 'vite' },
      dependencies: { react: '^18' },
    }))
    writeFileSync(join(workspace, '.env'), 'SECRET=xx')
    writeFileSync(join(workspace, 'node_modules', 'dep.js'), 'ignored')
    store = new EntryStore({ dshHome })
    scanner = new KnowledgeScanner(store, dshHome)
  })

  afterEach(() => {
    rmSync(dshHome, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  it('按分类表生成条目：语义分类映射到合法 category、原样进 tags', () => {
    const result = scanner.scanProject(workspace)
    expect(result.entries.length).toBe(4)
    const byTitle = new Map(result.entries.map((e) => [e.title, e]))
    // 语义分类：architecture/deployment；条目 category 映射为 fact/decision
    expect(byTitle.get('README.md')?.category).toBe('fact')
    expect(byTitle.get('README.md')?.tags[0]).toBe('architecture')
    expect(byTitle.get('docs/architecture.md')?.category).toBe('fact')
    expect(byTitle.get('docs/adr/001-pnpm.md')?.category).toBe('fact')
    expect(byTitle.get('docs/adr/001-pnpm.md')?.tags[0]).toBe('architecture')
    expect(byTitle.get('package.json')?.category).toBe('fact')
    expect(byTitle.get('package.json')?.tags[0]).toBe('deployment')
    for (const entry of result.entries) {
      expect(entry.scope).toBe('project')
      expect(entry.workspace).toBe(workspace)
      expect(entry.source).toContain(workspace)
      expect(entry.body.length).toBeGreaterThan(0)
      expect(entry.tags).toContain('scanned')
      expect(entry.status).toBe('raw')
      // Windows 兼容：source/workspace 不含反斜杠，YAML 往返无损（幂等键稳定）
      expect(entry.source).not.toContain('\\')
      expect(entry.workspace).not.toContain('\\')
      expect(parseEntry(serializeEntry(entry))?.source).toBe(entry.source)
    }
    // .env 与 node_modules 不产生条目
    expect([...byTitle.keys()].some((t) => t.includes('.env'))).toBe(false)
  })

  it('幂等：重复扫描不产生重复条目', () => {
    const first = scanner.scanProject(workspace)
    const second = scanner.scanProject(workspace)
    expect(first.generated).toBeGreaterThan(0)
    expect(second.generated).toBe(0)
    expect(second.skipped).toBe(first.generated)
    expect(store.list(workspace).length).toBe(first.generated)
  })
})

describe('KnowledgeScanner.scanGlobal', () => {
  let dshHome: string
  let store: EntryStore
  let scanner: KnowledgeScanner

  beforeEach(() => {
    dshHome = mkdtempSync(join(tmpdir(), 'kb-scan-global-'))
    const profiles = join(dshHome, 'profiles', 'web')
    mkdirSync(profiles, { recursive: true })
    writeFileSync(join(dshHome, 'settings.yaml'), 'locale:\n  preference: zh\n')
    writeFileSync(join(profiles, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', dependencies: { 'dsh-at-file': '^0.6.3', 'dsh-context': '^0.19.2' },
    }))
    store = new EntryStore({ dshHome })
    scanner = new KnowledgeScanner(store, dshHome)
  })

  afterEach(() => {
    rmSync(dshHome, { recursive: true, force: true })
  })

  it('扫描 settings.yaml 与 profiles 插件清单，跳过缺失源', () => {
    const result = scanner.scanGlobal()
    const byTitle = new Map(result.entries.map((e) => [e.title, e]))
    expect(byTitle.has('~/.dsh/settings.yaml') || [...byTitle.keys()].some((t) => t.endsWith('settings.yaml'))).toBe(true)
    const pkg = [...byTitle.entries()].find(([t]) => t.endsWith('profiles/web/package.json'))
    expect(pkg).toBeDefined()
    expect(pkg?.[1].category).toBe('fact')
    expect(pkg?.[1].tags[0]).toBe('environment')
    expect(pkg?.[1].body).toContain('dsh-context')
    for (const entry of result.entries) {
      expect(entry.scope).toBe('global')
      expect(entry.workspace).toBeUndefined()
      expect(entry.source).toBeDefined()
    }
  })

  it('幂等：重复扫描跳过已生成条目', () => {
    const first = scanner.scanGlobal()
    const second = scanner.scanGlobal()
    expect(second.generated).toBe(0)
    expect(second.skipped).toBe(first.generated + first.skipped)
  })

  it('健壮性：全源缺失（模拟 Windows 无 Linux 专属源）时不抛错、优雅跳过', () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'kb-empty-'))
    try {
      const emptyStore = new EntryStore({ dshHome: emptyHome })
      const emptyScanner = new KnowledgeScanner(emptyStore, emptyHome)
      // 空 DSH home：settings.yaml / profiles 均不存在；os-release/bashrc 由平台守卫跳过或缺失跳过
      expect(() => emptyScanner.scanGlobal()).not.toThrow()
      const result = emptyScanner.scanGlobal()
      expect(result.generated).toBe(0)
      expect(result.entries).toEqual([])
    } finally {
      rmSync(emptyHome, { recursive: true, force: true })
    }
  })
})
