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
}
