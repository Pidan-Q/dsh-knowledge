/**
 * KnowledgeService —— DSH 双层知识库的内存服务。
 *
 * 内部使用 @dsh-plugins/shared 的 EntryStore 做磁盘持久化（项目层写入
 * <workspace>/.dsh/knowledge，全局层写入 <dshHome>/knowledge/global），
 * 用 Bm25Index 对全部可见条目做中文/英文混合全文检索。项目根目录默认
 * 通过 findProjectRoot(process.cwd()) 解析。
 */

import {
  Bm25Index,
  EntryStore,
  entryId,
  findProjectRoot,
  type EntryCategory,
  type KnowledgeEntry,
} from '@dsh-plugins/shared'

/** KnowledgeService 构造选项。 */
export interface KnowledgeServiceOptions {
  /** DSH home 目录；缺省时由 EntryStore 解析（$DSH_HOME 或 ~/.dsh）。 */
  dshHome?: string
  /** 是否启用项目层；为 false 时只读写全局层。默认 true。 */
  projectLayer?: boolean
  /** 项目根目录；缺省时由 findProjectRoot(process.cwd()) 解析。 */
  workspace?: string
}

/** 检索选项。 */
export interface SearchOptions {
  /** 限定条目范围；缺省不限定。 */
  scope?: 'project' | 'global' | 'session'
  /** 限定条目分类；缺省不限定。 */
  category?: EntryCategory
  /** 返回的最大命中数；默认 5。 */
  topK?: number
}

/** 一条检索命中。 */
export interface SearchHit {
  /** 命中的知识条目。 */
  entry: KnowledgeEntry
  /** BM25 相关度得分。 */
  score: number
}

/** 生成形如 kb-YYYYMMDD-NNN 的下一个条目 id（按当天已有序号递增）。 */
export function nextEntryId(entries: readonly KnowledgeEntry[], date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const prefix = `kb-${y}${m}${d}-`
  let max = 0
  for (const entry of entries) {
    if (!entry.id.startsWith(prefix)) continue
    const seq = Number(entry.id.slice(prefix.length))
    if (Number.isInteger(seq) && seq > max) max = seq
  }
  return entryId(date, max + 1)
}

/**
 * 双层知识库服务：search / remember / forget / list。
 * 条目在构造与每次写入/删除后从磁盘重载，保证内存索引与持久化一致。
 */
export class KnowledgeService {
  /** 项目根目录（项目层条目的落盘位置）。 */
  readonly workspace: string

  private readonly store: EntryStore
  private readonly projectLayer: boolean
  private entries: KnowledgeEntry[] = []
  private index: Bm25Index<KnowledgeEntry> = new Bm25Index<KnowledgeEntry>([])

  constructor(options: KnowledgeServiceOptions = {}) {
    this.projectLayer = options.projectLayer ?? true
    this.store = new EntryStore(options.dshHome === undefined ? undefined : { dshHome: options.dshHome })
    this.workspace = options.workspace ?? findProjectRoot(process.cwd())
    this.reload()
  }

  /** 从磁盘重载可见条目并重建 BM25 索引。 */
  private reload(): void {
    this.entries = this.store.list(this.projectLayer ? this.workspace : undefined)
    this.index = new Bm25Index(this.entries)
  }

  /**
   * 检索知识库：先按范围与分类过滤，再按 BM25 得分降序返回 topK 条。
   * @param query - 检索关键词（中文按字切分、英文按词切分）。
   * @param options - 范围/分类过滤与返回数量。
   */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const { scope, category, topK = 5 } = options
    const hits = this.index.search(query, {
      topK,
      filter: (entry) => {
        if (scope !== undefined && entry.scope !== scope) return false
        if (category !== undefined && entry.category !== category) return false
        return true
      },
    })
    return hits.map((hit) => ({ entry: hit.doc, score: hit.score }))
  }

  /**
   * 写入一条知识条目并返回其 id。
   * - id 为空时按当天序号自动生成；
   * - created/lastUsed 为空时取当天日期；
   * - 项目范围条目写入项目根目录，项目层被禁用时抛出错误。
   */
  remember(input: KnowledgeEntry): string {
    if (input.scope === 'project' && !this.projectLayer) {
      throw new Error('项目层知识库已禁用，无法写入项目范围的知识条目')
    }
    const today = new Date().toISOString().slice(0, 10)
    const entry: KnowledgeEntry = {
      id: input.id.length > 0 ? input.id : nextEntryId(this.entries),
      scope: input.scope,
      workspace: input.scope === 'project' ? this.workspace : input.workspace,
      category: input.category,
      tags: input.tags,
      title: input.title,
      body: input.body,
      created: input.created.length > 0 ? input.created : today,
      lastUsed: input.lastUsed.length > 0 ? input.lastUsed : today,
      hitCount: input.hitCount,
      confidence: input.confidence,
      status: input.status,
    }
    if (input.source !== undefined) entry.source = input.source
    this.store.write(entry, this.workspace)
    this.reload()
    return entry.id
  }

  /**
   * 删除指定 id 的条目（同时检查全局层与项目层）。
   * @returns 是否实际删除了文件。
   */
  forget(id: string): boolean {
    const removed = this.store.remove(id, this.workspace)
    if (removed === undefined) return false
    this.reload()
    return true
  }

  /** 列出当前可见的全部条目（全局层 + 启用的项目层），按创建时间倒序。 */
  list(): KnowledgeEntry[] {
    return this.entries.slice()
  }
}
