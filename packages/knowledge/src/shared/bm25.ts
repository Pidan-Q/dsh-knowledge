/**
 * Lightweight BM25-style retrieval over knowledge entries.
 * Zero dependencies: tokenises (CJK-aware) at query time and
 * scores documents by term frequency / inverse document frequency.
 */

export interface SearchHit<T> {
  readonly doc: T
  readonly score: number
}

const CJK_RE = /[\u4e00-\u9fff]/g
const WORD_RE = /[A-Za-z0-9_]+/g
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'this', 'that', 'be', 'by', 'at', 'from', 'as', 'it', 'its', 'was', 'were',
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上',
  '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己',
])

/** Tokenise mixed Chinese/English text. CJK runs are emitted per character. */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const m of text.matchAll(CJK_RE)) tokens.push(m[0])
  for (const m of text.matchAll(WORD_RE)) tokens.push(m[0].toLowerCase())
  return tokens.filter((t) => t.length > 0 && !STOP_WORDS.has(t))
}

const K1 = 1.2
const B = 0.75

/** BM25 index over a static corpus. */
export class Bm25Index<T extends { id: string }> {
  private readonly docs: T[] = []
  private readonly freq = new Map<string, Map<number, number>>()
  private readonly docLen: number[] = []
  private readonly idToIndex = new Map<string, number>()
  private avgLen = 0

  constructor(docs: readonly T[], private readonly fields: readonly (keyof T)[] = ['title', 'body'] as never) {
    for (const doc of docs) this.add(doc)
  }

  add(doc: T): void {
    const index = this.docs.length
    this.docs.push(doc)
    this.idToIndex.set(doc.id, index)
    let len = 0
    const seen = new Set<string>()
    for (const field of this.fields) {
      const value = doc[field]
      if (typeof value !== 'string') continue
      for (const token of tokenize(value)) {
        len += 1
        if (seen.has(token)) continue
        seen.add(token)
        let map = this.freq.get(token)
        if (!map) {
          map = new Map()
          this.freq.set(token, map)
        }
        map.set(index, (map.get(index) ?? 0) + 1)
      }
    }
    this.docLen.push(len)
    this.avgLen = this.docLen.reduce((a, b) => a + b, 0) / Math.max(1, this.docLen.length)
  }

  private df(token: string): number {
    return this.freq.get(token)?.size ?? 0
  }

  /** Score one document against a query token list. */
  private score(queryTokens: string[], index: number): number {
    const len = this.docLen[index] ?? 0
    const n = this.docs.length
    let score = 0
    const qf = new Map<string, number>()
    for (const t of queryTokens) qf.set(t, (qf.get(t) ?? 0) + 1)
    for (const [token, q] of qf) {
      const df = this.df(token)
      if (df === 0) continue
      const tf = this.freq.get(token)?.get(index) ?? 0
      if (tf === 0) continue
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      const denom = tf + K1 * (1 - B + (B * len) / Math.max(1, this.avgLen))
      score += idf * ((tf * (K1 + 1)) / denom) * q
    }
    return score
  }

  /**
   * Search the corpus. When `filter` is provided it is applied
   * before scoring. Results are sorted by score descending.
   */
  search(query: string, opts: { topK?: number; filter?: (doc: T) => boolean } = {}): SearchHit<T>[] {
    const { topK = 5, filter } = opts
    const tokens = tokenize(query)
    if (tokens.length === 0) return []
    const hits: SearchHit<T>[] = []
    for (let i = 0; i < this.docs.length; i += 1) {
      const doc = this.docs[i]!
      if (filter && !filter(doc)) continue
      const score = this.score(tokens, i)
      if (score > 0) hits.push({ doc, score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, Math.max(1, topK))
  }

  get size(): number {
    return this.docs.length
  }
}

/** Compute a short stable hash prefix from tool arguments. */
export function argsHashPrefix(args: unknown, len = 8): string {
  let json = ''
  try {
    json = JSON.stringify(args ?? {})
  } catch {
    json = String(args)
  }
  let h = 0
  for (let i = 0; i < json.length; i += 1) {
    h = (Math.imul(h, 31) + json.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36).padStart(len, '0').slice(0, len)
}

/** Normalise a tool/error signature into a stable match key. */
export function patternKey(tool: string, errorType: string): string {
  return `${tool}::${errorType}`
}
