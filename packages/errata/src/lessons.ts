/**
 * 教训条目存储：错误捕获、同类聚合计数与失败模式匹配。
 *
 * 教训通过 shared 的 EntryStore 落盘到项目层 `<workspace>/.dsh/knowledge/`
 * （workspace 为会话 cwd 所在 git 项目根），条目为 category 'lesson' 的
 * Markdown + frontmatter 文件。只记录参数哈希前缀，绝不落盘参数原文。
 */

import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  EntryStore,
  argsHashPrefix,
  entryId,
  findProjectRoot,
  isErrorLesson,
  patternKey,
  type EntryStatus,
  type ErrorLesson,
} from '@dsh-plugins/shared'

/** 无 LLM 提炼时的修复方式占位文案。 */
export const FIX_PLACEHOLDER = '待人工补充修复方式'

/** 新建教训条目的默认置信度。 */
const FRESH_LESSON_CONFIDENCE = 0.3

/** 缺少结构化错误码时的兜底错误类型。 */
const UNKNOWN_ERROR_TYPE = 'ERROR'

export interface LessonStoreOptions {
  /** 命中失败模式并触发预警所需的最低失败次数（默认 1）。 */
  warnAfterFailures?: number
  /** 教训条目晋升为 distilled 所需的最低失败次数（默认 3）。 */
  promoteAfterFailures?: number
  /** 教训条目的标签命名空间（默认 'lessons'）。 */
  lessonsDir?: string
  /** DSH home 目录（默认由 EntryStore 解析：$DSH_HOME 或 ~/.dsh）。测试时注入临时目录。 */
  dshHome?: string
  /** 无 agent 上下文时的默认项目工作区（默认 process.cwd()）。测试时注入临时目录。 */
  workspace?: string
}

/**
 * 项目层教训存储。
 */
export class LessonStore {
  readonly store: EntryStore
  readonly warnAfterFailures: number
  readonly promoteAfterFailures: number
  readonly lessonsDir: string
  readonly workspace: string

  constructor(options: LessonStoreOptions = {}) {
    this.store = new EntryStore(options.dshHome === undefined ? undefined : { dshHome: options.dshHome })
    this.warnAfterFailures = options.warnAfterFailures ?? 1
    this.promoteAfterFailures = options.promoteAfterFailures ?? 3
    this.lessonsDir = options.lessonsDir ?? 'lessons'
    this.workspace = options.workspace ?? process.cwd()
  }

  /** 解析一次执行所属的项目层 workspace（git 项目根；无 agent 时使用默认工作区）。 */
  workspaceFor(exec: Readonly<ToolExecution>): string {
    const cwd = exec.agent?.session.header.cwd
    if (cwd !== undefined && cwd !== '') return findProjectRoot(cwd)
    return this.workspace
  }

  /**
   * 记录一次工具执行结果。失败时按 `patternKey(tool, errorType)` 聚合计数：
   * 已存在同类条目则 errorCount + 1 并更新 lastUsed/hitCount；
   * 否则新建原始教训条目（errorCount 1、confidence 0.3、status 'raw'、
   * source `trajectory:<callId>`）。errorCount 达到 promoteAfterFailures 时
   * 晋升为 distilled 并写入 fix 占位（无 LLM 时写「待人工补充修复方式」）。
   */
  record(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ErrorLesson | undefined {
    if (!result.isError) return undefined
    const tool = exec.name
    const errorType = result.error.info?.code ?? UNKNOWN_ERROR_TYPE
    const prefix = argsHashPrefix(exec.arguments)
    const workspace = this.workspaceFor(exec)
    const key = patternKey(tool, errorType)
    const existing = this.findLesson(key, workspace)
    if (existing !== undefined) {
      existing.errorCount += 1
      existing.lastUsed = today()
      existing.hitCount += 1
      this.maybePromote(existing)
      this.store.write(existing, workspace)
      return existing
    }
    const lesson: ErrorLesson = {
      id: this.nextEntryId(workspace),
      scope: 'project',
      workspace,
      category: 'lesson',
      tags: [this.lessonsDir],
      title: `工具 ${tool} 失败教训（${errorType}）`,
      body: [
        `工具 ${tool} 在相同参数模式下失败，错误类型为 ${errorType}。`,
        `参数哈希前缀：${prefix}`,
        `来源轨迹：${exec.callId}`,
      ].join('\n'),
      created: today(),
      lastUsed: today(),
      hitCount: 1,
      confidence: FRESH_LESSON_CONFIDENCE,
      source: `trajectory:${exec.callId}`,
      status: 'raw',
      tool,
      argsHashPrefix: prefix,
      errorType,
      errorCount: 1,
    }
    this.maybePromote(lesson)
    this.store.write(lesson, workspace)
    return lesson
  }

  /**
   * 查找与当前调用匹配的失败模式：同工具、当前参数哈希前缀命中条目前缀、
   * 且条目累计失败次数达到 warnAfterFailures。多个命中时取 errorCount
   * 最大者（并列时取最近使用）。
   */
  findMatch(exec: Readonly<ToolExecution>): ErrorLesson | undefined {
    const prefix = argsHashPrefix(exec.arguments)
    const workspace = this.workspaceFor(exec)
    let best: ErrorLesson | undefined
    for (const entry of this.store.list(workspace)) {
      if (!isErrorLesson(entry)) continue
      if (entry.scope !== 'project') continue
      if (entry.tool !== exec.name) continue
      if (entry.argsHashPrefix.length === 0 || !prefix.startsWith(entry.argsHashPrefix)) continue
      if (entry.errorCount < this.warnAfterFailures) continue
      if (best === undefined || lessonRank(entry) > lessonRank(best)) best = entry
    }
    return best
  }

  /** 按 patternKey 查找项目层已有的同类教训条目。 */
  private findLesson(key: string, workspace: string): ErrorLesson | undefined {
    for (const entry of this.store.list(workspace)) {
      if (!isErrorLesson(entry)) continue
      if (entry.scope !== 'project') continue
      if (patternKey(entry.tool, entry.errorType) !== key) continue
      return entry
    }
    return undefined
  }

  /** 生成当日序号递增的条目 id（kb-YYYYMMDD-NNN），避免同日多条目互相覆盖。 */
  private nextEntryId(workspace: string): string {
    const date = new Date()
    const prefix = entryId(date, 0).slice(0, -3)
    let maxSeq = 0
    for (const entry of this.store.list(workspace)) {
      if (!entry.id.startsWith(prefix)) continue
      const seq = Number(entry.id.slice(prefix.length))
      if (Number.isInteger(seq) && seq > maxSeq) maxSeq = seq
    }
    // 撞 id 加固：已存在同 id 时继续递增（防跨进程短窗口竞态覆盖；
    // 单进程内 record 为同步执行，无交错）。
    let id = entryId(date, maxSeq + 1)
    let guard = 0
    while (this.findLessonById(id, workspace) !== undefined && guard < 1000) {
      maxSeq += 1
      id = entryId(date, maxSeq + 1)
      guard += 1
    }
    return id
  }

  /** 失败次数达到阈值时晋升为 distilled 并写入 fix 占位。 */
  private maybePromote(lesson: ErrorLesson): void {
    if (lesson.errorCount < this.promoteAfterFailures) return
    if (lesson.status === 'distilled') return
    lesson.status = 'distilled'
    lesson.fix = lesson.fix ?? FIX_PLACEHOLDER
  }

  /**
   * 按 id 查找一条教训条目（只查项目层，避免全局层同 id 条目遮蔽；
   * workspace 缺省取默认工作区）。只返回 category='lesson' 且 scope
   * 为 project 的条目；不存在或非项目层教训返回 undefined。
   */
  findLessonById(id: string, workspace?: string): ErrorLesson | undefined {
    const ws = workspace ?? this.workspace
    const entry = this.store.readProject(id, ws)
    return entry !== undefined && isErrorLesson(entry) && entry.scope === 'project' ? entry : undefined
  }

  /** 列出指定工作区项目层的全部教训条目（错题本仅针对项目层；缺省取默认工作区）。 */
  listLessons(workspace?: string): ErrorLesson[] {
    return this.store.list(workspace ?? this.workspace)
      .filter((entry): entry is ErrorLesson => isErrorLesson(entry) && entry.scope === 'project')
  }

  /**
   * 把条目状态改为指定值并落盘（项目层）。返回更新后的条目；
   * id 不存在或非教训条目返回 undefined。archivedFrom 仅在显式传入时覆盖。
   */
  setStatus(id: string, status: EntryStatus, workspace?: string, archivedFrom?: EntryStatus): ErrorLesson | undefined {
    const lesson = this.findLessonById(id, workspace)
    if (lesson === undefined) return undefined
    lesson.status = status
    if (archivedFrom !== undefined) lesson.archivedFrom = archivedFrom
    this.store.write(lesson, lesson.workspace ?? workspace ?? this.workspace)
    return lesson
  }

  /**
   * 归档：转入 archived 分组。记录归档前的原状态到 archivedFrom，
   * 供「反悔」恢复。已归档条目重复归档为幂等操作。
   */
  archive(id: string, workspace?: string): ErrorLesson | undefined {
    const lesson = this.findLessonById(id, workspace)
    if (lesson === undefined) return undefined
    if (lesson.status === 'archived') return lesson
    return this.setStatus(id, 'archived', workspace, lesson.status)
  }

  /**
   * 取消归档（反悔）：恢复 archivedFrom 记录的原状态；无记录时按
   * errorCount 是否达标自动推导（distilled / raw）。返回恢复后的条目。
   */
  unarchive(id: string, workspace?: string): ErrorLesson | undefined {
    const lesson = this.findLessonById(id, workspace)
    if (lesson === undefined) return undefined
    if (lesson.status !== 'archived') return lesson
    const target: EntryStatus = lesson.archivedFrom ?? (
      lesson.errorCount >= this.promoteAfterFailures ? 'distilled' : 'raw'
    )
    lesson.status = target
    lesson.archivedFrom = undefined
    this.store.write(lesson, lesson.workspace ?? workspace ?? this.workspace)
    return lesson
  }

  /** 永久删除一条项目层教训条目；返回是否实际删除。 */
  remove(id: string, workspace?: string): boolean {
    const lesson = this.findLessonById(id, workspace)
    if (lesson === undefined) return false
    return this.store.removeProject(id, lesson.workspace ?? workspace ?? this.workspace) !== undefined
  }

  /** 晋级成功后置位：status → promoted 并记录关联技能 id。 */
  markPromoted(id: string, skillName: string, workspace?: string): ErrorLesson | undefined {
    const lesson = this.findLessonById(id, workspace)
    if (lesson === undefined) return undefined
    lesson.status = 'promoted'
    lesson.relatedSkillId = skillName
    lesson.archivedFrom = undefined
    this.store.write(lesson, lesson.workspace ?? workspace ?? this.workspace)
    return lesson
  }
}

/** 排序分：errorCount 优先，其次最近使用时间。 */
function lessonRank(lesson: ErrorLesson): number {
  return lesson.errorCount * 1_000_000_000 + Date.parse(lesson.lastUsed)
}

/** 当日 ISO 日期字符串（YYYY-MM-DD）。 */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}
