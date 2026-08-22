/**
 * knowledge 客户端 API 封装契约测试：验证 `ctx.remote.knowledge.*` 的
 * **位置参数**调用约定（审查 P0-2 回归防护）。
 */

import { describe, expect, it } from 'vitest'
import { knowledgeRemoteApi, unwrap, type KnowledgeRemoteApi } from '../src/client/api'

function makeFake() {
  const calls: { method: string; args: unknown[] }[] = []
  const ns: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    list: async (...args) => { calls.push({ method: 'list', args }); return { ok: true, value: { entries: [] } } },
    remember: async (...args) => { calls.push({ method: 'remember', args }); return { ok: true, value: { id: 'kb-20260821-001' } } },
    forget: async (...args) => { calls.push({ method: 'forget', args }); return { ok: true, value: { removed: true } } },
    generate: async (...args) => { calls.push({ method: 'generate', args }); return { ok: true, value: { scanned: 2, generated: 1, skipped: 1, entries: [] } } },
    workspaces: async (...args) => { calls.push({ method: 'workspaces', args }); return { ok: true, value: { workspaces: ['/a', '/b'] } } },
  }
  return { calls, api: knowledgeRemoteApi({ namespaces: new Map([['knowledge', { service: ns }]]) }) as KnowledgeRemoteApi }
}

describe('knowledge 客户端 API 位置参数契约', () => {
  it('list 按 [workspace, dir?] 位置传参，缺省显式传 undefined', async () => {
    const { calls, api } = makeFake()
    await api.list('/ws', undefined)
    await api.list(undefined, '/custom')
    expect(calls).toEqual([
      { method: 'list', args: ['/ws', undefined] },
      { method: 'list', args: [undefined, '/custom'] },
    ])
  })

  it('remember 按 [input, workspace?] 位置传参', async () => {
    const { calls, api } = makeFake()
    const input = { title: 't', body: 'b', scope: 'project' as const }
    await api.remember(input, '/ws')
    await api.remember(input)
    expect(calls).toEqual([
      { method: 'remember', args: [input, '/ws'] },
      { method: 'remember', args: [input] },
    ])
  })

  it('forget 按 [id, workspace?] 位置传参', async () => {
    const { calls, api } = makeFake()
    await api.forget('kb-20260821-001', '/ws')
    await api.forget('kb-20260821-002')
    expect(calls).toEqual([
      { method: 'forget', args: ['kb-20260821-001', '/ws'] },
      { method: 'forget', args: ['kb-20260821-002'] },
    ])
  })

  it('generate 按 [scope, workspace?, target?] 位置传参，缺省尾参显式传 undefined', async () => {
    const { calls, api } = makeFake()
    await api.generate('project', '/ws', '/custom')
    await api.generate('global', undefined, undefined)
    expect(calls).toEqual([
      { method: 'generate', args: ['project', '/ws', '/custom'] },
      { method: 'generate', args: ['global', undefined, undefined] },
    ])
  })

  it('workspaces 无位置参数', async () => {
    const { calls, api } = makeFake()
    await api.workspaces()
    expect(calls).toEqual([{ method: 'workspaces', args: [] }])
  })
})
