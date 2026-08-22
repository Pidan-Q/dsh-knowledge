/**
 * LLM 事实提取器（V2）：把扫描到的文件内容送入 ctx.llm，按 JSON Schema
 * 提取结构化事实条目 {title, facts[], tags[]}（知识库思路文档的提取器）。
 *
 * 依赖注入 {@link LlmTextCall}：调用方（host Remote / agent 工具）负责从
 * ctx.llm 组装流式输出为纯文本，便于复用与测试 mock。提取失败的批次跳过
 * 并计数，不影响其他批次。
 */

import { BlockAssembler, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

/** 一条 LLM 提取的结构化事实。 */
export interface ExtractedFact {
  title: string
  facts: string[]
  tags: string[]
}

/** LLM 文本调用：入参为消息数组与 maxTokens，返回组装后的完整文本。 */
export type LlmTextCall = (messages: unknown[], maxTokens: number) => Promise<string>

/** 提取系统提示（与《知识库思路.md》一致）。 */
export const EXTRACT_SYSTEM_PROMPT = [
  '你是一个专业的知识库提取引擎。你的任务是从给定的文本中精准提取事实知识，输出严格的 JSON 格式。',
  '关键原则：',
  '1. 只提取原文中明确存在的事实，绝不添加推断或编造',
  '2. 每条知识独立完整，脱离上下文也能理解',
  '3. 分类必须从给定列表中选择，不能自创',
  '4. 输出必须是合法 JSON',
  '5. 忽略临时性内容（日志、报错、注释、一次性讨论）',
  '6. title 用简洁陈述句，不超过 20 字',
  '7. facts 是 2-5 条独立的事实陈述，每条一句话',
].join('\n')

/** 构造提取消息（system + user 模板）。 */
export function buildExtractMessages(category: string, scope: string, batchText: string): unknown[] {
  const user = [
    `从以下文件内容中提取【${category}】类别的事实知识。`,
    `分类说明：${category}`,
    `scope: ${scope}`,
    '提取规则：',
    '1. 只提取稳定、可复用的事实',
    '2. 每条知识必须能独立理解，不依赖上下文',
    '3. title 简洁，不超过 20 字',
    '4. facts 是 2-5 条独立事实',
    '5. source 填来源文件路径',
    '6. 不要添加原文没有的信息',
    '7. 如果内容里没有该分类的事实，返回 entries: []',
    '',
    '输出 JSON 格式：',
    '{',
    '  "entries": [',
    '    { "title": "HA 服务地址", "facts": ["..."], "tags": ["ha", "deployment"] }',
    '  ]',
    '}',
    '',
    '待提取内容：',
    '---',
    batchText,
    '---',
  ].join('\n')
  return [
    createMessage({
      role: 'system',
      content: [{ type: 'text', text: EXTRACT_SYSTEM_PROMPT }],
      source: { kind: 'plugin', plugin: 'dsh-kb' },
    }),
    createUserMessage({
      content: [{ type: 'text', text: user }],
      source: { kind: 'plugin', plugin: 'dsh-kb' },
    }),
  ]
}

/** 解析 LLM 输出中的 JSON（容忍 ```json 围栏与前后说明文字，兼容 {entries} 或裸数组）。 */
export function parseExtractJson(text: string): ExtractedFact[] {
  // 定位首个 { 或 [ 到末尾 } 或 ]，容忍围栏与前后噪声
  const open = text.search(/[{\[]/)
  if (open === -1) return []
  const close = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (close <= open) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(open, close + 1))
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? (parsed as { entries?: unknown }).entries
      : undefined
  if (!Array.isArray(list)) return []
  const out: ExtractedFact[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const title = typeof rec.title === 'string' ? rec.title.trim() : ''
    const facts = Array.isArray(rec.facts)
      ? rec.facts.filter((f): f is string => typeof f === 'string' && f.trim().length > 0).map((f) => f.trim())
      : []
    const tags = Array.isArray(rec.tags)
      ? rec.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
      : []
    if (title.length === 0 || facts.length === 0) continue
    out.push({ title, facts, tags })
  }
  return out
}

/**
 * 从宿主 ctx 构建 LLM 文本调用（惰性读取：llm 服务或默认模型缺失时返回
 * undefined，调用方决定回退 summary 模式还是报错）。ctx.get 非注入式，
 * 服务缺失不阻塞插件启动。
 */
export function buildLlmCallFromContext(ctx: { get(name: string): unknown }): LlmTextCall | undefined {
  const llm = ctx.get('llm') as
    | { stream(options: Record<string, unknown>): AsyncIterable<unknown> }
    | undefined
  const defaults = ctx.get('agentDefaultModel') as
    | { currentSelection(): { provider?: string; model?: string } }
    | undefined
  if (llm === undefined) return undefined
  const selection = defaults?.currentSelection()
  const provider = selection?.provider
  const model = selection?.model
  if (!provider || !model) return undefined
  return async (messages, maxTokens) => {
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream({
      provider,
      model,
      messages,
      maxTokens,
      purpose: 'knowledge-extract',
    })) {
      assembler.push(chunk as never)
    }
    const text = assembler.blocks().map((block) => ('text' in block ? block.text : '')).join('')
    if (text.trim().length === 0) throw new Error('LLM 提取无输出')
    return text
  }
}
