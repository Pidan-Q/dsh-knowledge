/**
 * @dsh-plugins/knowledge —— DSH 双层知识库插件。
 *
 * 提供三个工具：
 *   kb_search   在项目层 + 全局层知识库中做 BM25 全文检索；
 *   kb_remember 写入一条知识条目并返回生成的 id；
 *   kb_forget   按 id 删除知识条目。
 * 并在每个 agent 创建时主动注入 Config.injections 上下文全文 +
 * 知识库索引（条目标题清单，模型据此用 kb_search 读详情）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { KnowledgeService } from './store.js'
import { registerTools } from './tools.js'
import { registerInjection } from './inject.js'

export const name = 'knowledge'
export const inject = ['tools', 'agents']

/** 插件配置。 */
export interface Config {
  /** 每次创建 agent 时注入的上下文文本列表（全文注入，不截断）。 */
  injections: readonly string[]
  /** 是否允许工具写入 global 层知识库；默认 false。 */
  allowGlobalWrite: boolean
  /** 是否启用项目层知识库；默认 true。 */
  projectLayer: boolean
  /** 是否注入知识库索引（条目标题清单）让 AI 读取；默认 true。 */
  injectKnowledgeIndex: boolean
  /** 索引最多列出多少条标题；默认 50。 */
  injectKnowledgeMax: number
}

export function apply(ctx: Context, rawConfig: Partial<Config> = {}): void {
  // 手写默认值合并（不使用 schemastery）。
  const config: Config = {
    injections: rawConfig.injections ?? [],
    allowGlobalWrite: rawConfig.allowGlobalWrite ?? false,
    projectLayer: rawConfig.projectLayer ?? true,
    injectKnowledgeIndex: rawConfig.injectKnowledgeIndex ?? true,
    injectKnowledgeMax: rawConfig.injectKnowledgeMax ?? 50,
  }
  // 注册 store：实例化双层知识库服务并交给工具与注入订阅使用。
  const service = new KnowledgeService({ projectLayer: config.projectLayer })
  registerTools(ctx, service, config.allowGlobalWrite)
  registerInjection(ctx, service, {
    injections: config.injections,
    injectKnowledgeIndex: config.injectKnowledgeIndex,
    injectKnowledgeMax: config.injectKnowledgeMax,
  })
  // 注意：宿主端 Remote 服务（知识库设置页数据源）由 host 入口
  // （@dsh-plugins/knowledge/host）在 host 平面提供；本入口是 agent 平面
  // 工具插件，不重复注册 service（Web profile 里 agent 平面按会话挂载）。
}

export { KnowledgeService, type KnowledgeServiceOptions, type SearchHit, type SearchOptions } from './store.js'
export { registerTools } from './tools.js'
export { registerInjection } from './inject.js'
export {
  KnowledgeRemoteService,
  KNOWLEDGE_NAMESPACE,
  type KnowledgeEntryView,
  type KnowledgeRemoteServiceOptions,
  type RememberInput,
} from './remote.js'
