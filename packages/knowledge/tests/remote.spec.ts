/**
 * knowledge 宿主端 Remote 服务测试（list / remember / forget + workspace 语义）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { EntryStore } from '@dsh-knowledge/shared'
import { KnowledgeRemoteService, type RememberInput } from '../src/remote'

describe('KnowledgeRemoteService', () => {
  let dshHome: string
  let workspace: string
  let ctx: Context
  let service: KnowledgeRemoteService

  beforeEach(() => {
    dshHome = mkdtempSync(join(tmpdir(), 'kb-home-'))
    workspace = mkdtempSync(join(tmpdir(), 'kb-ws-'))
    ctx = new Context()
    service = new KnowledgeRemoteService(ctx, { store: new EntryStore({ dshHome }), allowGlobalWrite: true })
  })

  afterEach(() => {
    rmSync(dshHome, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  it('remember 项目层写入需要 workspace;全局层无需', async () => {
    const project: RememberInput = { title: '项目约定', body: '使用 pnpm', scope: 'project' }
    const global: RememberInput = { title: '全局事实', body: 'DSH 是编码代理', scope: 'global' }

    expect(() => service.remember(project)).toThrow('workspace')
    const a = await service.remember(global)
    expect(a.id).toMatch(/^kb-\d{8}-\d{3,}$/)
    const b = await service.remember(project, workspace)
    expect(b.id).toMatch(/^kb-\d{8}-\d{3,}$/)
  })

  it('list 缺省只返回全局层;传 workspace 并入项目层', async () => {
    await service.remember({ title: 'G', body: 'global', scope: 'global' })
    await service.remember({ title: 'P', body: 'project', scope: 'project' }, workspace)

    const globalOnly = await service.list()
    expect(globalOnly.entries).toHaveLength(1)
    expect(globalOnly.entries[0]?.scope).toBe('global')

    const both = await service.list(workspace)
    expect(both.entries).toHaveLength(2)
  })

  it('allowGlobalWrite=false 时全局写入被拒绝', async () => {
    const ctx2 = new Context()
    const svc = new KnowledgeRemoteService(ctx2, { store: new EntryStore({ dshHome }), allowGlobalWrite: false })
    expect(() => svc.remember({ title: 'x', body: 'y', scope: 'global' })).toThrow('allowGlobalWrite')
    // 项目层写入不受影响
    const { id } = await svc.remember({ title: 'x', body: 'y', scope: 'project' }, workspace)
    expect(id).toMatch(/^kb-/)
  })

  it('forget 删除条目', async () => {
    const { id } = await service.remember({ title: 'P', body: 'project', scope: 'project' }, workspace)
    expect((await service.forget(id, workspace)).removed).toBe(true)
    expect((await service.list(workspace)).entries).toHaveLength(0)
    expect((await service.forget(id, workspace)).removed).toBe(false)
  })

  it('remember 校验 title/body 非空与未知分类', async () => {
    expect(() => service.remember({ title: '', body: 'y', scope: 'global' })).toThrow('title')
    expect(() => service.remember({ title: 'x', body: '', scope: 'global' })).toThrow('body')
    expect(() => service.remember({
      title: 'x',
      body: 'y',
      scope: 'global',
      category: 'nope' as never,
    })).toThrow('未知分类')
  })

  it('generate 项目层必须携带 workspace', async () => {
    expect(() => service.generate('project')).toThrow('workspace')
    expect(() => service.generate('nope' as never)).toThrow('未知范围')
  })

  it('generate 项目层按扫描范围生成 md 条目且幂等', async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    mkdirSync(join(workspace, 'docs'), { recursive: true })
    writeFileSync(join(workspace, 'README.md'), '# Demo\n\n架构说明。')
    writeFileSync(join(workspace, 'docs', 'architecture.md'), '# 架构\n\n模块划分。')

    const first = await service.generate('project', workspace)
    expect(first.generated).toBe(2)
    expect(first.scanned).toBe(2)
    for (const entry of first.entries) {
      expect(entry.scope).toBe('project')
      expect(entry.workspace).toBe(workspace)
      expect(entry.source).toContain(workspace)
    }
    // 已落盘为 frontmatter + Markdown 的 md 文件
    expect(existsSync(join(workspace, '.dsh', 'knowledge', `${first.entries[0]!.id}.md`))).toBe(true)

    const second = await service.generate('project', workspace)
    expect(second.generated).toBe(0)
    expect(second.skipped).toBe(2)
  })

  it('generate 全局层扫描 DSH home 配置（忽略 workspace）', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(dshHome, 'settings.yaml'), 'locale:\n  preference: zh\n')
    writeFileSync(join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'web', dependencies: { x: '1' } }))

    const result = await service.generate('global', workspace)
    expect(result.generated).toBeGreaterThanOrEqual(2)
    for (const entry of result.entries) {
      expect(entry.scope).toBe('global')
      expect(entry.workspace).toBeUndefined()
    }
    const again = await service.generate('global', workspace)
    expect(again.generated).toBe(0)
  })

  it('generate 自定义落盘目录 + list 按目录浏览', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const landing = mkdtempSync(join(tmpdir(), 'kb-landing-'))
    try {
      mkdirSync(join(workspace, 'docs'), { recursive: true })
      writeFileSync(join(workspace, 'README.md'), '# Demo\n\n架构说明。')

      // 项目层扫描落入自定义目录
      const project = await service.generate('project', workspace, landing)
      expect(project.generated).toBeGreaterThan(0)
      const listed = await service.list(undefined, landing)
      expect(listed.entries.length).toBe(project.generated)
      for (const entry of listed.entries) expect(entry.source).toContain('README.md')

      // 幂等：同一目标目录重复生成不重复写
      const again = await service.generate('project', workspace, landing)
      expect(again.generated).toBe(0)

      // 全局层扫描同样可落入自定义目录
      writeFileSync(join(dshHome, 'settings.yaml'), 'locale:\n  preference: zh\n')
      const global = await service.generate('global', undefined, landing)
      expect(global.generated).toBeGreaterThan(0)
      expect((await service.list(undefined, landing)).entries.length).toBe(project.generated + global.generated)
    } finally {
      rmSync(landing, { recursive: true, force: true })
    }
  })

  it('workspaces 返回扫描基目录下含 .git 或 .dsh/knowledge 的项目目录', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kb-root-'))
    try {
      mkdirSync(join(base, 'projA', '.git'), { recursive: true })
      mkdirSync(join(base, 'projB', '.dsh', 'knowledge'), { recursive: true })
      mkdirSync(join(base, 'notproj'), { recursive: true })

      const ctx2 = new Context()
      const svc = new KnowledgeRemoteService(ctx2, { store: new EntryStore({ dshHome }), projectScanRoot: base })
      const { workspaces } = await svc.workspaces()
      expect(workspaces).toContain(join(base, 'projA'))
      expect(workspaces).toContain(join(base, 'projB'))
      expect(workspaces.some((w) => w.includes('notproj'))).toBe(false)
      expect(workspaces).toEqual([...workspaces].sort())
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
