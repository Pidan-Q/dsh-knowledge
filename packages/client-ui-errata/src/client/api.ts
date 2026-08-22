/**
 * 错题面板共享的 wire 类型与 Remote 调用封装。
 *
 * 客户端包不依赖宿主包（@dsh-plugins/errata）——浏览器 bundle 不能携带
 * 宿主代码；wire 类型在此与宿主 manifest / shared/schema.ts 对齐手写。
 *
 * 调用约定：`ctx.remote.errata.*` 是**位置参数**方法（与官方用法
 * `ctx.remote.commands.execute(sessionId, line, [])` 一致；运行时按
 * 描述符参数顺序逐位 parse 并校验实参个数）。因此这里的方法签名直接
 * 使用位置参数，与描述符 parameters 顺序一一对应。
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** 错题条目的 wire 形状（对齐 shared/schema.ts 的 ErrorLesson）。 */
export interface ErrataLessonView {
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
  tool: string
  argsHashPrefix: string
  errorType: string
  errorCount: number
  fix?: string
  relatedSkillId?: string
  archivedFrom?: 'raw' | 'distilled' | 'promoted' | 'archived'
}

/** 浏览器端 ctx.remote.errata 命名空间的方法签名（位置参数，对齐描述符）。 */
export interface ErrataRemoteApi {
  list(workspace?: string): Promise<RemoteResult<{ lessons: ErrataLessonView[] }>>
  archive(lessonId: string, workspace?: string): Promise<RemoteResult<{ lesson: ErrataLessonView }>>
  unarchive(lessonId: string, workspace?: string): Promise<RemoteResult<{ lesson: ErrataLessonView }>>
  delete(lessonId: string, workspace?: string): Promise<RemoteResult<{ removed: true }>>
  promote(lessonId: string, workspace?: string): Promise<RemoteResult<{ skillName: string; file?: unknown }>>
}

/** 取 `ctx.remote` 上的 errata 命名空间（mount 后可用）。
 *
 * 不能走 `ctx.remote.errata` 的 traceable 路由：那会要求把 `remote.errata`
 * 声明进 fiber 的 inject，而命名空间由本 entry 自己的 `$mount` 提供——
 * 声明即死锁（fiber 等待服务 → apply 不跑 → 永不提供）。故直接从
 * `ClientRemoteService.namespaces` 内部注册表取（公开类字段，`$mount`
 * 完成后 `namespaces.get('errata').service` 带全部远程方法）。 */
export function errataRemoteApi(remote: unknown): ErrataRemoteApi {
  const namespaces = (remote as { namespaces?: Map<string, { service?: ErrataRemoteApi }> }).namespaces
  const service = namespaces?.get('errata')?.service
  if (!service) throw new Error('errata remote namespace 尚未就绪（$mount 未完成）')
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

/** 从条目集合提取去重后的 workspace 列表（用于面板工作区选择）。 */
export function workspacesOf(lessons: readonly ErrataLessonView[]): string[] {
  const seen = new Set<string>()
  for (const lesson of lessons) {
    if (lesson.workspace !== undefined && lesson.workspace.length > 0) seen.add(lesson.workspace)
  }
  return [...seen].sort()
}
