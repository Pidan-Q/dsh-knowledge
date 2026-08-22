/**
 * errata 宿主端 Remote 服务测试（list / archive / unarchive / remove / promote）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ErrorLesson } from '@dsh-knowledge/shared'
import { LessonStore } from '../src/lessons'
import { ErrataRemoteService, type ErrataPromoteGateway } from '../src/remote'

function makeLesson(workspace: string, overrides: Partial<ErrorLesson> = {}): ErrorLesson {
  return {
    id: 'kb-20260821-001',
    scope: 'project',
    workspace,
    category: 'lesson',
    tags: ['lessons'],
    title: '工具 edit 失败教训',
    body: '工具 edit 在相同参数模式下失败。',
    created: '2026-08-21',
    lastUsed: '2026-08-21',
    hitCount: 1,
    confidence: 0.3,
    source: 'trajectory:evt_1',
    status: 'raw',
    tool: 'edit',
    argsHashPrefix: 'a1b2',
    errorType: 'FS_NOT_OBSERVED',
    errorCount: 1,
    ...overrides,
  }
}

describe('ErrataRemoteService', () => {
  let dshHome: string
  let workspace: string
  let ctx: Context
  let lessons: LessonStore
  let service: ErrataRemoteService

  beforeEach(() => {
    dshHome = mkdtempSync(join(tmpdir(), 'errata-home-'))
    workspace = mkdtempSync(join(tmpdir(), 'errata-ws-'))
    ctx = new Context()
    lessons = new LessonStore({ dshHome, workspace })
    service = new ErrataRemoteService(ctx, { lessons })
  })

  afterEach(() => {
    rmSync(dshHome, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  it('list 返回条目;归档后进入 archived 分组', async () => {
    lessons.store.write(makeLesson(workspace), workspace)
    const { lessons: listed } = await service.list(workspace)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.status).toBe('raw')

    await service.archive('kb-20260821-001', workspace)
    const after = await service.list(workspace)
    expect(after.lessons[0]?.status).toBe('archived')
    expect(after.lessons[0]?.archivedFrom).toBe('raw')
  })

  it('archive 不存在的条目抛错（折叠为 RemoteFailure）', async () => {
    expect(() => service.archive('kb-99999999-999', workspace)).toThrow('未找到')
  })

  it('unarchive 恢复原状态', async () => {
    lessons.store.write(makeLesson(workspace, { status: 'distilled', errorCount: 5 }), workspace)
    await service.archive('kb-20260821-001', workspace)
    const { lesson } = await service.unarchive('kb-20260821-001', workspace)
    expect(lesson.status).toBe('distilled')
  })

  it('delete 删除条目', async () => {
    lessons.store.write(makeLesson(workspace), workspace)
    const { removed } = await service.delete('kb-20260821-001', workspace)
    expect(removed).toBe(true)
    expect(() => service.delete('kb-20260821-001', workspace)).toThrow('未找到')
  })

  it('promote 需要 lesson-promote 网关;未启用时拒绝', async () => {
    lessons.store.write(makeLesson(workspace, { status: 'distilled', errorCount: 5 }), workspace)
    await expect(service.promote('kb-20260821-001', workspace)).rejects.toThrow('lesson-promote 插件未启用')
  })

  it('promote 只接受 distilled 条目', async () => {
    const gateway: ErrataPromoteGateway = {
      scanPromotable: () => [],
      draftSkill: (lesson) => ({ name: 'x', filePath: '/x' }),
      approve: async () => ({ ok: true, message: 'ok' }),
    }
    const svc = new ErrataRemoteService(new Context(), { lessons, promote: gateway })
    lessons.store.write(makeLesson(workspace), workspace)
    await expect(svc.promote('kb-20260821-001', workspace)).rejects.toThrow('仅已提炼')
  })

  it('promote 走草稿+批准链路并置 promoted', async () => {
    const calls: string[] = []
    const gateway: ErrataPromoteGateway = {
      scanPromotable: (ws) => lessons.listLessons(ws).filter((l) => l.status === 'distilled'),
      draftSkill: (lesson) => {
        calls.push(`draft:${lesson.id}`)
        return { name: 'fix-edit-error', filePath: `/drafts/fix-edit-error.md` }
      },
      approve: async (name) => {
        calls.push(`approve:${name}`)
        return { ok: true, message: 'ok', result: { file: `/skills/fix-edit-error/SKILL.md` } }
      },
    }
    const svc = new ErrataRemoteService(new Context(), { lessons, promote: gateway })
    lessons.store.write(makeLesson(workspace, { status: 'distilled', errorCount: 5 }), workspace)

    const result = await svc.promote('kb-20260821-001', workspace)
    expect(result.skillName).toBe('fix-edit-error')
    expect(result.file).toBe('/skills/fix-edit-error/SKILL.md')
    expect(calls).toEqual(['draft:kb-20260821-001', 'approve:fix-edit-error'])

    const after = await svc.list(workspace)
    expect(after.lessons[0]?.status).toBe('promoted')
    expect(after.lessons[0]?.relatedSkillId).toBe('fix-edit-error')
  })

  it('promote 批准失败时透传错误且不置位', async () => {
    const gateway: ErrataPromoteGateway = {
      scanPromotable: (ws) => lessons.listLessons(ws).filter((l) => l.status === 'distilled'),
      draftSkill: () => ({ name: 'fix-edit-error', filePath: '/drafts/x.md' }),
      approve: async () => ({ ok: false, message: '拒绝批准：平台已存在同名技能' }),
    }
    const svc = new ErrataRemoteService(new Context(), { lessons, promote: gateway })
    lessons.store.write(makeLesson(workspace, { status: 'distilled', errorCount: 5 }), workspace)
    await expect(svc.promote('kb-20260821-001', workspace)).rejects.toThrow('拒绝批准')
    const after = await svc.list(workspace)
    expect(after.lessons[0]?.status).toBe('distilled')
  })

  it('promote 拒绝未达 errorCount 阈值的 distilled 条目', async () => {
    const gateway: ErrataPromoteGateway = {
      scanPromotable: () => [], // 阈值未达 → 空集合
      draftSkill: () => ({ name: 'x', filePath: '/x' }),
      approve: async () => ({ ok: true, message: 'ok' }),
    }
    const svc = new ErrataRemoteService(new Context(), { lessons, promote: gateway })
    lessons.store.write(makeLesson(workspace, { status: 'distilled', errorCount: 2 }), workspace)
    await expect(svc.promote('kb-20260821-001', workspace)).rejects.toThrow('尚未达到晋级条件')
  })
})
