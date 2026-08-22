/**
 * errata 客户端面 Typert Remote 描述符（手写，对齐官方生成格式）。
 * 客户端 `apply` 里经 `ctx.remote.$mount(TYPERT_REMOTE)` 注册后，
 * `ctx.remote.errata.*` 命名空间可用。codec 与宿主 manifest 一致
 * （strict + zod v4）。
 */

import { z } from 'zod'

/** ErrorLesson 的 wire 形状（与宿主 manifest / shared/schema.ts 对齐）。 */
export const lessonSchema = z.object({
  id: z.string(),
  scope: z.enum(['project', 'global', 'session']),
  workspace: z.string().optional(),
  category: z.enum(['convention', 'fact', 'decision', 'pitfall', 'lesson']),
  tags: z.array(z.string()),
  title: z.string(),
  body: z.string(),
  created: z.string(),
  lastUsed: z.string(),
  hitCount: z.number(),
  confidence: z.number(),
  source: z.string().optional(),
  status: z.enum(['raw', 'distilled', 'promoted', 'archived']),
  tool: z.string(),
  argsHashPrefix: z.string(),
  errorType: z.string(),
  errorCount: z.number(),
  fix: z.string().optional(),
  relatedSkillId: z.string().optional(),
  archivedFrom: z.enum(['raw', 'distilled', 'promoted', 'archived']).optional(),
})

const listResultSchema = z.object({ lessons: z.array(lessonSchema) })
const lessonResultSchema = z.object({ lesson: lessonSchema })
const removeResultSchema = z.object({ removed: z.literal(true) })
const promoteResultSchema = z.object({ skillName: z.string(), file: z.unknown().optional() })

const workspaceParam = {
  name: 'workspace',
  wire: 'workspace',
  source: 'json' as const,
  codec: { mode: 'strict' as const, typeSymbol: '@dsh-knowledge/errata#workspace', schema: z.string().optional() },
  acceptsUndefined: true as const,
}

const lessonIdParam = {
  name: 'lessonId',
  wire: 'lessonId',
  source: 'json' as const,
  codec: { mode: 'strict' as const, typeSymbol: '@dsh-knowledge/errata#lessonId', schema: z.string() },
}

export const TYPERT_REMOTE = {
  package: '@dsh-knowledge/errata',
  descriptors: [
    {
      id: '@dsh-knowledge/errata#errata/list',
      service: 'errata',
      namespace: 'errata',
      method: 'list',
      invocation: { kind: 'direct' as const },
      parameters: [workspaceParam],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@dsh-knowledge/errata#errata/list:result',
        schema: listResultSchema,
      },
      sourceLocation: { file: 'packages/errata/src/remote.ts', line: 63, column: 3 },
    },
    {
      id: '@dsh-knowledge/errata#errata/archive',
      service: 'errata',
      namespace: 'errata',
      method: 'archive',
      invocation: { kind: 'direct' as const },
      parameters: [lessonIdParam, workspaceParam],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@dsh-knowledge/errata#errata/archive:result',
        schema: lessonResultSchema,
      },
      sourceLocation: { file: 'packages/errata/src/remote.ts', line: 69, column: 3 },
    },
    {
      id: '@dsh-knowledge/errata#errata/unarchive',
      service: 'errata',
      namespace: 'errata',
      method: 'unarchive',
      invocation: { kind: 'direct' as const },
      parameters: [lessonIdParam, workspaceParam],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@dsh-knowledge/errata#errata/unarchive:result',
        schema: lessonResultSchema,
      },
      sourceLocation: { file: 'packages/errata/src/remote.ts', line: 77, column: 3 },
    },
    {
      id: '@dsh-knowledge/errata#errata/delete',
      service: 'errata',
      namespace: 'errata',
      method: 'delete',
      invocation: { kind: 'direct' as const },
      parameters: [lessonIdParam, workspaceParam],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@dsh-knowledge/errata#errata/delete:result',
        schema: removeResultSchema,
      },
      sourceLocation: { file: 'packages/errata/src/remote.ts', line: 85, column: 3 },
    },
    {
      id: '@dsh-knowledge/errata#errata/promote',
      service: 'errata',
      namespace: 'errata',
      method: 'promote',
      invocation: { kind: 'direct' as const },
      parameters: [lessonIdParam, workspaceParam],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@dsh-knowledge/errata#errata/promote:result',
        schema: promoteResultSchema,
      },
      sourceLocation: { file: 'packages/errata/src/remote.ts', line: 97, column: 3 },
    },
  ],
}

export default TYPERT_REMOTE
