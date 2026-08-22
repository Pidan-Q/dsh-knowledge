/**
 * lesson-promote host 平面入口：只提供错题本晋级 store（ctx.lessonPromote），
 * 供 errata 的 host 平面 Remote 服务（晋级动作）复用。
 *
 * 与 agent 平面入口（index.ts，工具注册）分离：Web profile 里 agent 平面
 * 按会话挂载，而 errata Remote 服务的晋级链路需要 host 平面可用的 store。
 * 本入口只注入 `skills`（同名冲突守卫用，skills 注册表在 host 平面），
 * 不注册任何工具：
 *
 *   - id: lesson-promote-host
 *     name: '@dsh-knowledge/lesson-promote/host'
 */

import type { Context } from '@deepseek-ai/cordis'
import { EntryStore, findProjectRoot, type ErrorLesson } from '@dsh-knowledge/shared'
import { draftSkill, scanPromotable } from './promote.js'
import { approveDraft, conflictCheckFor, type LessonPromoteResult } from './manage.js'
import { resolveConfig, type Config, type LessonPromoteStore } from './index.js'

/** Cordis 插件名（组合行 id 才是 entry 唯一标识，此处不影响）。 */
export const name = 'lesson-promote-host'

/** 需要的服务：skills（平台技能注册表，approve 同名冲突守卫用，host 平面）。 */
export const inject = ['skills']

/**
 * host 平面入口：构造并注册 lessonPromote store（含 approve 能力，
 * 内部走 approveDraft + 同名冲突守卫，与工具链同一守卫）。
 */
export function apply(ctx: Context, rawConfig: Config = {}): void {
  const resolved = resolveConfig(rawConfig)
  const entries = new EntryStore()
  const store: LessonPromoteStore = {
    config: resolved,
    entries,
    resolveWorkspace: (cwd?: string): string => findProjectRoot(cwd ?? process.cwd()),
    scanPromotable: (workspace: string): ErrorLesson[] =>
      scanPromotable(workspace, { entries, promoteAfterFailures: resolved.promoteAfterFailures }),
    draftSkill: (lesson: ErrorLesson, workspace: string): { name: string; filePath: string } =>
      draftSkill(lesson, workspace, resolved.draftsDir),
    approve: (name: string, workspace: string): Promise<LessonPromoteResult> =>
      approveDraft(store, workspace, name, conflictCheckFor(ctx, workspace)),
  }
  ctx.provide('lessonPromote', store)
}
