/**
 * errata LessonStore 改态/删除能力测试（归档、反悔、删除、晋级置位）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ErrorLesson } from '@dsh-knowledge/shared'
import { LessonStore } from '../src/lessons'

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

describe('LessonStore 改态与删除', () => {
  let dshHome: string
  let workspace: string
  let store: LessonStore

  beforeEach(() => {
    dshHome = mkdtempSync(join(tmpdir(), 'errata-home-'))
    workspace = mkdtempSync(join(tmpdir(), 'errata-ws-'))
    store = new LessonStore({ dshHome, workspace })
  })

  afterEach(() => {
    rmSync(dshHome, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  function seed(lesson: ErrorLesson): void {
    store.store.write(lesson, workspace)
  }

  it('archive 记录原状态,unarchive 恢复', () => {
    const lesson = makeLesson(workspace, { status: 'distilled', errorCount: 5 })
    seed(lesson)

    const archived = store.archive('kb-20260821-001', workspace)
    expect(archived).toBeDefined()
    expect(archived?.status).toBe('archived')
    expect(archived?.archivedFrom).toBe('distilled')

    const restored = store.unarchive('kb-20260821-001', workspace)
    expect(restored?.status).toBe('distilled')
    expect(restored?.archivedFrom).toBeUndefined()
  })

  it('unarchive 无原状态记录时按 errorCount 自动推导', () => {
    const lesson = makeLesson(workspace, { status: 'raw', errorCount: 1 })
    seed(lesson)
    store.archive('kb-20260821-001', workspace)
    // 无 archivedFrom 的场景：手工构造一条 archived 且无 archivedFrom 的条目
    const manual = makeLesson(workspace, { status: 'archived', errorCount: 1 })
    manual.archivedFrom = undefined
    seed(manual)

    const restored = store.unarchive('kb-20260821-001', workspace)
    expect(restored?.status).toBe('raw')

    // errorCount 达标 → distilled
    const distilledSeed = makeLesson(workspace, { id: 'kb-20260821-002', status: 'archived', errorCount: 5 })
    distilledSeed.archivedFrom = undefined
    seed(distilledSeed)
    const restored2 = store.unarchive('kb-20260821-002', workspace)
    expect(restored2?.status).toBe('distilled')
  })

  it('remove 永久删除条目', () => {
    const lesson = makeLesson(workspace)
    seed(lesson)
    expect(store.findLessonById('kb-20260821-001', workspace)).toBeDefined()
    expect(store.remove('kb-20260821-001', workspace)).toBe(true)
    expect(store.findLessonById('kb-20260821-001', workspace)).toBeUndefined()
    expect(store.remove('kb-20260821-001', workspace)).toBe(false)
  })

  it('markPromoted 置 promoted 并记录关联技能,清空 archivedFrom', () => {
    const lesson = makeLesson(workspace, { status: 'distilled', errorCount: 5 })
    seed(lesson)
    store.archive('kb-20260821-001', workspace)
    const updated = store.markPromoted('kb-20260821-001', 'fix-edit-error', workspace)
    expect(updated?.status).toBe('promoted')
    expect(updated?.relatedSkillId).toBe('fix-edit-error')
    expect(updated?.archivedFrom).toBeUndefined()
  })

  it('setStatus 对不存在的条目返回 undefined', () => {
    expect(store.setStatus('kb-99999999-999', 'archived', workspace)).toBeUndefined()
  })

  it('listLessons 只返回教训条目并携带 workspace 字段', () => {
    seed(makeLesson(workspace))
    const lessons = store.listLessons(workspace)
    expect(lessons).toHaveLength(1)
    expect(lessons[0]?.workspace).toBe(workspace)
  })
})
