/**
 * KnowledgeScanner 单测：项目层/全局层扫描、排除规则、幂等、分类归属、
 * Windows 路径兼容（正斜杠规范化 + YAML 无损往返）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EntryStore, parseEntry, serializeEntry } from '../src/shared/index.js'
import { KnowledgeScanner, globToRegExp, isProjectExcluded, toPosix } from '../src/scan'

describe('toPosix（Windows 路径规范化）', () => {
  it('反斜杠统一转正斜杠', async () => {
    expect(toPosix('C:\\Users\\demo\\proj')).toBe('C:/Users/demo/proj')
    expect(toPosix('C:/Users/demo/proj')).toBe('C:/Users/demo/proj')
  })

  it('正斜杠路径 YAML 序列化往返无损（幂等键稳定的前提）', async () => {
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
  it('* 匹配单段、** 匹配跨段、**/ 匹配零目录', async () => {
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
  it('排除 .git/node_modules/.dsh/.env/锁文件', async () => {
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

  it('按分类表生成条目：语义分类映射到合法 category、原样进 tags', async () => {
    const result = await scanner.scanProject(workspace)
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

  it('幂等：重复扫描不产生重复条目', async () => {
    const first = await scanner.scanProject(workspace)
    const second = await scanner.scanProject(workspace)
    expect(first.generated).toBeGreaterThan(0)
    expect(second.generated).toBe(0)
    expect(second.skipped).toBe(first.generated)
    expect(store.list(workspace).length).toBe(first.generated)
  })

  it('V1.5 分类子目录落盘：条目在 <分类>/ 子目录，递归 list 可见且幂等', async () => {
    const first = await scanner.scanProject(workspace)
    expect(first.generated).toBe(4)
    // 每个条目落在 <ws>/.dsh/knowledge/<语义分类>/<id>.md
    for (const entry of first.entries) {
      const categoryDir = join(workspace, '.dsh', 'knowledge', entry.tags[0]!)
      expect(existsSync(join(categoryDir, `${entry.id}.md`))).toBe(true)
    }
    // 递归 list 能看到子目录条目（数量一致）
    expect(store.list(workspace).length).toBe(4)
    // 平铺旧布局条目仍可被递归 list 读到（兼容）
    const legacyDir = join(workspace, '.dsh', 'knowledge')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'kb-20260101-001.md'), [
      '---',
      'id: kb-20260101-001',
      'scope: project',
      'category: fact',
      'title: 旧条目',
      'created: 2026-01-01',
      'last_used: 2026-01-01',
      'hit_count: 0',
      'confidence: 0.5',
      'status: raw',
      '---',
      '',
      '旧平铺条目正文',
      '',
    ].join('\n'))
    expect(store.list(workspace).length).toBe(5)
    // 幂等：再扫描仍不重复（旧条目无 source，不影响新条目幂等）
    const again = await scanner.scanProject(workspace)
    expect(again.generated).toBe(0)
  })

  it('V1.5 容量上限：超限停止，高优先级分类先处理', async () => {
    // 大文件撑爆小预算：只允许 ~120 字符
    writeFileSync(join(workspace, 'docs', 'architecture.md'), '# 架构\n\n' + 'x'.repeat(300))
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'big', scripts: { a: '1' }, dependencies: { b: '2' } }))
    const result = await scanner.scanProject(workspace, undefined, undefined, 150)
    // 预算只够处理最前面的文件（architecture 优先级最高，README 先于其他）
    expect(result.entries.length).toBeGreaterThan(0)
    expect(result.entries.length).toBeLessThan(4)
    // 先处理的必须是高优先级分类
    expect(result.entries[0]!.tags[0]).toBe('architecture')
  })

  it('V1.5 分类过滤：只扫描指定分类', async () => {
    const result = await scanner.scanProject(workspace, undefined, ['deployment'])
    expect(result.entries.length).toBe(1)
    expect(result.entries[0]!.tags[0]).toBe('deployment')
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

  it('扫描 settings.yaml 与 profiles 插件清单，跳过缺失源', async () => {
    const result = await scanner.scanGlobal()
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

  it('幂等：重复扫描跳过已生成条目', async () => {
    const first = await scanner.scanGlobal()
    const second = await scanner.scanGlobal()
    expect(second.generated).toBe(0)
    expect(second.skipped).toBe(first.generated + first.skipped)
  })

  it('健壮性：全源缺失/部分缺失时不抛错、优雅跳过', async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'kb-empty-'))
    try {
      const emptyStore = new EntryStore({ dshHome: emptyHome })
      const emptyScanner = new KnowledgeScanner(emptyStore, emptyHome)
      // 空 DSH home：settings.yaml / profiles 均不存在；os-release/bashrc 按平台
      // 存在与否决定——缺失源一律静默跳过，绝不抛错（scanned 随环境变化，只验一致性）
      const result = await emptyScanner.scanGlobal()
      expect(result.generated).toBe(result.entries.length)
      for (const entry of result.entries) expect(entry.scope).toBe('global')
      // 不存在的 dshHome（目录级缺失）同样不抛错
      const missingStore = new EntryStore({ dshHome: join(emptyHome, 'nested', 'no-such-dir') })
      const missingScanner = new KnowledgeScanner(missingStore, join(emptyHome, 'nested', 'no-such-dir'))
      await expect(missingScanner.scanGlobal()).resolves.toBeDefined()
      // 项目层扫描指向不存在的 workspace 也不抛错
      await expect(missingScanner.scanProject(join(emptyHome, 'no-ws'))).resolves.toBeDefined()
    } finally {
      rmSync(emptyHome, { recursive: true, force: true })
    }
  })
})

describe('KnowledgeScanner LLM 模式（V2）', () => {
  let dshHome: string
  let workspace: string
  let store: EntryStore
  let scanner: KnowledgeScanner

  beforeEach(() => {
    dshHome = mkdtempSync(join(tmpdir(), 'kb-llm-home-'))
    workspace = mkdtempSync(join(tmpdir(), 'kb-llm-ws-'))
    mkdirSync(join(workspace, 'docs'), { recursive: true })
    writeFileSync(join(workspace, 'README.md'), '# 项目\n\n使用 pnpm monorepo。')
    store = new EntryStore({ dshHome })
    scanner = new KnowledgeScanner(store, dshHome)
  })

  afterEach(() => {
    rmSync(dshHome, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  it('LLM 模式生成 proposed 事实条目（分类子目录落盘、source 可溯）', async () => {
    const fakeLlm = async () => JSON.stringify({
      entries: [
        { title: '包管理', facts: ['使用 pnpm', 'monorepo 结构'], tags: ['tooling'] },
      ],
    })
    const result = await scanner.scanProject(workspace, undefined, undefined, undefined, fakeLlm)
    expect(result.entries.length).toBe(1)
    const entry = result.entries[0]!
    expect(entry.title).toBe('包管理')
    expect(entry.review).toBe('proposed')
    expect(entry.body).toContain('- 使用 pnpm')
    expect(entry.tags).toContain('architecture') // 语义分类进 tags 首位
    expect(entry.tags).toContain('tooling')
    expect(entry.source).toContain('README.md')
    expect(existsSync(join(workspace, '.dsh', 'knowledge', 'architecture', `${entry.id}.md`))).toBe(true)
  })

  it('LLM 模式幂等：同 title 合并 facts，不重复生成', async () => {
    const fakeLlm = async () => JSON.stringify({
      entries: [{ title: '包管理', facts: ['使用 pnpm'], tags: ['tooling'] }],
    })
    const first = await scanner.scanProject(workspace, undefined, undefined, undefined, fakeLlm)
    expect(first.generated).toBe(1)

    const fakeLlm2 = async () => JSON.stringify({
      entries: [{ title: '包管理', facts: ['使用 pnpm', 'monorepo 结构'], tags: ['tooling'] }],
    })
    const second = await scanner.scanProject(workspace, undefined, undefined, undefined, fakeLlm2)
    // 合并而非新建：generated 仍计 1（更新），库内只有 1 条
    expect(second.generated).toBe(1)
    expect(store.list(workspace).length).toBe(1)
    const merged = store.list(workspace)[0]!
    expect(merged.body).toContain('- 使用 pnpm')
    expect(merged.body).toContain('- monorepo 结构')
    expect(merged.review).toBe('proposed')
  })

  it('LLM 模式合并不覆盖 confirmed 状态', async () => {
    const fakeLlm = async () => JSON.stringify({
      entries: [{ title: '包管理', facts: ['使用 pnpm'], tags: ['tooling'] }],
    })
    await scanner.scanProject(workspace, undefined, undefined, undefined, fakeLlm)
    // 确认后再次扫描：合并保留 confirmed
    const entry = store.list(workspace)[0]!
    expect(store.updateReview(entry.id, 'confirmed', workspace)).toBe(true)
    const fakeLlm2 = async () => JSON.stringify({
      entries: [{ title: '包管理', facts: ['使用 pnpm', '新事实'], tags: ['tooling'] }],
    })
    await scanner.scanProject(workspace, undefined, undefined, undefined, fakeLlm2)
    const after = store.list(workspace)[0]!
    expect(after.review).toBe('confirmed')
    expect(after.body).toContain('- 新事实')
  })

  it('LLM 调用失败静默跳过（批次容错），不影响其他文件', async () => {
    const fakeLlm = async () => { throw new Error('LLM 超时') }
    const result = await scanner.scanProject(workspace, undefined, undefined, undefined, fakeLlm)
    expect(result.generated).toBe(0)
    expect(result.scanned).toBe(1)
    expect(store.list(workspace).length).toBe(0)
  })
})
