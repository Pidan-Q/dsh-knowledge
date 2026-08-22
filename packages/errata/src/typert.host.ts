/**
 * errata 宿主面 Typert manifest（手写，对齐 @deepseek-ai/dsh-typert-generator
 * 的生成格式；迁入官方仓库后可切换为构建期生成产物）。
 *
 * 由 typert-loader 扫描包 `./typert` 导出注册到 `ctx.typert`，与
 * `ErrataRemoteService` 的 Cordis service key（`errata`）配对，
 * 浏览器端经 `ctx.remote.errata.*` 调用。所有 codec 均为 strict + zod v4。
 */

import { z } from 'zod'

/** ErrorLesson 的 wire 形状（与 shared/schema.ts 的 ErrorLesson 对齐）。 */
const lessonSchema = z.object({
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

/** 可选 json 参数（wire 缺失解码为 undefined）。 */
const workspaceParam = {
  name: 'workspace',
  wire: 'workspace',
  source: 'json' as const,
  codec: { mode: 'strict' as const, typeSymbol: '@dsh-plugins/errata#workspace', schema: z.string().optional() },
  acceptsUndefined: true as const,
}

const lessonIdParam = {
  name: 'lessonId',
  wire: 'lessonId',
  source: 'json' as const,
  codec: { mode: 'strict' as const, typeSymbol: '@dsh-plugins/errata#lessonId', schema: z.string() },
}

export const TYPERT = {
  package: '@dsh-plugins/errata',
  face: 'host' as const,
  schemas: [],
  invocations: [
    {
      id: '@dsh-plugins/errata#errata/list',
      service: 'errata',
      namespace: 'errata',
      method: 'list',
      invocation: { kind: 'direct' as const },
      parameters: [workspaceParam],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@dsh-plugins/errata#errata/list:result',
        schema: listResultSchema,
      },
      sourceLocation: { file: 'packages/errata/src/remote.ts', line: 63, column: 3 },
    },
    {
      id: '@dsh-plugins/errata#errata/archive',
      service: 'errata',
      namespace: 'errata',
      method: 'archive',
      invocation: { kind: 'direct' as const },
      parameters: [lessonIdParam, workspaceParam],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@dsh-plugins/errata#errata/archive:result',
        schema: lessonResultSchema,
      },
      sourceLocation: { file: 'packages/errata/src/remote.ts', line: 69, column: 3 },
    },
    {
      id: '@dsh-plugins/errata#errata/unarchive',
      service: 'errata',
      namespace: 'errata',
      method: 'unarchive',
      invocation: { kind: 'direct' as const },
      parameters: [lessonIdParam, workspaceParam],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@dsh-plugins/errata#errata/unarchive:result',
        schema: lessonResultSchema,
      },
      sourceLocation: { file: 'packages/errata/src/remote.ts', line: 77, column: 3 },
    },
    {
      id: '@dsh-plugins/errata#errata/delete',
      service: 'errata',
      namespace: 'errata',
      method: 'delete',
      invocation: { kind: 'direct' as const },
      parameters: [lessonIdParam, workspaceParam],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@dsh-plugins/errata#errata/delete:result',
        schema: removeResultSchema,
      },
      sourceLocation: { file: 'packages/errata/src/remote.ts', line: 85, column: 3 },
    },
    {
      id: '@dsh-plugins/errata#errata/promote',
      service: 'errata',
      namespace: 'errata',
      method: 'promote',
      invocation: { kind: 'direct' as const },
      parameters: [lessonIdParam, workspaceParam],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@dsh-plugins/errata#errata/promote:result',
        schema: promoteResultSchema,
      },
      sourceLocation: { file: 'packages/errata/src/remote.ts', line: 97, column: 3 },
    },
  ],
  model: {
    services: [],
    events: [],
    objects: [],
  },
}
