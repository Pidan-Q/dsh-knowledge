/**
 * 知识库工具注册：kb_search / kb_remember / kb_forget。
 *
 * 参数校验失败统一抛出 Error（中文信息）；global 范围写入受
 * config.allowGlobalWrite 约束。输出 schema 均为显式对象，render
 * 将结果渲染为模型可见的文本列表。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { EntryCategory, KnowledgeEntry } from './shared/index.js'
import { nextEntryId, type KnowledgeService } from './store.js'

/** 知识条目分类枚举。 */
const CATEGORIES: readonly EntryCategory[] = ['convention', 'fact', 'decision', 'pitfall', 'lesson']

/** 注册三个知识库工具到 ctx.tools。 */
export function registerTools(ctx: Context, service: KnowledgeService, allowGlobalWrite: boolean): void {
  ctx.tools.register(defineTool({
    name: 'kb_search',
    description: '在双层知识库中检索与查询相关的知识条目（对标题与正文做中文/英文 BM25 全文检索）。',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词，支持中文与英文。' },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        default: 'project',
        description: '检索范围：project 为项目层，global 为全局层；默认 project。',
      },
      category: {
        type: 'string',
        enum: CATEGORIES,
        description: '按条目分类过滤；不传则检索全部分类。',
      },
      topK: { type: 'number', default: 5, description: '返回的最大命中数，默认 5。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                category: { type: 'string', required: true },
                score: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.hits.length === 0
          ? '未检索到相关知识条目。'
          : value.hits
            .map((hit, index) =>
              `[${index + 1}] [${hit.category}/${hit.scope}] ${hit.title}（得分 ${hit.score.toFixed(3)}，id=${hit.id}）`)
            .join('\n'),
      }],
    },
    async execute(args) {
      if (args.query.trim().length === 0) {
        throw new Error('kb_search: query 不能为空')
      }
      const topK = args.topK ?? 5
      if (!Number.isInteger(topK) || topK < 1 || topK > 50) {
        throw new Error('kb_search: topK 必须是 1 到 50 之间的整数')
      }
      const hits = service.search(args.query, {
        scope: args.scope ?? 'project',
        category: args.category,
        topK,
      })
      return {
        hits: hits.map((hit) => ({
          id: hit.entry.id,
          title: hit.entry.title,
          scope: hit.entry.scope,
          category: hit.entry.category,
          score: hit.score,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kb_remember',
    description: '向双层知识库写入一条知识条目（标题 + 正文），返回生成的条目 id。',
    parameters: {
      title: { type: 'string', required: true, description: '知识条目标题。' },
      body: { type: 'string', required: true, description: '知识条目正文（Markdown 文本）。' },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        default: 'project',
        description: '写入范围：project 为项目层（默认），global 为全局层（需允许全局写入）。',
      },
      category: {
        type: 'string',
        enum: CATEGORIES,
        default: 'fact',
        description: '条目分类，默认 fact。',
      },
      tags: { type: 'array', items: { type: 'string' }, description: '可选的标签列表。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已写入知识条目 ${value.id}` }],
    },
    async execute(args) {
      if (args.title.trim().length === 0) {
        throw new Error('kb_remember: title 不能为空')
      }
      if (args.body.trim().length === 0) {
        throw new Error('kb_remember: body 不能为空')
      }
      const scope = args.scope ?? 'project'
      if (scope === 'global' && !allowGlobalWrite) {
        throw new Error('kb_remember: 未启用全局写入（allowGlobalWrite=false），不能写入 global 范围的知识条目')
      }
      const tags = (args.tags ?? []).filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
      const entry: KnowledgeEntry = {
        id: nextEntryId(service.list()),
        scope,
        category: args.category ?? 'fact',
        tags,
        title: args.title,
        body: args.body,
        created: '',
        lastUsed: '',
        hitCount: 0,
        confidence: 0.5,
        status: 'raw',
      }
      const id = service.remember(entry)
      return { id }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kb_forget',
    description: '从双层知识库中删除指定 id 的知识条目，返回是否删除成功。',
    parameters: {
      id: { type: 'string', required: true, description: '要删除的知识条目 id。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed ? '已删除该知识条目。' : '未找到该知识条目，未做删除。',
      }],
    },
    async execute(args) {
      if (args.id.trim().length === 0) {
        throw new Error('kb_forget: id 不能为空')
      }
      return { removed: service.forget(args.id) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kb_generate',
    description: '扫描项目/全局范围内的文档与配置文件，生成知识条目写入知识库（总容量上限 50 万字符，分类子目录落盘；幂等：同来源不重复生成）。',
    parameters: {
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        required: true,
        description: 'project 扫工作区文件；global 扫 DSH home 配置与系统源。',
      },
      workspace: {
        type: 'string',
        description: '项目层必填：项目根目录绝对路径（缺省用当前项目根）。',
      },
      categories: {
        type: 'array',
        items: { type: 'string' },
        description: '只扫描指定语义分类（architecture/deployment/devices/conventions/glossary/decisions/environment），缺省全部。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scanned: { type: 'number', required: true },
          generated: { type: 'number', required: true },
          skipped: { type: 'number', required: true },
          byCategory: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                category: { type: 'string', required: true },
                count: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `扫描 ${value.scanned} 个文件，生成 ${value.generated} 条知识条目，跳过 ${value.skipped} 条。`,
          ...value.byCategory.map((item) => `  - ${item.category}: ${String(item.count)} 条`),
        ].join('\n'),
      }],
    },
    async execute(args) {
      const scope = args.scope
      if (scope !== 'project' && scope !== 'global') {
        throw new Error('kb_generate: scope 必须是 project 或 global')
      }
      let ws: string | undefined
      if (scope === 'project') {
        ws = args.workspace !== undefined && args.workspace.trim().length > 0
          ? args.workspace.trim()
          : service.workspace
        if (ws.length === 0) {
          throw new Error('kb_generate: project 扫描需要 workspace')
        }
      }
      const result = service.generate(scope, ws, undefined, args.categories)
      const byCategory: { category: string; count: number }[] = []
      const counts = new Map<string, number>()
      for (const entry of result.entries) {
        const semantic = entry.tags[0] ?? entry.category
        counts.set(semantic, (counts.get(semantic) ?? 0) + 1)
      }
      for (const [category, count] of counts) byCategory.push({ category, count })
      return {
        scanned: result.scanned,
        generated: result.generated,
        skipped: result.skipped,
        byCategory,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kb_list',
    description: '列出知识库条目（可限定范围与语义分类），返回标题/id 清单。',
    parameters: {
      scope: {
        type: 'string',
        enum: ['project', 'global', 'all'],
        default: 'all',
        description: 'project 只列项目层；global 只列全局层；all 全部。',
      },
      category: {
        type: 'string',
        description: '按语义分类过滤（architecture/deployment/environment 等）。',
      },
      limit: { type: 'number', default: 50, description: '最多返回多少条，默认 50。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                category: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.entries.length === 0
          ? '知识库暂无条目。'
          : [`共 ${value.total} 条，列出 ${value.entries.length} 条：`]
            .concat(value.entries.map((entry) => `- [${entry.category}/${entry.scope}] ${entry.title} (${entry.id})`))
            .join('\n'),
      }],
    },
    async execute(args) {
      const scope = (args.scope ?? 'all') as 'project' | 'global' | 'all'
      const entries = service.listEntries(scope, args.category)
      const limit = Math.max(1, Math.min(args.limit ?? 50, 200))
      return {
        total: entries.length,
        entries: entries.slice(0, limit).map((entry) => ({
          id: entry.id,
          title: entry.title,
          scope: entry.scope,
          category: entry.tags[0] ?? entry.category,
        })),
      }
    },
  }))
}
