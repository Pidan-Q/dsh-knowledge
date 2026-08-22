/**
 * errata 客户端 API 封装契约测试：验证 `ctx.remote.errata.*` 的**位置参数**
 * 调用约定（审查 P0-1 回归防护）。运行时按描述符参数顺序逐位 parse 并
 * 校验实参个数，因此封装层必须传位置参数，而非 args 对象。
 */

import { describe, expect, it } from 'vitest'
import { errataRemoteApi, unwrap, workspacesOf, type ErrataRemoteApi } from '../src/client/api'

/** 记录调用参数形状的 fake 命名空间（按 ClientRemoteService.namespaces 形态）。 */
function makeFake() {
  const calls: { method: string; args: unknown[] }[] = []
  const ns: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    list: async (...args) => { calls.push({ method: 'list', args }); return { ok: true, value: { lessons: [] } } },
    archive: async (...args) => { calls.push({ method: 'archive', args }); return { ok: true, value: { lesson: null } } },
    unarchive: async (...args) => { calls.push({ method: 'unarchive', args }); return { ok: true, value: { lesson: null } } },
    delete: async (...args) => { calls.push({ method: 'delete', args }); return { ok: true, value: { removed: true } } },
    promote: async (...args) => { calls.push({ method: 'promote', args }); return { ok: true, value: { skillName: 'x' } } },
  }
  return { calls, api: errataRemoteApi({ namespaces: new Map([['errata', { service: ns }]]) }) as ErrataRemoteApi }
}

describe('errata 客户端 API 位置参数契约', () => {
  it('list 传 workspace 为位置参数(缺省时传 undefined)', async () => {
    const { calls, api } = makeFake()
    await api.list('ws1')
    await api.list()
    expect(calls).toEqual([
      { method: 'list', args: ['ws1'] },
      { method: 'list', args: [] },
    ])
  })

  it('archive/unarchive/delete/promote 按 [lessonId, workspace?] 位置传参', async () => {
    const { calls, api } = makeFake()
    await api.archive('id1', 'ws1')
    await api.unarchive('id2')
    await api.delete('id3', 'ws3')
    await api.promote('id4', 'ws4')
    expect(calls).toEqual([
      { method: 'archive', args: ['id1', 'ws1'] },
      { method: 'unarchive', args: ['id2'] },
      { method: 'delete', args: ['id3', 'ws3'] },
      { method: 'promote', args: ['id4', 'ws4'] },
    ])
  })

  it('unwrap 折叠 RemoteResult:ok 分支返回值,error 分支抛 Error', async () => {
    await expect(unwrap(Promise.resolve({ ok: true, value: { lessons: [] } }))).resolves.toEqual({ lessons: [] })
    await expect(unwrap(Promise.resolve({ ok: false, error: { code: 'x', message: '业务拒绝', details: {} } })))
      .rejects.toThrow('业务拒绝')
  })

  it('workspacesOf 去重并排序', () => {
    expect(workspacesOf([
      { workspace: '/b' },
      { workspace: '/a' },
      { workspace: '/b' },
      {},
    ] as never)).toEqual(['/a', '/b'])
  })
})
