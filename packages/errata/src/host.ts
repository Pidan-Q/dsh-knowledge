/**
 * errata host 平面入口：只提供宿主端 Remote 服务（错题设置页数据源）。
 *
 * 与 agent 平面入口（index.ts，工具 + 预警监听）分离，因为 Web profile
 * 里 agent 平面按会话挂载，而 Remote 服务是 host 平面服务（方案「包与
 * 目录调整 · 四个注册面」第 1 点：像 plugin-inventory 一样以 host 平面
 * 行挂载）。本入口不注入 agents/tools，可在 host 平面独立挂载：
 *
 *   - id: errata-host
 *     name: '@dsh-plugins/errata/host'
 *
 * 晋级链路可选依赖 lesson-promote 的 host 入口（ctx.lessonPromote）；
 * 未启用时 promote 方法返回明确错误，其余能力不受影响。
 */

import type { Context } from '@deepseek-ai/cordis'
import { LessonStore } from './lessons.js'
import { ErrataRemoteService, type ErrataPromoteGateway } from './remote.js'
import { mergeConfig, type Config } from './index.js'
// 副作用导入：加载 dsh-typert-registry 对 TypertRegistryContract 的
// register 方法类型扩展（ctx.typert.register(TypertContribution)）。
import '@deepseek-ai/dsh-typert-registry'
import { TYPERT } from './typert.host.js'

/** Cordis 插件名（组合行 id 才是 entry 唯一标识，此处不影响）。 */
export const name = 'errata-host'

/** 需要的服务：typert（宿主 Typert 注册表，手工注册 Remote 描述符）。 */
export const inject = ['typert']

/**
 * host 平面入口：构造 LessonStore（默认工作区 = 宿主进程 cwd 项目根，
 * 具体 workspace 由 Remote 方法显式携带）、手工注册 Typert manifest
 * （不依赖 typert-loader 扫描 `./typert`，避免与 loader 双注册）并
 * 注册 errata Remote 服务。
 */
export function apply(ctx: Context, rawConfig: Config = {}): void {
  const resolved = mergeConfig(rawConfig)
  const lessons = new LessonStore(resolved)
  // 手工注册 manifest：贡献 {package, face, schemas, model, invocations}，
  // register 内部经 ctx.effect 管理生命周期，卸载自动回收。
  ctx.typert.register(TYPERT)
  new ErrataRemoteService(ctx, {
    lessons,
    promote: ctx.get('lessonPromote') as ErrataPromoteGateway | undefined,
  })
}
