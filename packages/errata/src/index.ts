/**
 * DSH 错误捕获与执行前预警注入插件（@dsh-knowledge/errata）。
 *
 * 订阅 `tools/result`（emit）观察失败的工具调用并沉淀为项目层教训条目，
 * 订阅 `tools/pre-execute`（waterfall，prepend）在命中失败模式时向 agent
 * 注入中文预警。监听器注册在 `ctx.effect` 内，插件卸载时随 fiber 自动回收。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { LessonStore, type LessonStoreOptions } from './lessons.js'
import { registerWarning, type ErrataWarningSource } from './warn.js'

export const name = 'errata'
export const inject = ['agents', 'tools']

/** 用户配置：全部可选，缺省值在 `apply` 内手写合并。 */
export interface Config {
  /** 命中失败模式并触发预警所需的最低失败次数（默认 1）。 */
  warnAfterFailures?: number
  /** 教训条目晋升为 distilled 所需的最低失败次数（默认 3）。 */
  promoteAfterFailures?: number
  /** 总开关；为 false 时不注册任何监听（默认 true）。 */
  enabled?: boolean
  /** 教训条目的标签命名空间（默认 'lessons'）。 */
  lessonsDir?: string
}

/** 合并默认值后的完整配置。 */
export interface ResolvedConfig {
  warnAfterFailures: number
  promoteAfterFailures: number
  enabled: boolean
  lessonsDir: string
}

const DEFAULT_CONFIG: ResolvedConfig = {
  warnAfterFailures: 1,
  promoteAfterFailures: 3,
  enabled: true,
  lessonsDir: 'lessons',
}

/** 结构化 Standard Schema（`~standard`）的局部声明，避免引入 '@standard-schema/spec'。 */
interface ConfigSchemaLike {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => ConfigValidationResult
  }
}

type ConfigValidationResult =
  | { readonly value: ResolvedConfig }
  | { readonly issues: readonly unknown[] }

/**
 * 默认配置对象，同时充当 Standard Schema：cordis Loader 校验时通过
 * `~standard.validate` 完成手写的默认值合并（不依赖 schemastery）。
 */
export const Config: Config & ConfigSchemaLike = {
  ...DEFAULT_CONFIG,
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-plugins/errata',
    validate: (value: unknown): ConfigValidationResult => {
      const input = isConfigRecord(value) ? value : {}
      return { value: mergeConfig(input) }
    },
  },
}

function isConfigRecord(value: unknown): value is Config {
  return typeof value === 'object' && value !== null
}

/** 手写默认合并：逐字段回退到 DEFAULT_CONFIG。 */
export function mergeConfig(input: Config): ResolvedConfig {
  return {
    warnAfterFailures: input.warnAfterFailures ?? DEFAULT_CONFIG.warnAfterFailures,
    promoteAfterFailures: input.promoteAfterFailures ?? DEFAULT_CONFIG.promoteAfterFailures,
    enabled: input.enabled ?? DEFAULT_CONFIG.enabled,
    lessonsDir: input.lessonsDir ?? DEFAULT_CONFIG.lessonsDir,
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`errata: ${name} 必须是大于等于 1 的整数，实际为 ${value}`)
  }
}

/**
 * 安装错误捕获与预警注入逻辑，并暴露宿主端 Remote 服务（错题设置页数据源）。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = mergeConfig(config)
  if (!resolved.enabled) return
  assertPositiveInteger('warnAfterFailures', resolved.warnAfterFailures)
  assertPositiveInteger('promoteAfterFailures', resolved.promoteAfterFailures)
  const lessons = new LessonStore(resolved)
  ctx.effect(function* () {
    yield ctx.on('tools/result', (exec, result) => {
      lessons.record(exec, result)
    })
    yield registerWarning(ctx, lessons)
  }, 'errata')
  // 注意：宿主端 Remote 服务（错题设置页数据源）由 host 入口
  // （@dsh-knowledge/errata/host）在 host 平面提供；本入口是 agent 平面
  // 工具插件，不重复注册 service（Web profile 里 agent 平面按会话挂载，
  // 重复注册会与宿主 Gateway 的 errata 命名空间冲突）。
}

export { FIX_PLACEHOLDER, LessonStore, type LessonStoreOptions } from './lessons.js'
export { registerWarning, type ErrataWarningSource } from './warn.js'
export { ErrataRemoteService, ERRATA_NAMESPACE, type ErrataLessonView, type ErrataPromoteGateway, type ErrataRemoteServiceOptions } from './remote.js'
export type { ToolExecution, ToolExecutionResult }
