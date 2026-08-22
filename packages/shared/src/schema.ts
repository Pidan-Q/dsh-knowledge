/**
 * Shared entry schema for DSH knowledge / errata plugins.
 * Entries are stored as Markdown files with YAML frontmatter,
 * structurally aligned with DSH SKILL.md so entries can be
 * promoted to skills without format conversion.
 */

export type EntryScope = 'project' | 'global' | 'session'
export type EntryCategory = 'convention' | 'fact' | 'decision' | 'pitfall' | 'lesson'
export type EntryStatus = 'raw' | 'distilled' | 'promoted' | 'archived'

export interface KnowledgeEntry {
  id: string
  scope: EntryScope
  workspace?: string
  category: EntryCategory
  tags: string[]
  title: string
  body: string
  created: string
  lastUsed: string
  hitCount: number
  confidence: number
  source?: string
  status: EntryStatus
}

export interface ErrorLesson extends KnowledgeEntry {
  category: 'lesson'
  tool: string
  argsHashPrefix: string
  errorType: string
  errorCount: number
  fix?: string
  relatedSkillId?: string
  /** 归档前的原状态；仅已归档条目存在。取消归档（反悔）时恢复该状态。 */
  archivedFrom?: EntryStatus
}

export const isErrorLesson = (entry: KnowledgeEntry): entry is ErrorLesson =>
  entry.category === 'lesson'

export interface EntryFrontmatter {
  id?: unknown
  scope?: unknown
  workspace?: unknown
  category?: unknown
  tags?: unknown
  title?: unknown
  created?: unknown
  last_used?: unknown
  hit_count?: unknown
  confidence?: unknown
  source?: unknown
  status?: unknown
  tool?: unknown
  args_hash_prefix?: unknown
  error_type?: unknown
  error_count?: unknown
  fix?: unknown
  related_skill_id?: unknown
  archived_from?: unknown
}

const SCOPES: readonly string[] = ['project', 'global', 'session']
const CATEGORIES: readonly string[] = ['convention', 'fact', 'decision', 'pitfall', 'lesson']
const STATUSES: readonly string[] = ['raw', 'distilled', 'promoted', 'archived']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.length > 0 ? v : fallback)
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Entry id pattern: kb-YYYYMMDD-NNN */
export const ENTRY_ID_PATTERN = /^kb-\d{8}-\d{3,}$/

export function isEntryId(value: string): boolean {
  return ENTRY_ID_PATTERN.test(value)
}

/** Generate the next entry id for a given day and sequence. */
export function entryId(date = new Date(), seq = 1): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `kb-${y}${m}${d}-${String(seq).padStart(3, '0')}`
}

/** Serialize an entry into frontmatter + body markdown text. */
export function serializeEntry(entry: KnowledgeEntry): string {
  const fm: EntryFrontmatter = {
    id: entry.id,
    scope: entry.scope,
    created: entry.created,
    last_used: entry.lastUsed,
    hit_count: entry.hitCount,
    confidence: entry.confidence,
    status: entry.status,
  }
  if (entry.workspace !== undefined) fm.workspace = entry.workspace
  if (entry.category !== 'fact') fm.category = entry.category
  if (entry.tags.length > 0) fm.tags = entry.tags
  if (entry.title !== entry.id) fm.title = entry.title
  if (entry.source !== undefined) fm.source = entry.source
  if (isErrorLesson(entry)) {
    fm.tool = entry.tool
    fm.args_hash_prefix = entry.argsHashPrefix
    fm.error_type = entry.errorType
    fm.error_count = entry.errorCount
    if (entry.fix !== undefined) fm.fix = entry.fix
    if (entry.relatedSkillId !== undefined) fm.related_skill_id = entry.relatedSkillId
    if (entry.archivedFrom !== undefined) fm.archived_from = entry.archivedFrom
  }
  const lines = ['---']
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) continue
    lines.push(`${key}: ${formatYamlValue(value)}`)
  }
  lines.push('---', '', entry.body.trimEnd(), '')
  return lines.join('\n')
}

function formatYamlValue(value: unknown): string {
  if (typeof value === 'string') {
    if (/^[A-Za-z0-9_./:\-]+$/.test(value)) return value
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))))
  }
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * Parse frontmatter + body text back into a KnowledgeEntry.
 * Unknown or malformed fields are dropped; required fields are
 * validated and the entry is rejected (returns undefined) when
 * the id is missing or malformed.
 */
export function parseEntry(text: string): KnowledgeEntry | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.trimStart())
  if (!m) return undefined
  const fm = parseFrontmatter(m[1]!)
  if (!isRecord(fm)) return undefined
  const id = str(fm.id, '')
  if (!isEntryId(id)) return undefined
  const scope = str(fm.scope, 'project')
  const category = str(fm.category, 'fact')
  if (!SCOPES.includes(scope) || !CATEGORIES.includes(category)) return undefined
  const status = str(fm.status, 'raw')
  if (!STATUSES.includes(status)) return undefined
  const body = (m[2] ?? '').trim()
  const base: KnowledgeEntry = {
    id,
    scope: scope as EntryScope,
    category: category as EntryCategory,
    tags: Array.isArray(fm.tags) ? fm.tags.filter((t): t is string => typeof t === 'string') : [],
    title: str(fm.title, id),
    body,
    created: str(fm.created, new Date().toISOString().slice(0, 10)),
    lastUsed: str(fm.last_used, str(fm.created, new Date().toISOString().slice(0, 10))),
    hitCount: Math.max(0, Math.floor(num(fm.hit_count, 0))),
    confidence: Math.min(1, Math.max(0, num(fm.confidence, 0.5))),
    status: status as EntryStatus,
  }
  if (typeof fm.workspace === 'string' && fm.workspace.length > 0) base.workspace = fm.workspace
  if (typeof fm.source === 'string' && fm.source.length > 0) base.source = fm.source
  if (category === 'lesson') {
    const tool = str(fm.tool, '')
    const errorType = str(fm.error_type, '')
    if (!tool || !errorType) return undefined
    const lesson: ErrorLesson = {
      ...base,
      category: 'lesson',
      tool,
      argsHashPrefix: str(fm.args_hash_prefix, ''),
      errorType,
      errorCount: Math.max(1, Math.floor(num(fm.error_count, 1))),
    }
    if (typeof fm.fix === 'string' && fm.fix.length > 0) lesson.fix = fm.fix
    if (typeof fm.related_skill_id === 'string' && fm.related_skill_id.length > 0) lesson.relatedSkillId = fm.related_skill_id
    if (typeof fm.archived_from === 'string' && STATUSES.includes(fm.archived_from)) {
      lesson.archivedFrom = fm.archived_from as EntryStatus
    }
    return lesson
  }
  return base
}

/** Minimal YAML frontmatter parser (scalar, list-of-scalars, nested objects). */
function parseFrontmatter(text: string): unknown {
  const root: Record<string, unknown> = {}
  const lines = text.split(/\r?\n/)
  let current: Record<string, unknown> | undefined
  let currentKey = ''
  const getTarget = (): Record<string, unknown> => current ?? root
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) {
      current = undefined
      currentKey = ''
    }
    const listMatch = /^(\s*)- (.+)$/.exec(line)
    if (listMatch) {
      const target = current ?? root
      const list = Array.isArray(target[currentKey]) ? target[currentKey] : undefined
      const arr = (list as unknown[] | undefined) ?? []
      if (!Array.isArray(target[currentKey])) {
        target[currentKey] = arr
      }
      arr.push(parseScalar(listMatch[2]!))
      continue
    }
    const keyMatch = /^(\s*)([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line)
    if (keyMatch) {
      const key = keyMatch[2]!
      const value = keyMatch[3]
      currentKey = key
      if (value === undefined || value.trim() === '') {
        const nested: Record<string, unknown> = {}
        getTarget()[key] = nested
        current = nested
      } else {
        getTarget()[key] = parseScalar(value.trim())
      }
    }
  }
  return root
}

function parseScalar(value: string): unknown {
  const v = value.trim()
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1)
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1)
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+$/.test(v)) return Number(v)
  if (/^-?\d+\.\d+$/.test(v)) return Number(v)
  if (/^\[.*\]$/.test(v)) {
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => {
        const item = s.trim()
        if (item.length >= 2 && (item.startsWith('"') && item.endsWith('"'))) return item.slice(1, -1)
        if (item.length >= 2 && (item.startsWith("'") && item.endsWith("'"))) return item.slice(1, -1)
        return item
      })
      .filter((s) => s.length > 0)
  }
  return v
}
