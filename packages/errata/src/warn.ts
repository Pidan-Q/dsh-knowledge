/**
 * 执行前预警注入：命中失败模式时向 agent 注入中文预警文案。
 *
 * 在 `tools/pre-execute`（waterfall，prepend 注册优先执行）中查询教训库，
 * 命中且存在 agent 时通过 `agent.inject()` 注入预警并始终放行（`return next()`），
 * 绝不拦截调用。文案只含工具名、失败次数、错误类型与建议方向，
 * 不包含参数原文。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ErrorLesson } from '@dsh-plugins/shared'
import { FIX_PLACEHOLDER, type LessonStore } from './lessons.js'

/** 预警注入消息的结构化来源。 */
export interface ErrataWarningSource {
  readonly kind: 'errata-warning'
  readonly lessonId: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'errata-warning': ErrataWarningSource
  }
}

/**
 * 注册 `tools/pre-execute` 预警监听（以 `true` 作为第三个参数 prepend，
 * 优先于其他拦截器执行）。命中失败模式且存在 agent 时注入预警后放行。
 */
export function registerWarning(ctx: Context, store: LessonStore): () => boolean {
  return ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.signal.aborted) return next()
    const agent = exec.agent
    if (agent === undefined) return next()
    const lesson = store.findMatch(exec)
    if (lesson === undefined) return next()
    const source: ErrataWarningSource = { kind: 'errata-warning', lessonId: lesson.id }
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: renderWarning(lesson) }],
      source,
    }))
    return next()
  }, true)
}

/** 预警文案：含工具名、失败次数、错误类型与建议，不含任何参数原文。 */
function renderWarning(lesson: ErrorLesson): string {
  const suggestion = lesson.fix !== undefined && lesson.fix !== '' && lesson.fix !== FIX_PLACEHOLDER
    ? lesson.fix
    : `参见已记录教训条目 ${lesson.id}，请调整参数或改用其他方式后再试`
  return `工具调用预警：上次类似调用（工具 ${lesson.tool}）已失败 ${lesson.errorCount} 次，`
    + `错误类型为 ${lesson.errorType}。`
    + `建议：${suggestion}。`
}
