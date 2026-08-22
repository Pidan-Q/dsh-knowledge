/**
 * lesson-promote 管理工具：list / approve。
 *
 * v3.0 更名 + 精简（避免与已安装的 dsh-skills-manager 冲突）：
 * - 工具名从 skill-manager 改为 **lesson-promote**；
 * - **删除 rollback 与版本快照**：技能生命周期（安装/启用/停用/更新/移除）
 *   归已安装的 dsh-skills-manager 管理，本工具只做"错题本晋级"；
 * - **同名冲突守卫**：approve 前查询平台 ctx.skills 注册表，若同名技能已由
 *   其他来源占用（dsh-skills-manager 库 rank 50 / runtime rank 250 /
 *   user / bundled 等），拒绝批准——已装插件优先，绝不产生同名遮蔽；
 *   仅当同名技能来自内置 filesystem provider 的项目层
 *   （<ws>/.dsh/skills，source=project-dsh，即本插件自己的部署层）时
 *   允许幂等重写。
 *
 * approve 流程：读草稿记录 -> 读草稿技能文档（保留人工编辑）-> 校验 ->
 * 同名冲突守卫 -> 写入 .dsh/skills/<name>/SKILL.md -> 草稿状态置 approved。
 *
 * 注意：autoApprove=false（默认）时，批准必须由用户显式调用本工具的
 * approve 动作触发；插件不会在后台自动注册任何技能。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LessonPromoteStore } from './index.js'
import {
  draftsDirOf,
  readDraftDocument,
  readDraftRecord,
  renderSkillFile,
  writeDraftRecord,
  type SkillDraftRecord,
} from './promote.js'

/** 技能名 kebab-case 命名规则（与 @deepseek-ai/dsh-skill 的 SKILL_NAME 一致）。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 工具返回的规范结果（与 output.schema 一致）。 */
export interface LessonPromoteResult {
  ok: boolean
  message: string
  drafts?: SkillDraftSummary[]
  result?: JsonValue
}

/** list 输出的草稿摘要。 */
export interface SkillDraftSummary {
  name: string
  lessonId: string
  status: 'pending' | 'approved'
  title: string
  description: string
}

/** 同名冲突守卫命中信息（来自平台 ctx.skills 注册表）。 */
export interface NameConflictInfo {
  name: string
  provider: string
  source?: string
}

/**
 * 同名冲突守卫：返回与技能名同名的已占用来源；undefined 表示可安全批准。
 * 平台注册表中 <ws>/.dsh/skills（filesystem / project-dsh，本插件自己的部署层）
 * 的命中视为可幂等重写，不构成冲突；其余来源（已装 dsh-skills-manager 库、
 * runtime、user、bundled 等）一律视为冲突。
 */
export type NameConflictCheck = (name: string) => Promise<NameConflictInfo | undefined>

/** 注册 lesson-promote 管理工具到 ctx.tools。 */
export function registerLessonPromoteTool(ctx: Context, store: LessonPromoteStore): void {
  const tool = defineTool({
    name: 'lesson-promote',
    description:
      '管理"错题本"（.dsh/knowledge 中反复失败的教训条目）晋级为 DSH 技能的流程。' +
      '动作列表：list 列出 .dsh/lesson-promote/drafts 中的技能草稿（name 可省略，' +
      '自动扫描可晋升教训并幂等生成新草稿）；' +
      'approve 批准草稿：把草稿文档写入 .dsh/skills/<name>/SKILL.md（内置 skill-filesystem 自动加载为项目技能，' +
      'name 必填）。' +
      'approve 前会做同名冲突守卫：若平台已有同名技能（如来自已安装的 dsh-skills-manager），拒绝批准以保证已装插件优先。' +
      'autoApprove=false（默认）时，批准必须由用户显式调用本工具的 approve 动作触发，插件不会自动注册技能。',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'approve'],
        required: true,
        description: '操作类型：list 列出草稿；approve 批准草稿并落盘技能。',
      },
      name: {
        type: 'string',
        description: '技能名称（kebab-case）。list 可省略；approve 必填。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          drafts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                lessonId: { type: 'string', required: true },
                status: { type: 'string', required: true },
                title: { type: 'string', required: true },
                description: { type: 'string', required: true },
              },
            },
          },
          result: { type: 'json' },
        },
      },
      render: (args, value) => [{ type: 'text', text: renderResultText(args, value) }],
    },
    async execute(args, exec) {
      const workspace = store.resolveWorkspace(exec.agent?.session.header.cwd)
      try {
        switch (args.action) {
          case 'list':
            return listDrafts(store, workspace)
          case 'approve': {
            if (args.name === undefined || args.name.length === 0) {
              return { ok: false, message: 'approve 操作必须提供 name 参数' }
            }
            return approveDraft(store, workspace, args.name, conflictCheckFor(ctx, workspace))
          }
          default:
            return { ok: false, message: `未知操作：${String(args.action)}` }
        }
      } catch (error) {
        return { ok: false, message: `操作失败：${errorMessage(error)}` }
      }
    },
  })
  ctx.tools.register(tool)
}

/**
 * 基于平台 ctx.skills 注册表构造同名冲突守卫。
 * 查询失败时**保守拒绝**（fail-closed）：无法确认无冲突就不落盘，保证
 * 已装插件优先、不产生同名遮蔽。
 */
export function conflictCheckFor(ctx: Context, workspace: string): NameConflictCheck {
  return async (name: string): Promise<NameConflictInfo | undefined> => {
    let snapshot: { skills: readonly SkillSummary[] }
    try {
      snapshot = await ctx.skills.snapshot({ cwd: workspace })
    } catch (error) {
      return { name, provider: 'skills-registry-unavailable', source: errorMessage(error) }
    }
    const hit = snapshot.skills.find((skill) => skill.name === name)
    if (hit === undefined) return undefined
    // 自己部署层（<ws>/.dsh/skills，filesystem + project-dsh）的命中：
    // 是此前已批准落盘的同名技能，允许幂等重写。
    if (hit.provider === 'filesystem' && hit.source === 'project-dsh') return undefined
    return {
      name: hit.name,
      provider: hit.provider,
      source: typeof hit.source === 'string' ? hit.source : undefined,
    }
  }
}

/** 列出草稿清单目录中的全部草稿（按名称排序）。list 前先扫描可晋升教训并幂等生成草稿。 */
function listDrafts(store: LessonPromoteStore, workspace: string): LessonPromoteResult {
  const generated = refreshDrafts(store, workspace)
  const draftDir = draftsDirOf(store.config.draftsDir, workspace)
  let files: string[]
  try {
    files = readdirSync(draftDir).filter((f) => f.endsWith('.md'))
  } catch {
    return { ok: true, message: `草稿目录不存在或为空：${draftDir}`, drafts: [] }
  }
  const drafts: SkillDraftSummary[] = []
  for (const file of files) {
    const record = readDraftRecord(join(draftDir, file))
    if (record === undefined) continue
    drafts.push(summaryOf(record))
  }
  drafts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const prefix = generated > 0 ? `本次扫描新生成 ${generated} 个草稿；` : ''
  return {
    ok: true,
    message: drafts.length === 0
      ? `${prefix}没有草稿；可先让 dsh-errata 插件沉淀教训（errorCount 达到 ${store.config.promoteAfterFailures} 的 distilled 条目会自动生成草稿）`
      : `${prefix}共 ${drafts.length} 个草稿`,
    drafts,
  }
}

/** 扫描可晋升教训并幂等生成草稿（同一教训不重复生成）。返回新生成数。 */
function refreshDrafts(store: LessonPromoteStore, workspace: string): number {
  let generated = 0
  for (const lesson of store.scanPromotable(workspace)) {
    store.draftSkill(lesson, workspace)
    generated += 1
  }
  return generated
}

function summaryOf(record: SkillDraftRecord): SkillDraftSummary {
  return {
    name: record.name,
    lessonId: record.lessonId,
    status: record.status,
    title: record.title,
    description: record.description,
  }
}

/**
 * 批准草稿：读草稿 -> 读草稿技能文档（保留人工编辑）-> 校验 ->
 * 同名冲突守卫 -> 写入 <workspace>/.dsh/skills/<name>/SKILL.md
 * （内置 skill-filesystem 自动加载）-> 草稿置 approved。
 *
 * 自 v2.1 起不再调用 ctx.skills.register()：平台以 .dsh/skills 文件为准
 * （项目层 rank 100），文件落盘即注册；v3.0 起落盘前经 checkNameConflict
 * 守卫，确保已安装插件的同名技能优先、不产生遮蔽。
 */
export async function approveDraft(
  store: LessonPromoteStore,
  workspace: string,
  name: string,
  checkNameConflict: NameConflictCheck = async () => undefined,
): Promise<LessonPromoteResult> {
  if (!SKILL_NAME.test(name)) {
    return { ok: false, message: `技能名称 "${name}" 不符合 kebab-case 命名规则` }
  }
  const draftDir = draftsDirOf(store.config.draftsDir, workspace)
  const draftPath = join(draftDir, `${name}.md`)
  const draft = readDraftRecord(draftPath)
  if (draft === undefined) {
    return { ok: false, message: `未找到草稿 "${name}"（${draftPath}）` }
  }
  if (draft.status === 'approved') {
    return { ok: false, message: `草稿 "${name}" 已批准，无需重复操作` }
  }
  // 同名冲突守卫：已装插件/其他来源的同名技能优先。
  const conflict = await checkNameConflict(name)
  if (conflict !== undefined) {
    const origin = conflict.source !== undefined ? `${conflict.provider}（source=${conflict.source}）` : conflict.provider
    return {
      ok: false,
      message:
        `拒绝批准：平台已存在同名技能 "${conflict.name}"（来自 ${origin}）。` +
        `为避免遮蔽冲突（已安装插件的技能优先），请先移除或重命名该同名技能，` +
        `或修改草稿 frontmatter 中的 name 后重试。`,
    }
  }
  const document = readDraftDocument(draftPath)
  if (document === undefined) {
    return { ok: false, message: `草稿文件格式错误（缺少 frontmatter）：${draftPath}` }
  }
  const skillName = document.frontmatter.name ?? draft.name
  const description = document.frontmatter.description ?? draft.description
  if (!SKILL_NAME.test(skillName)) {
    return { ok: false, message: `技能名称 "${skillName}" 不符合 kebab-case 命名规则` }
  }
  if (description.length === 0) {
    return { ok: false, message: '技能描述不能为空' }
  }
  const skillDir = join(workspace, '.dsh', 'skills', skillName)
  const skillFile = join(skillDir, 'SKILL.md')
  try {
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillFile, renderSkillFile(document), 'utf8')
  } catch (error) {
    return { ok: false, message: `技能落盘失败：${errorMessage(error)}` }
  }
  const approved: SkillDraftRecord = {
    ...draft,
    status: 'approved',
    approvedAt: new Date().toISOString().slice(0, 10),
  }
  writeDraftRecord(draftPath, approved, document)
  return {
    ok: true,
    message:
      `技能 "${skillName}" 已批准并落盘：${skillFile}` +
      `—— 已写入 .dsh/skills/${skillName}/SKILL.md，由内置 skill-filesystem 自动加载`,
    result: { name: skillName, file: skillFile },
  }
}

/** 把任意抛出的值转为可读消息。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 把结果渲染成模型可见文本。 */
function renderResultText(
  _args: { action: string; name?: string },
  value: {
    ok: boolean
    message: string
    drafts?: unknown
    result?: unknown
  },
): string {
  const lines = [value.message]
  const drafts = value.drafts
  if (Array.isArray(drafts) && drafts.length > 0) {
    lines.push('')
    for (const item of drafts) {
      if (typeof item !== 'object' || item === null) continue
      const { name, status, lessonId, title } = item as Record<string, unknown>
      lines.push(`- ${String(name)} [${String(status)}] 教训=${String(lessonId)} ${String(title)}`)
    }
  }
  if (value.result !== undefined) {
    lines.push('')
    lines.push(JSON.stringify(value.result, null, 2))
  }
  return lines.join('\n')
}
