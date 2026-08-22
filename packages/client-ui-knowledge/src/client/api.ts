/**
 * 知识库面板共享的 wire 类型与 Remote 调用封装。
 *
 * 客户端包不依赖宿主包（@dsh-plugins/knowledge）；wire 类型在此与宿主
 * manifest / shared/schema.ts 对齐手写。
 *
 * 调用约定：`ctx.remote.knowledge.*` 是**位置参数**方法（运行时按描述符
 * 参数顺序逐位 parse 并校验实参个数），因此这里的方法签名直接使用
 * 位置参数，与描述符 parameters 顺序一一对应。
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** 知识条目的 wire 形状（对齐 shared/schema.ts 的 KnowledgeEntry）。 */
export interface KnowledgeEntryView {
  id: string
  scope: 'project' | 'global' | 'session'
  workspace?: string
  category: 'convention' | 'fact' | 'decision' | 'pitfall' | 'lesson'
  tags: string[]
  title: string
  body: string
  created: string
  lastUsed: string
  hitCount: number
  confidence: number
  source?: string
  status: 'raw' | 'distilled' | 'promoted' | 'archived'
  /** 以下为 lesson 类别条目（ErrorLesson）的可选字段，与 wire schema 对齐。 */
  tool?: string
  argsHashPrefix?: string
  errorType?: string
  errorCount?: number
  fix?: string
  relatedSkillId?: string
  archivedFrom?: 'raw' | 'distilled' | 'promoted' | 'archived'
}

/** remember 的 wire 输入。 */
export interface RememberInputView {
  title: string
  body: string
  scope: 'project' | 'global'
  category?: 'convention' | 'fact' | 'decision' | 'pitfall' | 'lesson'
  tags?: string[]
}

/** 「获取知识库」的 wire 结果（对齐宿主 generateResultSchema）。 */
export interface GenerateResultView {
  scanned: number
  generated: number
  skipped: number
  entries: KnowledgeEntryView[]
}

/** 浏览器端 ctx.remote.knowledge 命名空间的方法签名（位置参数，对齐描述符）。
 * 注意：位置参数按描述符**逐位对应**，可选尾参缺省时必须显式传 `undefined`
 * 占位（运行时按参数个数校验，少传即报 "expected N argument(s), got M"）。 */
export interface KnowledgeRemoteApi {
  list(workspace?: string, dir?: string): Promise<RemoteResult<{ entries: KnowledgeEntryView[] }>>
  workspaces(): Promise<RemoteResult<{ workspaces: string[] }>>
  remember(input: RememberInputView, workspace?: string): Promise<RemoteResult<{ id: string }>>
  forget(id: string, workspace?: string): Promise<RemoteResult<{ removed: boolean }>>
  generate(scope: 'project' | 'global', workspace?: string, target?: string): Promise<RemoteResult<GenerateResultView>>
}

/** 取 `ctx.remote` 上的 knowledge 命名空间（mount 后可用）。
 *
 * 不能走 `ctx.remote.knowledge` 的 traceable 路由：那会要求把
 * `remote.knowledge` 声明进 fiber 的 inject，而命名空间由本 entry 自己的
 * `$mount` 提供——声明即死锁（fiber 等待服务 → apply 不跑 → 永不提供）。
 * 故直接从 `ClientRemoteService.namespaces` 内部注册表取（公开类字段，
 * `$mount` 完成后 `namespaces.get('knowledge').service` 带全部远程方法）。 */
export function knowledgeRemoteApi(remote: unknown): KnowledgeRemoteApi {
  const namespaces = (remote as { namespaces?: Map<string, { service?: KnowledgeRemoteApi }> }).namespaces
  const service = namespaces?.get('knowledge')?.service
  if (!service) throw new Error('knowledge remote namespace 尚未就绪（$mount 未完成）')
  return service
}

/** 折叠 RemoteResult：失败分支抛 Error（message 来自宿主业务校验）。 */
export async function unwrap<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  let result: RemoteResult<T>
  try {
    result = await call
  } catch (error) {
    // 装配错误（如实参个数/形状不符）由运行时 reject，而非返回 {ok:false}；
    // 统一折叠为 Error，面板以一致方式展示。
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
