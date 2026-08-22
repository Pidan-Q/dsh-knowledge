/**
 * 知识库 Web UI 设置页客户端插件入口。
 *
 * 职责：mount knowledge 的 Remote 描述符（ctx.remote.knowledge.*），
 * 注册 locale 字典，并向 `settings.section` 槽位注册「知识库」顶级分区。
 */

import TYPERT_REMOTE from '../typert.remote-client.js'
import { knowledgeRemoteApi } from './api.js'
import { KnowledgePanel } from './KnowledgePanel.js'
import { locales } from './locales.js'

/** 本插件拥有的文案命名空间（settings 前缀下，全局唯一）。 */
export const NS = 'settings.knowledge'

/** Cordis fiber 注入的服务。
 * 注意：**不能**把 `remote.knowledge` 声明进 inject——命名空间由本 entry 自己的
 * `$mount` 提供，声明会使 fiber 在等待该服务时保持 pending，apply 永不执行
 * （死锁）。命名空间在 `$mount` 后经 `ctx.remote.namespaces` 内部注册表取用
 * （见 api.ts 的 knowledgeRemoteApi）。 */
export const inject = ['slots', 'locale', 'remote']

/**
 * 客户端插件入口（async：Remote 描述符需先 $mount 才能调用命名空间）。
 */
export async function apply(ctx: {
  effect(fn: () => void, label: string): unknown
  locale: {
    register(ns: string, dict: Record<string, Record<string, string>>): unknown
    bind(ns: string): (key: string, params?: Record<string, unknown>) => string
  }
  remote: {
    $mount(contribution: unknown): Promise<() => Promise<void>>
  } & Record<string, unknown>
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(
      options: { name: string; id: string; order: number; label: () => string; inject: () => unknown },
      component: unknown,
    ): unknown
  }
}): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, locales), 'ui-settings-knowledge: dictionaries')
  const t = ctx.locale.bind(NS)
  // mount 描述符后，ctx.remote.knowledge 命名空间可用。
  await ctx.remote.$mount(TYPERT_REMOTE)
  const api = knowledgeRemoteApi(ctx.remote)
  const injected = () => ({ api, t })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'knowledge',
    order: 40,
    label: () => t('nav'),
    inject: injected,
  }, KnowledgePanel))
}
