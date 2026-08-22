/**
 * knowledge 宿主端 Remote 服务：把双层知识库的列表/添加/删除能力暴露给
 * 浏览器设置页。
 *
 * 与 errata 共用同一条 Remote + Slot 链路：`TypertRemoteService` +
 * `@Remote` 装饰器，描述符由 typert-loader 从包 `./typert` 导出注册，
 * 浏览器端经 `ctx.remote.knowledge.*` 调用。
 *
 * workspace 语义（见方案「项目定位」）：宿主平面没有单一「当前会话」，
 * 方法显式携带 `workspace`。`list` 缺省只返回全局层（EntryStore 语义），
 * 传 workspace 才并入该项目的项目层；项目层写入必须显式传 workspace；
 * 全局写入受 `allowGlobalWrite` 约束（默认 false，禁用时拒绝）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EntryStore, entryId, type EntryCategory, type EntryScope, type KnowledgeEntry } from './shared/index.js'
import { KnowledgeScanner, toPosix, type ScanResult } from './scan.js'

/** Remote wire 命名空间（与 Cordis service key 一致）。 */
export const KNOWLEDGE_NAMESPACE = 'knowledge'

/** 穿越 Remote 边界的知识条目纯数据视图。 */
export type KnowledgeEntryView = KnowledgeEntry

/** remember 的 wire 输入（不含 id/created 等由宿主生成的字段）。 */
export interface RememberInput {
  title: string
  body: string
  scope: 'project' | 'global'
  category?: EntryCategory
  tags?: string[]
}

/** knowledge Remote 服务的运行依赖。 */
export interface KnowledgeRemoteServiceOptions {
  /** 条目存储（缺省按环境解析 DSH home）。 */
  store?: EntryStore
  /** 是否允许写入 global 层（默认 false，与 knowledge 插件配置一致）。 */
  allowGlobalWrite?: boolean
  /**
   * 项目工作区候选的扫描基目录（单根或数组）。缺省 [os.homedir(), process.cwd()]。
   * 每个根下一级含 .git 或 .dsh/knowledge 的目录视为项目（Windows 项目不在
   * 用户目录时，把开发盘根配进来，如 'D:/Code'）。
   */
  projectScanRoot?: string | string[]
}

const CATEGORIES: readonly EntryCategory[] = ['convention', 'fact', 'decision', 'pitfall', 'lesson']

/** 生成当日序号递增的条目 id（与 KnowledgeService.nextEntryId 同规则）。 */
function nextEntryId(entries: readonly KnowledgeEntry[], date = new Date()): string {
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
 * 知识库 Remote 服务：list / remember / forget。
 * 构造时经 `super(ctx, 'knowledge')` 注册 Cordis service 并绑定 Typert
 * Gateway 命名空间。
 */
export class KnowledgeRemoteService extends TypertRemoteService {
  private readonly store: EntryStore
  private readonly allowGlobalWrite: boolean
  private readonly projectScanRoots: string[]

  constructor(ctx: Context, options: KnowledgeRemoteServiceOptions = {}) {
    super(ctx, KNOWLEDGE_NAMESPACE)
    this.store = options.store ?? new EntryStore()
    this.allowGlobalWrite = options.allowGlobalWrite ?? false
    const configured = options.projectScanRoot === undefined
      ? [homedir(), process.cwd()]
      : Array.isArray(options.projectScanRoot)
        ? options.projectScanRoot
        : [options.projectScanRoot]
    // 去重（homedir 与 cwd 可能重合），保留正斜杠形态
    this.projectScanRoots = [...new Set(configured.map((root) => toPosix(root)))]
  }

  /**
   * 列出知识条目：缺省只返回全局层；传 workspace 并入该项目的项目层；
   * 传 dir 时改为浏览该显式目录（自定义落盘位置）。
   */
  @Remote('list')
  list(workspace?: string, dir?: string): { entries: KnowledgeEntryView[] } {
    if (dir !== undefined && dir.length > 0) {
      return { entries: this.store.listDir(toPosix(dir)) }
    }
    return { entries: this.store.list(workspace) }
  }

  /**
   * 项目工作区候选列表：每个扫描根下一级含 `.git` 或 `.dsh/knowledge`
   * （已生成过知识）的目录。供面板「获取知识库」下拉选择；不在列表内的
   * 项目可走面板「自定义路径…」。
   */
  @Remote('workspaces')
  workspaces(): { workspaces: string[] } {
    const set = new Set<string>()
    for (const root of this.projectScanRoots) {
      let names: string[] = []
      try {
        names = readdirSync(root)
      } catch {
        continue
      }
      for (const name of names) {
        if (name.startsWith('.')) continue
        const dir = join(root, name)
        let st
        try {
          st = statSync(dir)
        } catch {
          continue
        }
        if (!st.isDirectory()) continue
        try {
          if (statSync(join(dir, '.git')).isDirectory()) {
            set.add(toPosix(dir))
            continue
          }
        } catch {
          // 非 git 项目，继续看知识库目录
        }
        try {
          if (statSync(join(dir, '.dsh', 'knowledge')).isDirectory()) set.add(toPosix(dir))
        } catch {
          // 无知识库目录，跳过
        }
      }
    }
    return { workspaces: [...set].sort() }
  }

  /**
   * 写入一条知识条目。global 范围受 allowGlobalWrite 约束；
   * project 范围必须显式携带 workspace。
   */
  @Remote('remember')
  remember(input: RememberInput, workspace?: string): { id: string } {
    if (input.title.trim().length === 0) throw new Error('remember: title 不能为空')
    if (input.body.trim().length === 0) throw new Error('remember: body 不能为空')
    const scope = input.scope
    if (scope === 'global' && !this.allowGlobalWrite) {
      throw new Error('remember: 未启用全局写入（allowGlobalWrite=false），不能写入 global 范围的知识条目')
    }
    if (scope === 'project' && (workspace === undefined || workspace.length === 0)) {
      throw new Error('remember: 项目层写入必须携带 workspace')
    }
    const category = input.category ?? 'fact'
    if (!CATEGORIES.includes(category)) {
      throw new Error(`remember: 未知分类 ${category}`)
    }
    const tags = (input.tags ?? []).filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    const today = new Date().toISOString().slice(0, 10)
    const existing = this.store.list(workspace)
    const entry: KnowledgeEntry = {
      id: nextEntryId(existing),
      scope: scope as EntryScope,
      workspace: scope === 'project' ? workspace : undefined,
      category,
      tags,
      title: input.title,
      body: input.body,
      created: today,
      lastUsed: today,
      hitCount: 0,
      confidence: 0.5,
      status: 'raw',
    }
    this.store.write(entry, workspace)
    return { id: entry.id }
  }

  /** 删除指定 id 的条目（先查全局层，再查项目层）；返回是否实际删除。 */
  @Remote('forget')
  forget(id: string, workspace?: string): { removed: boolean } {
    return { removed: this.store.remove(id, workspace) !== undefined }
  }

  /**
   * 「获取知识库」：按扫描范围（见 docs/项目知识库扫描范围.md 与
   * docs/全局知识库扫描范围.md）扫描文件并生成知识条目（落盘 md）。
   * - scope='project' 必须携带 workspace（宿主平面无「当前会话」语义）；
   * - scope='global' 忽略 workspace，扫 DSH home 与只读系统源；
   * - target 为用户自定义落盘目录；缺省项目层写 <workspace>/.dsh/knowledge、
   *   全局层写 <dshHome>/knowledge/global；
   * - 幂等：以 source + scope 为键，重复扫描只跳过不重复写。
   */
  @Remote('generate')
  generate(scope: 'project' | 'global', workspace?: string, target?: string): ScanResult {
    if (scope !== 'project' && scope !== 'global') {
      throw new Error(`generate: 未知范围 ${String(scope)}`)
    }
    const scanner = new KnowledgeScanner(this.store, this.store.dshHome)
    const targetDir = target !== undefined && target.length > 0 ? target : undefined
    if (scope === 'project') {
      if (workspace === undefined || workspace.length === 0) {
        throw new Error('generate: 项目层扫描必须携带 workspace')
      }
      return scanner.scanProject(workspace, targetDir)
    }
    return scanner.scanGlobal(targetDir)
  }
}
