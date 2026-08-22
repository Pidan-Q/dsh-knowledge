/**
 * errata 宿主端 Remote 服务：把错题列表与归档/晋级动作暴露给浏览器设置页。
 *
 * 通过 `TypertRemoteService` + `@Remote` 装饰器声明端点；描述符由
 * typert-loader 从包 `./typert` 导出（本仓库内为手写对齐官方生成格式的
 * `src/typert.host.ts`）注册到 `ctx.typert`，浏览器端经
 * `ctx.remote.errata.*` 调用。方法只返回 JSON 纯数据，业务校验失败抛
 * `Error`（网关折叠为 RemoteFailure 的 error 分支）。
 *
 * workspace 语义（见方案「项目定位」）：宿主平面没有单一「当前会话」，
 * 动作方法显式携带 `workspace`（条目本身带 `workspace` 字段，天然支持
 * 跨工作区列举）；缺省时回退到 LessonStore 的默认工作区。
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ErrorLesson } from '@dsh-knowledge/shared'
import type { LessonStore } from './lessons.js'

/** 晋级链路的宿主侧能力（由 lesson-promote 的 `ctx.lessonPromote` store 提供）。 */
export interface ErrataPromoteGateway {
  /** 列出满足晋升条件的条目（distilled 且 errorCount 达标）。 */
  scanPromotable(workspace: string): ErrorLesson[]
  /** 幂等生成技能草稿，返回技能名（同一教训不重复生成，保留人工编辑）。 */
  draftSkill(lesson: ErrorLesson, workspace: string): { name: string; filePath: string }
  /** 批准草稿落盘为正式技能（含同名冲突守卫，失败保守拒绝）。 */
  approve(name: string, workspace: string): Promise<{ ok: boolean; message: string; result?: { file?: unknown } }>
}

/** errata Remote 服务的运行依赖。 */
export interface ErrataRemoteServiceOptions {
  /** 教训存储（读取/改态/删除）。 */
  lessons: LessonStore
  /** 晋级能力；缺省表示 lesson-promote 未启用，promote 方法将拒绝调用。 */
  promote?: ErrataPromoteGateway
}

/** 穿越 Remote 边界的错题纯数据视图（条目本身即 frontmatter 派生的纯 JSON）。 */
export type ErrataLessonView = ErrorLesson

/** Remote wire 命名空间（与 Cordis service key 一致）。 */
export const ERRATA_NAMESPACE = 'errata'

/**
 * 错题 Remote 服务：list / archive / unarchive / delete / promote。
 * 构造时经 `super(ctx, 'errata')` 注册 Cordis service 并绑定 Typert
 * Gateway 命名空间。
 */
export class ErrataRemoteService extends TypertRemoteService {
  private readonly hostCtx: Context
  private readonly lessons: LessonStore
  private readonly promoteGateway: ErrataPromoteGateway | undefined

  constructor(ctx: Context, options: ErrataRemoteServiceOptions) {
    super(ctx, ERRATA_NAMESPACE)
    this.hostCtx = ctx
    this.lessons = options.lessons
    this.promoteGateway = options.promote
  }

  /** 列出错题（可选按 workspace 过滤；缺省返回全局 + 默认工作区项目层）。 */
  @Remote('list')
  list(workspace?: string): { lessons: ErrataLessonView[] } {
    return { lessons: this.lessons.listLessons(workspace) }
  }

  /** 归档：转入 archived 分组，记录原状态供反悔。 */
  @Remote('archive')
  archive(lessonId: string, workspace?: string): { lesson: ErrataLessonView } {
    const lesson = this.lessons.archive(lessonId, workspace)
    if (lesson === undefined) throw new Error(`未找到教训条目 ${lessonId}`)
    return { lesson }
  }

  /** 取消归档（反悔）：恢复归档前状态（无记录时按 errorCount 自动推导）。 */
  @Remote('unarchive')
  unarchive(lessonId: string, workspace?: string): { lesson: ErrataLessonView } {
    const lesson = this.lessons.unarchive(lessonId, workspace)
    if (lesson === undefined) throw new Error(`未找到教训条目 ${lessonId}`)
    return { lesson }
  }

  /** 永久删除一条错题。 */
  @Remote('delete')
  delete(lessonId: string, workspace?: string): { removed: true } {
    const removed = this.lessons.remove(lessonId, workspace)
    if (!removed) throw new Error(`未找到教训条目 ${lessonId}`)
    return { removed: true }
  }

  /**
   * 一键晋级：生成草稿 + 立即批准（保留同名冲突守卫），成功后把错题
   * 状态置 promoted 并记录关联技能。仅 distilled 且 errorCount 达标的
   * 条目可晋级（由 lesson-promote 的 scanPromotable 保证）。
   */
  @Remote('promote')
  async promote(lessonId: string, workspace?: string): Promise<{ skillName: string; file?: unknown }> {
    const promote = this.promoteGateway
      ?? this.hostCtx.get('lessonPromote') as ErrataPromoteGateway | undefined
    if (promote === undefined) {
      throw new Error('晋级能力不可用：lesson-promote 插件未启用')
    }
    const lesson = this.lessons.findLessonById(lessonId, workspace)
    if (lesson === undefined) throw new Error(`未找到教训条目 ${lessonId}`)
    if (lesson.status !== 'distilled') {
      throw new Error(`仅已提炼（distilled）条目可晋级，当前状态：${lesson.status}`)
    }
    if (lesson.scope !== 'project') {
      throw new Error('仅项目层条目可晋级（全局层教训不注册为项目技能）')
    }
    const ws = workspace ?? lesson.workspace ?? ''
    const promotable = promote.scanPromotable(ws).find((item) => item.id === lessonId)
    if (promotable === undefined) {
      throw new Error(`教训 ${lessonId} 尚未达到晋级条件（errorCount 未达阈值）`)
    }
    const { name } = promote.draftSkill(promotable, ws)
    const result = await promote.approve(name, ws)
    if (!result.ok) throw new Error(result.message)
    const updated = this.lessons.markPromoted(lessonId, name, ws)
    if (updated === undefined) throw new Error(`晋级后更新教训状态失败：${lessonId}`)
    const file = result.result?.file
    return file === undefined ? { skillName: name } : { skillName: name, file }
  }
}
