/**
 * DSH 错题本晋级插件（@dsh-plugins/lesson-promote，原 skill-manager v3.0 更名）。
 *
 * 职责：把项目层 .dsh/knowledge/ 中沉淀的教训条目（ErrorLesson，即"错题本"）
 * 在记录次数过多（errorCount 达到阈值且状态 distilled）时晋级为 DSH 技能——
 * 生成技能草稿、审批落盘（写入 .dsh/skills/<name>/SKILL.md，由内置
 * skill-filesystem provider 自动加载）。
 *
 * v3.0 变更（避免与已安装的 dsh-skills-manager 冲突）：
 * - **更名**：包/插件 id/工具名统一为 lesson-promote，不再占用
 *   "skill-manager" 这个名字（已装 dsh-skills-manager 的 provider 名就叫
 *   skill-manager，rank 50）。
 * - **删除重复功能**：不再提供技能版本快照与 rollback（技能安装/启用/停用/
 *   更新/移除等生命周期归已装 dsh-skills-manager 管理），草稿目录默认改为
 *   .dsh/lesson-promote/drafts。
 * - **同名冲突守卫**：approve 前查询平台 ctx.skills 注册表，若同名技能已
 *   由其他来源（dsh-skills-manager 库 / runtime / user / bundled 等）占用，
 *   拒绝批准并提示，保证已装插件优先、不产生遮蔽。
 *
 * @module @dsh-plugins/lesson-promote
 */

import type { Context } from '@deepseek-ai/cordis'
import { EntryStore, findProjectRoot, type ErrorLesson } from '@dsh-plugins/shared'
import { draftSkill, scanPromotable } from './promote.js'
import { approveDraft, conflictCheckFor, registerLessonPromoteTool, type LessonPromoteResult } from './manage.js'

/** Cordis 插件名。 */
export const name = 'lesson-promote'
/** 需要的服务：skills（平台技能注册表，approve 同名冲突守卫用）、agents（宿主代理）、tools（注册管理工具）。 */
export const inject = ['skills', 'agents', 'tools']

/** 插件配置（手写默认合并，不使用 schemastery）。 */
export interface Config {
  /** 晋升阈值：errorCount 达到该值且状态为 distilled 的教训条目才可晋升（默认 3）。 */
  promoteAfterFailures?: number
  /** 是否自动批准草稿（默认 false）。false 时批准必须由用户显式调用 lesson-promote 工具的 approve 动作触发。 */
  autoApprove?: boolean
  /** 草稿清单目录，相对路径按工作区解析（默认 .dsh/lesson-promote/drafts）。草稿只写这里，不写入 .dsh/skills。 */
  draftsDir?: string
}

/** 默认配置。 */
export const defaultConfig: Required<Config> = {
  promoteAfterFailures: 3,
  autoApprove: false,
  draftsDir: '.dsh/lesson-promote/drafts',
}

/** 合并并校验后的运行配置。 */
export interface ResolvedLessonPromoteConfig {
  promoteAfterFailures: number
  autoApprove: boolean
  /** 草稿清单目录（可为相对路径，使用时按工作区解析）。 */
  draftsDir: string
}

/** 手写默认合并：用户配置浅层覆盖默认值，并校验阈值。 */
export function resolveConfig(config: Config = {}): ResolvedLessonPromoteConfig {
  const promoteAfterFailures = config.promoteAfterFailures ?? defaultConfig.promoteAfterFailures
  if (!Number.isInteger(promoteAfterFailures) || promoteAfterFailures < 1) {
    throw new Error('lesson-promote: promoteAfterFailures 必须是大于等于 1 的整数')
  }
  return {
    promoteAfterFailures,
    autoApprove: config.autoApprove ?? defaultConfig.autoApprove,
    draftsDir: config.draftsDir ?? defaultConfig.draftsDir,
  }
}

/** 插件暴露给宿主与其他插件的 store（通过 ctx.lessonPromote 提供）。 */
export interface LessonPromoteStore {
  /** 合并后的运行配置。 */
  readonly config: ResolvedLessonPromoteConfig
  /** 共享条目存储（读取 <workspace>/.dsh/knowledge/ 与全局层的教训）。 */
  readonly entries: EntryStore
  /** 解析工作区根目录（默认取调用方 cwd 的项目根，找不到 .git 时回退 cwd）。 */
  resolveWorkspace(cwd?: string): string
  /** 列出满足晋升条件的教训条目（lesson + distilled + errorCount 达标）。 */
  scanPromotable(workspace: string): ErrorLesson[]
  /**
   * 为一条教训生成技能草稿（写入草稿清单 <draftsDir>/<name>.md，
   * 不写入 .dsh/skills）。
   */
  draftSkill(lesson: ErrorLesson, workspace: string): { name: string; filePath: string }
  /**
   * 批准草稿并落盘为正式技能：读草稿 → 同名冲突守卫（已装插件优先，
   * 失败保守拒绝）→ 写入 <workspace>/.dsh/skills/<name>/SKILL.md →
   * 草稿状态置 approved。供 errata 面板「一键晋级」复用，与
   * lesson-promote 工具的 approve 动作走同一守卫链路。
   */
  approve(name: string, workspace: string): Promise<LessonPromoteResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** lesson-promote 提供的错题本晋级 store。 */
    lessonPromote: LessonPromoteStore
  }
}

/**
 * 插件入口：注册 store（ctx.lessonPromote）与一个管理工具（lesson-promote）。
 *
 * 注意：autoApprove=false（默认）时，插件不会在后台自动注册任何技能；
 * 批准必须由用户显式调用 lesson-promote 工具的 approve 动作触发，由
 * approve 把草稿落盘到 .dsh/skills/<name>/SKILL.md（内置 skill-filesystem
 * 自动加载），落盘前做同名冲突守卫（已装插件优先）。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
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
  // 注册 store：其他插件（如 errata）可经 ctx.lessonPromote 读取教训并触发晋升流程。
  ctx.provide('lessonPromote', store)
  // 注册管理工具：list / approve（含同名冲突守卫）。
  registerLessonPromoteTool(ctx, store)
}
