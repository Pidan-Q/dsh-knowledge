/**
 * lesson-promote 错题本晋级流程测试（v3.0：更名 + 删除版本/回滚 + 同名冲突守卫）。
 *
 * 覆盖：草稿只写 .dsh/lesson-promote/drafts、approve 落盘 .dsh/skills/<name>/SKILL.md、
 * 重复 approve 拒绝、草稿人工编辑在批准时保留、
 * 同名冲突守卫（其他来源拒绝 / 自己部署层允许幂等重写）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ErrorLesson } from '@dsh-knowledge/shared'
import { draftSkill, readDraftDocument, readDraftRecord } from '../src/promote'
import { approveDraft, conflictCheckFor, type NameConflictCheck } from '../src/manage'
import type { LessonPromoteStore } from '../src/index'

/** 构造满足晋升条件的教训条目。 */
function makeLesson(workspace: string, overrides: Partial<ErrorLesson> = {}): ErrorLesson {
  return {
    id: 'kb-20260818-001',
    scope: 'project',
    workspace,
    category: 'lesson',
    tags: ['lessons'],
    title: '修复 bash 工具路径错误',
    body: '工具 bash 在相同参数模式下失败。',
    created: '2026-08-18',
    lastUsed: '2026-08-18',
    hitCount: 3,
    confidence: 0.6,
    source: 'trajectory:evt_1',
    status: 'distilled',
    tool: 'bash',
    argsHashPrefix: 'a1b2',
    errorType: 'EXIT_CODE_1',
    errorCount: 3,
    fix: '使用绝对路径',
    ...overrides,
  }
}

/** approve 只读 store.config，构造最小假 store。 */
function makeStore(workspace: string): LessonPromoteStore {
  return {
    config: {
      promoteAfterFailures: 3,
      autoApprove: false,
      draftsDir: '.dsh/lesson-promote/drafts',
    },
  } as unknown as LessonPromoteStore
}

/** 无冲突守卫（默认放行）。 */
const noConflict: NameConflictCheck = async () => undefined

describe('lesson-promote 晋升流程（v3.0）', () => {
  let workspace: string
  const draftsDir = '.dsh/lesson-promote/drafts'
  const draftDirAbs = (ws: string): string => join(ws, draftsDir)

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'lp-test-'))
  })
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('draftSkill 只写草稿文件，不落盘 .dsh/skills（草稿不是正式技能）', () => {
    const lesson = makeLesson(workspace)
    const { name, filePath } = draftSkill(lesson, workspace, draftsDir)
    expect(name).toBe('bash')
    expect(filePath).toBe(join(draftDirAbs(workspace), 'bash.md'))
    expect(existsSync(join(draftDirAbs(workspace), 'bash.md'))).toBe(true)
    // 关键断言：草稿阶段绝不写 .dsh/skills
    expect(existsSync(join(workspace, '.dsh', 'skills', 'bash', 'SKILL.md'))).toBe(false)
    const record = readDraftRecord(join(draftDirAbs(workspace), 'bash.md'))
    expect(record?.status).toBe('pending')
    expect(record?.lessonId).toBe('kb-20260818-001')
    // 草稿文件内嵌完整技能文档（记录字段 + 技能字段超集）
    const doc = readDraftDocument(filePath)
    expect(doc?.frontmatter.name).toBe('bash')
    expect(doc?.frontmatter.metadata?.errataRef).toBe('kb-20260818-001')
    expect(doc?.content).toContain('使用绝对路径')
  })

  it('approve 把草稿落盘为 .dsh/skills/<name>/SKILL.md 并标记批准（无版本快照）', async () => {
    const lesson = makeLesson(workspace)
    const { name } = draftSkill(lesson, workspace, draftsDir)
    const store = makeStore(workspace)
    const result = await approveDraft(store, workspace, name, noConflict)
    expect(result.ok).toBe(true)

    const skillFile = join(workspace, '.dsh', 'skills', name, 'SKILL.md')
    expect(existsSync(skillFile)).toBe(true)
    const text = readFileSync(skillFile, 'utf8')
    expect(text).toContain('name: bash')
    expect(text).toContain('## 修复方式')
    expect(text).toContain('使用绝对路径')
    // 正式 SKILL.md 不携带草稿记录字段
    expect(text).not.toContain('lesson_id')
    expect(text).not.toContain('created_at')

    const record = readDraftRecord(join(draftDirAbs(workspace), `${name}.md`))
    expect(record?.status).toBe('approved')
    expect(record?.approvedAt).toBeDefined()
  })

  it('approve 缺草稿时报错；重复 approve 被拒绝', async () => {
    const store = makeStore(workspace)
    const missing = await approveDraft(store, workspace, 'nope', noConflict)
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('未找到草稿')

    const lesson = makeLesson(workspace)
    const { name } = draftSkill(lesson, workspace, draftsDir)
    expect((await approveDraft(store, workspace, name, noConflict)).ok).toBe(true)
    const again = await approveDraft(store, workspace, name, noConflict)
    expect(again.ok).toBe(false)
    expect(again.message).toContain('已批准')
  })

  it('批准时保留草稿的人工编辑（以草稿文档为准落盘）', async () => {
    const lesson = makeLesson(workspace)
    const { name, filePath } = draftSkill(lesson, workspace, draftsDir)
    // 模拟用户编辑草稿正文
    const edited = readFileSync(filePath, 'utf8').replace('使用绝对路径', '使用绝对路径\n\n## 补充说明\n\n优先使用 rsync')
    writeFileSync(filePath, edited, 'utf8')

    const store = makeStore(workspace)
    const result = await approveDraft(store, workspace, name, noConflict)
    expect(result.ok).toBe(true)
    const skillText = readFileSync(join(workspace, '.dsh', 'skills', name, 'SKILL.md'), 'utf8')
    expect(skillText).toContain('优先使用 rsync')
  })

  it('同名冲突守卫：其他来源（如已装 dsh-skills-manager）占用同名技能时拒绝批准且不落盘', async () => {
    const lesson = makeLesson(workspace)
    const { name } = draftSkill(lesson, workspace, draftsDir)
    const store = makeStore(workspace)
    const conflicting: NameConflictCheck = async () => ({
      name,
      provider: 'skill-manager',
      source: 'skill-manager',
    })
    const result = await approveDraft(store, workspace, name, conflicting)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('拒绝批准')
    expect(result.message).toContain('skill-manager')
    // 关键断言：冲突时绝不落盘 .dsh/skills
    expect(existsSync(join(workspace, '.dsh', 'skills', name, 'SKILL.md'))).toBe(false)
    // 草稿仍保持 pending，可修复后重试
    const record = readDraftRecord(join(draftDirAbs(workspace), `${name}.md`))
    expect(record?.status).toBe('pending')
  })

  it('同名冲突守卫：注册表查询失败时保守拒绝（fail-closed）', async () => {
    const lesson = makeLesson(workspace)
    const { name } = draftSkill(lesson, workspace, draftsDir)
    const store = makeStore(workspace)
    const unavailable: NameConflictCheck = async () => ({
      name,
      provider: 'skills-registry-unavailable',
      source: 'boom',
    })
    const result = await approveDraft(store, workspace, name, unavailable)
    expect(result.ok).toBe(false)
    expect(existsSync(join(workspace, '.dsh', 'skills', name, 'SKILL.md'))).toBe(false)
  })

  it('同名冲突守卫：自己部署层（filesystem/project-dsh）不视为冲突，其他来源视为冲突', async () => {
    // 构造假 ctx.skills.snapshot：返回给定技能清单。
    const fakeCtx = (skills: Array<{ name: string; provider: string; source: string }>): Context =>
      ({
        skills: {
          snapshot: async () => ({ skills, complete: true }),
        },
      }) as unknown as Context

    // 自己部署层：<ws>/.dsh/skills（filesystem / project-dsh）→ 允许幂等重写
    const ownLayer = fakeCtx([{ name: 'bash', provider: 'filesystem', source: 'project-dsh' }])
    expect(await conflictCheckFor(ownLayer, workspace)('bash')).toBeUndefined()

    // 已装 dsh-skills-manager 库（provider=skill-manager）→ 冲突
    const installed = fakeCtx([{ name: 'bash', provider: 'skill-manager', source: 'skill-manager' }])
    const hit = await conflictCheckFor(installed, workspace)('bash')
    expect(hit?.provider).toBe('skill-manager')

    // runtime / user / bundled 等其他来源 → 冲突
    const runtime = fakeCtx([{ name: 'bash', provider: 'runtime', source: 'runtime' }])
    expect(await conflictCheckFor(runtime, workspace)('bash')).toBeDefined()
    const userDsh = fakeCtx([{ name: 'bash', provider: 'filesystem', source: 'user-dsh' }])
    expect(await conflictCheckFor(userDsh, workspace)('bash')).toBeDefined()

    // 无同名技能 → 无冲突
    const empty = fakeCtx([])
    expect(await conflictCheckFor(empty, workspace)('bash')).toBeUndefined()
  })

  it('同名冲突守卫：注册表查询抛错时返回 skills-registry-unavailable 冲突（fail-closed）', async () => {
    const broken = {
      skills: {
        snapshot: async () => {
          throw new Error('registry down')
        },
      },
    } as unknown as Context
    const hit = await conflictCheckFor(broken, workspace)('bash')
    expect(hit?.provider).toBe('skills-registry-unavailable')
    expect(hit?.source).toContain('registry down')
  })
})
