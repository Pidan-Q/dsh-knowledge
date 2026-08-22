/**
 * LLM 事实提取器测试：JSON 解析容错、消息构造、提取失败容错。
 */

import { describe, expect, it } from 'vitest'
import { buildExtractMessages, parseExtractJson } from '../src/extractor'

describe('parseExtractJson', () => {
  it('解析 {entries} 结构', () => {
    const text = JSON.stringify({
      entries: [
        { title: 'HA 服务地址', facts: ['运行在 8123 端口'], tags: ['ha'] },
        { title: '部署方式', facts: ['使用 docker compose', '容器名 homeassistant'], tags: ['deployment'] },
      ],
    })
    const facts = parseExtractJson(text)
    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({ title: 'HA 服务地址', tags: ['ha'] })
    expect(facts[1]!.facts).toHaveLength(2)
  })

  it('容忍 ```json 围栏与前后噪声', () => {
    const text = '好的，以下是提取结果：\n```json\n{"entries":[{"title":"t","facts":["f1"],"tags":[]}]}\n```\n以上。'
    expect(parseExtractJson(text)).toHaveLength(1)
  })

  it('兼容裸数组', () => {
    expect(parseExtractJson('[{"title":"t","facts":["f"],"tags":[]}]')).toHaveLength(1)
  })

  it('非法 JSON / 空 entries 返回空数组（批次容错）', () => {
    expect(parseExtractJson('not json')).toEqual([])
    expect(parseExtractJson('{"entries":[]}')).toEqual([])
    expect(parseExtractJson('')).toEqual([])
  })

  it('过滤缺 title 或 facts 的空条目', () => {
    const text = JSON.stringify({ entries: [
      { title: '', facts: ['f'] },
      { title: 'ok', facts: [] },
      { title: 'good', facts: ['f1'] },
    ] })
    const facts = parseExtractJson(text)
    expect(facts).toHaveLength(1)
    expect(facts[0]!.title).toBe('good')
  })
})

describe('buildExtractMessages', () => {
  it('构造 system + user 两条消息，含分类与待提取内容', () => {
    const messages = buildExtractMessages('architecture', 'project', '示例内容')
    expect(messages).toHaveLength(2)
    const system = messages[0] as { role?: string; content?: { type: string; text: string }[] }
    const user = messages[1] as { role?: string; content?: { type: string; text: string }[] }
    expect(system.role).toBe('system')
    expect(user.role).toBe('user')
    const userText = user.content?.[0]?.text ?? ''
    expect(userText).toContain('architecture')
    expect(userText).toContain('示例内容')
    expect(userText).toContain('entries')
  })
})
