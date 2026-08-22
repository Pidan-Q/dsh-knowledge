/**
 * 知识注入测试：buildKnowledgeIndex 纯函数 + agent/created 注入监听。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { KnowledgeEntry } from '../src/shared/index.js'
import { buildKnowledgeIndex, registerInjection } from '../src/inject'

const entry = (over: Partial<KnowledgeEntry>): KnowledgeEntry => ({
  id: 'kb-20260822-001', scope: 'project', category: 'fact', tags: [],
  title: '标题', body: '正文', created: '2026-08-22', lastUsed: '2026-08-22',
  hitCount: 0, confidence: 0.6, status: 'raw',
  ...over,
})

describe('buildKnowledgeIndex', () => {
  it('按 scope 分组列出标题并附使用提示', () => {
    const text = buildKnowledgeIndex([
      entry({ id: 'kb-1', scope: 'project', title: 'pnpm 约定', category: 'convention' }),
      entry({ id: 'kb-2', scope: 'global', title: 'DSH 默认 home', category: 'fact' }),
    ])
    expect(text).toContain('项目知识库（1 条')
    expect(text).toContain('- [convention] pnpm 约定')
    expect(text).toContain('全局知识库（1 条')
    expect(text).toContain('- [fact] DSH 默认 home')
    expect(text).toContain('kb_search')
  })

  it('空知识库返回空串', () => {
    expect(buildKnowledgeIndex([])).toBe('')
  })

  it('max 截断并保留总数', () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry({ id: `kb-${i}`, title: `t${i}` }))
    const text = buildKnowledgeIndex(entries, 2)
    expect(text).toContain('项目知识库（5 条，列出 2 条）')
    expect(text).toContain('- [fact] t0')
    expect(text).toContain('- [fact] t1')
    expect(text).not.toContain('t2')
  })
})

describe('registerInjection', () => {
  it('agent/created 时注入索引', () => {
    const ctx = new Context()
    const injected: string[] = []
    registerInjection(ctx, { list: () => [entry({ id: 'kb-9', title: '索引条目' })] }, {
      injections: [], injectKnowledgeIndex: true, injectKnowledgeMax: 10,
    })
    ctx.emit('agent/created', { agent: { inject: (msg: { content: { type: string; text: string }[] }) => {
      injected.push(msg.content[0]!.text)
    } } })
    expect(injected.length).toBe(1)
    expect(injected[0]).toContain('索引条目')
    expect(injected[0]).toContain('kb_search')
  })

  it('两者皆空时不订阅（emit 不抛错、不注入）', () => {
    const ctx = new Context()
    const injected: string[] = []
    registerInjection(ctx, { list: () => [] }, { injections: [], injectKnowledgeIndex: false, injectKnowledgeMax: 10 })
    ctx.emit('agent/created', { agent: { inject: () => injected.push('x') } })
    expect(injected).toEqual([])
  })
})
