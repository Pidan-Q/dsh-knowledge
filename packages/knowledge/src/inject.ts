/**
 * 主动注入：订阅 agent/created，在每个 agent 创建后把配置的上下文全文
 * （Config.injections）与知识库索引（条目标题清单）注入其会话上下文
 * （agent.inject 排队、不唤醒驱动）。
 *
 * 注入消息携带自定义 source（'knowledge-injection'），通过扩展
 * @deepseek-ai/dsh-llm 的 MessageSourceMap 注册；声明模式仿照
 * dsh-skill 的 SkillInvocationSource。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { KnowledgeEntry } from '@dsh-plugins/shared'

/** 知识注入消息的持久化来源标记。 */
export interface KnowledgeInjectionSource {
  readonly kind: 'knowledge-injection'
  /** 注入内容的分类。 */
  readonly category: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 由本插件主动注入的知识上下文。 */
    'knowledge-injection': KnowledgeInjectionSource
  }
}

/** 注册 agent/created 主动注入的选项。 */
export interface InjectionOptions {
  /** 每次创建 agent 时注入的上下文文本列表（全文注入，不截断）。 */
  injections: readonly string[]
  /** 是否注入知识库索引（条目标题清单）；默认 true。 */
  injectKnowledgeIndex: boolean
  /** 索引最多列出多少条标题；默认 50，超出提示用 kb_search。 */
  injectKnowledgeMax: number
}

/**
 * 生成知识库索引文本（纯函数，便于测试）：按 scope 分组列出条目标题，
 * 末尾提示用 kb_search 检索详情。这是「让 AI 读到知识库」的主机制——
 * 模型在会话开始就知道知识库内容概览，需要细节时调用 kb_search。
 */
export function buildKnowledgeIndex(entries: readonly KnowledgeEntry[], max = 50): string {
  const project = entries.filter((e) => e.scope === 'project').slice(0, max)
  const global = entries.filter((e) => e.scope === 'global').slice(0, max)
  const lines: string[] = []
  if (project.length > 0) {
    lines.push(`项目知识库（${entries.filter((e) => e.scope === 'project').length} 条，列出 ${project.length} 条）：`)
    for (const entry of project) lines.push(`- [${entry.category}] ${entry.title}`)
  }
  if (global.length > 0) {
    lines.push(`全局知识库（${entries.filter((e) => e.scope === 'global').length} 条，列出 ${global.length} 条）：`)
    for (const entry of global) lines.push(`- [${entry.category}] ${entry.title}`)
  }
  if (lines.length === 0) return ''
  lines.push('')
  lines.push('知识库使用：需要某条知识细节时调用 kb_search 工具检索（按标题/关键词全文检索）；写入用 kb_remember；删除用 kb_forget。')
  return lines.join('\n')
}

/** 注册 agent/created 主动注入监听；两者皆空时不做任何订阅。 */
export function registerInjection(ctx: Context, service: { list(): readonly KnowledgeEntry[] }, options: InjectionOptions): void {
  const { injections, injectKnowledgeIndex, injectKnowledgeMax } = options
  if (injections.length === 0 && !injectKnowledgeIndex) return
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    if (injections.length > 0) {
      for (const text of injections) {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'knowledge-injection', category: 'context' },
        }))
      }
    }
    if (injectKnowledgeIndex) {
      const index = buildKnowledgeIndex(service.list(), injectKnowledgeMax)
      if (index.length > 0) {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: index }],
          source: { kind: 'knowledge-injection', category: 'index' },
        }))
      }
    }
  })
}
