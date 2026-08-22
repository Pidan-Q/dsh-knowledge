/**
 * 教训晋升为技能草稿：扫描可晋升条目、生成技能草稿。
 *
 * 布局（v3.0：更名 lesson-promote，删除版本/回滚）：
 *   lesson      : <workspace>/.dsh/knowledge/<id>.md（由 EntryStore 读写）
 *   draft 清单   : <workspace>/<draftsDir>/<name>.md（draftsDir 默认
 *                  .dsh/lesson-promote/drafts）
 *                  —— 草稿文件 = 记录字段 + 完整技能文档（frontmatter + 正文），
 *                     批准前可人工编辑；扫描不会覆盖已存在的草稿文档；
 *   SKILL.md    : <workspace>/.dsh/skills/<name>/SKILL.md
 *                  —— 仅由 approve 写入；内置 skill-filesystem provider
 *                     （项目层 rank 100）自动加载，因此不再需要
 *                     ctx.skills.register() 动态注册。
 *
 * v3.0 不再生成版本快照、不再提供 rollback：技能生命周期（安装/启用/停用/
 * 更新/移除）归已安装的 dsh-skills-manager 管理，本插件只负责"错题本晋级"。
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isErrorLesson, type EntryStore, type ErrorLesson } from '@dsh-knowledge/shared'

/** 草稿状态：pending 待批准；approved 已批准（正式技能已落盘）。 */
export type DraftStatus = 'pending' | 'approved'

/** 草稿清单记录（<draftsDir>/<name>.md 的 frontmatter，含记录字段 + 技能字段超集）。 */
export interface SkillDraftRecord {
  /** 技能名（kebab-case）。 */
  name: string
  /** 来源教训条目 id（kb-YYYYMMDD-NNN）。 */
  lessonId: string
  /** 草稿状态。 */
  status: DraftStatus
  /** 教训标题（便于人工阅读）。 */
  title: string
  /** 技能描述快照（注册时使用）。 */
  description: string
  /** 创建日期 YYYY-MM-DD。 */
  createdAt: string
  /** 批准日期 YYYY-MM-DD（仅 approved 时存在）。 */
  approvedAt?: string
}

/** scanPromotable 的选项。 */
export interface ScanOptions {
  /** 共享条目存储（读取 <workspace>/.dsh/knowledge/ 与全局层）。 */
  entries: EntryStore
  /** 晋升阈值：errorCount 达到该值且状态为 distilled 才可晋升。 */
  promoteAfterFailures: number
}

/**
 * 扫描工作区中满足晋升条件的教训条目：
 * category='lesson'（ErrorLesson）、status='distilled'、errorCount>=promoteAfterFailures。
 */
export function scanPromotable(workspace: string, options: ScanOptions): ErrorLesson[] {
  return options.entries
    .list(workspace)
    .filter(isErrorLesson)
    .filter((lesson) => lesson.status === 'distilled' && lesson.errorCount >= options.promoteAfterFailures)
}

/**
 * 由标题生成 kebab-case 技能名：非 [a-z0-9-] 的字符替换为 '-'，去掉首尾 '-'。
 * 中英文标题均可；空结果由调用方提供保底名。
 */
export function skillNameFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** 教训 id 的尾号（最后一段，如 kb-20260818-001 -> 001）。 */
export function lessonIdTail(lessonId: string): string {
  const parts = lessonId.split('-')
  return parts[parts.length - 1] ?? ''
}

/** 草稿清单目录绝对路径（相对路径按工作区解析）。 */
export function draftsDirOf(draftsDir: string, workspace: string): string {
  return isAbsolute(draftsDir) ? draftsDir : join(workspace, draftsDir)
}

/**
 * 为一条教训生成技能草稿，并写入草稿清单。
 *
 * 草稿只写 <draftsDir>/<name>.md（记录字段 + 完整技能文档），
 * **不写入 .dsh/skills/** —— 草稿不是正式技能，避免被内置 skill-filesystem
 * 提前加载。已存在同教训草稿时：刷新记录字段（title/description），保留
 * 草稿文档（人工编辑不丢失）。
 *
 * @param lesson - 满足晋升条件的教训条目。
 * @param workspace - 项目根目录。
 * @param draftsDir - 草稿清单目录（相对路径按工作区解析）。
 * @returns 技能名与草稿文件路径。
 */
export function draftSkill(
  lesson: ErrorLesson,
  workspace: string,
  draftsDir: string,
): { name: string; filePath: string } {
  const name = uniqueDraftName(lesson, workspace, draftsDir)
  const document = skillDocumentOf(lesson, name)
  const draftDir = draftsDirOf(draftsDir, workspace)
  mkdirSync(draftDir, { recursive: true })
  const draftPath = join(draftDir, `${name}.md`)
  const existing = readDraftRecord(draftPath)
  if (existing !== undefined && existing.lessonId === lesson.id) {
    const record: SkillDraftRecord = {
      ...existing,
      title: lesson.title,
      description: draftDescription(lesson),
    }
    // 保留既有草稿文档（用户编辑不丢失）；读不到时回退为新生成的文档。
    writeDraftRecord(draftPath, record, readDraftDocument(draftPath) ?? document)
    return { name, filePath: draftPath }
  }
  const record: SkillDraftRecord = {
    name,
    lessonId: lesson.id,
    status: 'pending',
    title: lesson.title,
    description: draftDescription(lesson),
    createdAt: new Date().toISOString().slice(0, 10),
  }
  writeDraftRecord(draftPath, record, document)
  return { name, filePath: draftPath }
}

/** 技能描述（自动生成，注册时使用）。 */
export function draftDescription(lesson: ErrorLesson): string {
  return `处理工具 ${lesson.tool} 调用中的 ${lesson.errorType} 错误（教训 ${lesson.id}：${lesson.title}）`
}

/** 解析后的 SKILL.md 文档。 */
export interface SkillDocument {
  /** frontmatter 中的可选元数据。 */
  frontmatter: {
    name?: string
    description?: string
    whenToUse?: string
    metadata?: Record<string, unknown>
  }
  /** frontmatter 剥离后的正文（作为技能 content）。 */
  content: string
}

/** 由教训生成技能文档（frontmatter + 正文）。 */
export function skillDocumentOf(lesson: ErrorLesson, name: string): SkillDocument {
  const whenToUse =
    `当工具调用报错且满足以下条件时使用：涉及工具为 ${lesson.tool}，` +
    `错误类型为 ${lesson.errorType}，场景与教训 ${lesson.id}（${lesson.title}）一致。`
  const body = [
    '## 触发条件',
    '',
    '满足以下条件时参考本技能：',
    '',
    `- 涉及工具：${lesson.tool}`,
    `- 错误类型：${lesson.errorType}`,
    `- 场景与教训 ${lesson.id}（${lesson.title}）一致`,
    '',
    '## 错误类型',
    '',
    lesson.errorType,
    '',
    '## 修复方式',
    '',
    lesson.fix ?? '待补充',
    '',
  ].join('\n')
  return {
    frontmatter: {
      name,
      description: draftDescription(lesson),
      whenToUse,
      metadata: {
        errataRef: lesson.id,
        confidence: lesson.confidence,
        tool: lesson.tool,
        errorType: lesson.errorType,
      },
    },
    content: body,
  }
}

/** 把技能文档序列化为正式 SKILL.md（只含技能字段，不带草稿记录字段）。 */
export function renderSkillFile(document: SkillDocument): string {
  const fm = document.frontmatter
  const lines = ['---']
  if (fm.name !== undefined) lines.push(`name: ${formatYamlValue(fm.name)}`)
  if (fm.description !== undefined) lines.push(`description: ${formatYamlValue(fm.description)}`)
  if (fm.whenToUse !== undefined) lines.push(`whenToUse: ${formatYamlValue(fm.whenToUse)}`)
  if (fm.metadata !== undefined && Object.keys(fm.metadata).length > 0) {
    lines.push('metadata:')
    for (const [key, value] of Object.entries(fm.metadata)) {
      lines.push(`  ${key}: ${formatYamlValue(value)}`)
    }
  }
  lines.push('---', '', document.content.trimEnd(), '')
  return lines.join('\n')
}

/** 解析 SKILL.md：缺少 frontmatter 或格式损坏时返回 undefined。 */
export function parseSkillDocument(text: string): SkillDocument | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.trimStart())
  if (!m) return undefined
  const fm = parseYaml(m[1]!)
  const out: SkillDocument = { frontmatter: {}, content: (m[2] ?? '').trim() }
  if (typeof fm.name === 'string' && fm.name.length > 0) out.frontmatter.name = fm.name
  if (typeof fm.description === 'string' && fm.description.length > 0) out.frontmatter.description = fm.description
  if (typeof fm.whenToUse === 'string' && fm.whenToUse.length > 0) out.frontmatter.whenToUse = fm.whenToUse
  if (typeof fm.metadata === 'object' && fm.metadata !== null && !Array.isArray(fm.metadata)) {
    out.frontmatter.metadata = fm.metadata as Record<string, unknown>
  }
  return out
}

/** 读取草稿文件中的技能文档（name/description/whenToUse/metadata/正文）；损坏返回 undefined。 */
export function readDraftDocument(filePath: string): SkillDocument | undefined {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
  return parseSkillDocument(text)
}

/** 序列化草稿清单记录（frontmatter 含记录字段 + 技能字段超集，UTF-8）。 */
export function writeDraftRecord(filePath: string, record: SkillDraftRecord, document?: SkillDocument): void {
  const fm = document?.frontmatter ?? {}
  const lines = [
    '---',
    `name: ${record.name}`,
    `lesson_id: ${record.lessonId}`,
    `status: ${record.status}`,
    `title: ${formatYamlValue(record.title)}`,
    `description: ${formatYamlValue(record.description)}`,
  ]
  if (fm.whenToUse !== undefined) lines.push(`whenToUse: ${formatYamlValue(fm.whenToUse)}`)
  if (fm.metadata !== undefined && Object.keys(fm.metadata).length > 0) {
    lines.push('metadata:')
    for (const [key, value] of Object.entries(fm.metadata)) {
      lines.push(`  ${key}: ${formatYamlValue(value)}`)
    }
  }
  lines.push(`created_at: ${record.createdAt}`)
  if (record.approvedAt !== undefined) lines.push(`approved_at: ${record.approvedAt}`)
  lines.push('---', '')
  const body = document?.content.trim()
  if (body !== undefined && body.length > 0) {
    lines.push(body, '')
  } else {
    lines.push(
      `<!-- lesson-promote 草稿清单：name=${record.name} lesson_id=${record.lessonId} status=${record.status} -->`,
      '',
    )
  }
  writeFileSync(filePath, lines.join('\n'), 'utf8')
}

/** 读取草稿清单记录；文件缺失或格式损坏时返回 undefined。 */
export function readDraftRecord(filePath: string): SkillDraftRecord | undefined {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
  const fm = parseFrontmatterBlock(text)
  if (fm === undefined) return undefined
  const { name, lesson_id: lessonId, status } = fm
  if (typeof name !== 'string' || name.length === 0) return undefined
  if (typeof lessonId !== 'string' || lessonId.length === 0) return undefined
  if (status !== 'pending' && status !== 'approved') return undefined
  const record: SkillDraftRecord = {
    name,
    lessonId,
    status,
    title: typeof fm.title === 'string' && fm.title.length > 0 ? fm.title : lessonId,
    description: typeof fm.description === 'string' ? fm.description : '',
    createdAt: typeof fm.created_at === 'string' && fm.created_at.length > 0 ? fm.created_at : '',
  }
  if (typeof fm.approved_at === 'string' && fm.approved_at.length > 0) record.approvedAt = fm.approved_at
  return record
}

/** 解析 --- 包裹的 frontmatter 块。 */
function parseFrontmatterBlock(text: string): Record<string, unknown> | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.trimStart())
  if (!m) return undefined
  return parseYaml(m[1]!)
}

/** 极简 YAML 解析：标量、列表、按缩进嵌套的对象。 */
function parseYaml(text: string): Record<string, unknown> {
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
      const existing = Array.isArray(target[currentKey]) ? target[currentKey] : undefined
      const arr = (existing as unknown[] | undefined) ?? []
      if (!Array.isArray(target[currentKey])) target[currentKey] = arr
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
  return v
}

/** 输出安全的 YAML 标量：仅含安全字符时原样输出，否则 JSON 引用。 */
function formatYamlValue(value: unknown): string {
  if (typeof value === 'string') {
    if (/^[A-Za-z0-9_./:\-]+$/.test(value)) return value
    return JSON.stringify(value)
  }
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** 生成不与现有草稿冲突的技能名：优先用标题 slug，冲突时追加教训尾号/序号。 */
function uniqueDraftName(lesson: ErrorLesson, workspace: string, draftsDir: string): string {
  const base = skillNameFromTitle(lesson.title)
  const tail = lessonIdTail(lesson.id)
  const fallback = `lesson-${tail}`
  const candidate = base.length > 0 ? base : fallback
  const used = readDraftNames(draftsDirOf(draftsDir, workspace))
  if (!used.has(candidate) || used.get(candidate) === lesson.id) return candidate
  const suffixed = candidate !== fallback ? `${candidate}-${tail}` : candidate
  if (!used.has(suffixed) || used.get(suffixed) === lesson.id) return suffixed
  let n = 2
  while (used.has(`${suffixed}-${n}`) && used.get(`${suffixed}-${n}`) !== lesson.id) n += 1
  return `${suffixed}-${n}`
}

/** 扫描草稿目录中已存在的 name -> lessonId 映射。 */
function readDraftNames(draftDir: string): Map<string, string> {
  const names = new Map<string, string>()
  let files: string[]
  try {
    files = readdirSync(draftDir).filter((f) => f.endsWith('.md'))
  } catch {
    return names
  }
  for (const file of files) {
    const record = readDraftRecord(join(draftDir, file))
    if (record !== undefined) names.set(record.name, record.lessonId)
  }
  return names
}
