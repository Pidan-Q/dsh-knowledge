/**
 * knowledge 客户端面 Typert Remote 描述符（手写，对齐官方生成格式）。
 * 客户端 `apply` 里经 `ctx.remote.$mount(TYPERT_REMOTE)` 注册后，
 * `ctx.remote.knowledge.*` 命名空间可用。codec 与宿主 manifest 一致
 * （strict + zod v4）。
 */

import { z } from 'zod'

/** KnowledgeEntry 的 wire 形状（与宿主 manifest / shared/schema.ts 对齐）。 */
export const entrySchema = z.object({
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
  tool: z.string().optional(),
  argsHashPrefix: z.string().optional(),
  errorType: z.string().optional(),
  errorCount: z.number().optional(),
  fix: z.string().optional(),
  relatedSkillId: z.string().optional(),
  archivedFrom: z.enum(['raw', 'distilled', 'promoted', 'archived']).optional(),
})

const listResultSchema = z.object({ entries: z.array(entrySchema) })
const rememberResultSchema = z.object({ id: z.string() })
const forgetResultSchema = z.object({ removed: z.boolean() })
const workspacesResultSchema = z.object({ workspaces: z.array(z.string()) })
const generateResultSchema = z.object({
  scanned: z.number(),
  generated: z.number(),
  skipped: z.number(),
  entries: z.array(entrySchema),
})

const rememberInputSchema = z.object({
  title: z.string(),
  body: z.string(),
  scope: z.enum(['project', 'global']),
  category: z.enum(['convention', 'fact', 'decision', 'pitfall', 'lesson']).optional(),
  tags: z.array(z.string()).optional(),
})

const workspaceParam = {
  name: 'workspace',
  wire: 'workspace',
  source: 'json' as const,
  codec: { mode: 'strict' as const, typeSymbol: '@dsh-plugins/knowledge#workspace', schema: z.string().optional() },
  acceptsUndefined: true as const,
}

const scopeParam = {
  name: 'scope',
  wire: 'scope',
  source: 'json' as const,
  codec: {
    mode: 'strict' as const,
    typeSymbol: '@dsh-plugins/knowledge#scope',
    schema: z.enum(['project', 'global']),
  },
}

const dirParam = {
  name: 'dir',
  wire: 'dir',
  source: 'json' as const,
  codec: { mode: 'strict' as const, typeSymbol: '@dsh-plugins/knowledge#dir', schema: z.string().optional() },
  acceptsUndefined: true as const,
}

const targetParam = {
  name: 'target',
  wire: 'target',
  source: 'json' as const,
  codec: { mode: 'strict' as const, typeSymbol: '@dsh-plugins/knowledge#target', schema: z.string().optional() },
  acceptsUndefined: true as const,
}

const idParam = {
  name: 'id',
  wire: 'id',
  source: 'json' as const,
  codec: { mode: 'strict' as const, typeSymbol: '@dsh-plugins/knowledge#id', schema: z.string() },
}

const inputParam = {
  name: 'input',
  wire: 'input',
  source: 'json' as const,
  codec: { mode: 'strict' as const, typeSymbol: '@dsh-plugins/knowledge#remember:input', schema: rememberInputSchema },
}

export const TYPERT_REMOTE = {
  package: '@dsh-plugins/knowledge',
  descriptors: [
    {
      id: '@dsh-plugins/knowledge#knowledge/list',
      service: 'knowledge',
      namespace: 'knowledge',
      method: 'list',
      invocation: { kind: 'direct' as const },
      parameters: [workspaceParam, dirParam],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@dsh-plugins/knowledge#knowledge/list:result',
        schema: listResultSchema,
      },
      sourceLocation: { file: 'packages/knowledge/src/remote.ts', line: 76, column: 3 },
    },
    {
      id: '@dsh-plugins/knowledge#knowledge/remember',
      service: 'knowledge',
      namespace: 'knowledge',
      method: 'remember',
      invocation: { kind: 'direct' as const },
      parameters: [inputParam, workspaceParam],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@dsh-plugins/knowledge#knowledge/remember:result',
        schema: rememberResultSchema,
      },
      sourceLocation: { file: 'packages/knowledge/src/remote.ts', line: 85, column: 3 },
    },
    {
      id: '@dsh-plugins/knowledge#knowledge/forget',
      service: 'knowledge',
      namespace: 'knowledge',
      method: 'forget',
      invocation: { kind: 'direct' as const },
      parameters: [idParam, workspaceParam],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@dsh-plugins/knowledge#knowledge/forget:result',
        schema: forgetResultSchema,
      },
      sourceLocation: { file: 'packages/knowledge/src/remote.ts', line: 122, column: 3 },
    },
    {
      id: '@dsh-plugins/knowledge#knowledge/generate',
      service: 'knowledge',
      namespace: 'knowledge',
      method: 'generate',
      invocation: { kind: 'direct' as const },
      parameters: [scopeParam, workspaceParam, targetParam],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@dsh-plugins/knowledge#knowledge/generate:result',
        schema: generateResultSchema,
      },
      sourceLocation: { file: 'packages/knowledge/src/remote.ts', line: 142, column: 3 },
    },
    {
      id: '@dsh-plugins/knowledge#knowledge/workspaces',
      service: 'knowledge',
      namespace: 'knowledge',
      method: 'workspaces',
      invocation: { kind: 'direct' as const },
      parameters: [],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@dsh-plugins/knowledge#knowledge/workspaces:result',
        schema: workspacesResultSchema,
      },
      sourceLocation: { file: 'packages/knowledge/src/remote.ts', line: 88, column: 3 },
    },
  ],
}

export default TYPERT_REMOTE
