/**
 * knowledge host 平面入口：只提供宿主端 Remote 服务（知识库设置页数据源）。
 *
 * 与 agent 平面入口（index.ts，kb.* 工具 + 上下文注入）分离：Web profile
 * 里 agent 平面按会话挂载，而 Remote 服务是 host 平面服务。本入口不注入
 * agents/tools，可在 host 平面独立挂载：
 *
 *   - id: knowledge-host
 *     name: 'dsh-kb/host'
 */

import type { Context } from '@deepseek-ai/cordis'
import { KnowledgeRemoteService } from './remote.js'
// 副作用导入：加载 dsh-typert-registry 对 TypertRegistryContract 的
// register 方法类型扩展（ctx.typert.register(TypertContribution)）。
import '@deepseek-ai/dsh-typert-registry'
import { TYPERT } from './typert.host.js'

/** Cordis 插件名（组合行 id 才是 entry 唯一标识，此处不影响）。 */
export const name = 'knowledge-host'

/** 需要的服务：typert（宿主 Typert 注册表，手工注册 Remote 描述符）。 */
export const inject = ['typert']

/** host 平面入口配置（与 agent 入口的 allowGlobalWrite 保持一致）。 */
export interface HostConfig {
  /** 是否允许写入 global 层知识库；默认 false（与插件配置一致）。 */
  allowGlobalWrite?: boolean
  /** 项目工作区候选的扫描基目录（单根或数组）；缺省 [homedir]（见 KnowledgeRemoteServiceOptions）。 */
  projectScanRoot?: string | string[]
}

/** host 平面入口：手工注册 Typert manifest 并注册 knowledge Remote 服务。 */
export function apply(ctx: Context, rawConfig: HostConfig = {}): void {
  ctx.typert.register(TYPERT)
  // dsh 已打开/注册的工作区（workspaceRegistry）由 KnowledgeRemoteService.workspaces()
  // 在调用时惰性读取——不在 apply 时快照：knowledge-host 只依赖 typert，常先于
  // workspaceRegistry 的 async bootstrap 完成，此时 ctx.get 严格模式取不到服务，
  // 快照恒为空；运行时读取还能让运行中新打开的工作区免重启即出现。
  new KnowledgeRemoteService(ctx, {
    allowGlobalWrite: rawConfig.allowGlobalWrite ?? false,
    projectScanRoot: rawConfig.projectScanRoot,
  })
}
