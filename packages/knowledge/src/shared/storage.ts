/**
 * Filesystem-backed entry storage for the DSH knowledge/errata plugins.
 *
 * Layout（V1.5 分类子目录；读写均递归，兼容旧平铺）：
 *   global : <dshHome>/knowledge/（global/ 平铺旧条目 + <分类>/ 子目录）
 *   project: <workspace>/.dsh/knowledge/（平铺旧条目 + <分类>/ 子目录）
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseEntry, serializeEntry, type KnowledgeEntry } from './schema.js'

export interface StorageOptions {
  /** DSH home directory (defaults to ~/.dsh or $DSH_HOME). */
  dshHome?: string
}

export function resolveDshHome(): string {
  const env = process.env.DSH_HOME
  if (env && env.length > 0) return env
  return join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.dsh')
}

/** Find the project root: nearest ancestor containing a `.git` entry. */
export function findProjectRoot(cwd: string): string {
  let dir = cwd
  for (;;) {
    try {
      const entries = readdirSync(dir)
      if (entries.includes('.git')) return dir
    } catch {
      // fall through
    }
    const parent = dirname(dir)
    if (parent === dir) return cwd
    dir = parent
  }
}

export class EntryStore {
  readonly dshHome: string

  constructor(opts: StorageOptions = {}) {
    this.dshHome = opts.dshHome ?? resolveDshHome()
  }

  private knowledgeRoot(): string {
    return join(this.dshHome, 'knowledge')
  }

  /** 旧版/手动写入的全局层平铺目录（write() 仍写这里，list/read 递归可见）。 */
  private globalDir(): string {
    return join(this.dshHome, 'knowledge', 'global')
  }

  /** 递归收集目录下全部 .md 文件绝对路径（含子目录）。 */
  private walkMd(dir: string): string[] {
    const out: string[] = []
    const visit = (current: string): void => {
      let names: string[]
      try {
        names = readdirSync(current)
      } catch {
        return
      }
      for (const name of names) {
        const full = join(current, name)
        let st
        try {
          st = statSync(full)
        } catch {
          continue
        }
        if (st.isDirectory()) visit(full)
        else if (name.endsWith('.md')) out.push(full)
      }
    }
    visit(dir)
    return out
  }

  private projectDir(workspace: string): string {
    return join(workspace, '.dsh', 'knowledge')
  }

  private dirFor(scope: 'project' | 'global', workspace?: string): string {
    return scope === 'global' ? this.globalDir() : this.projectDir(workspace ?? process.cwd())
  }

  /** Persist an entry to disk (project or global layer). */
  write(entry: KnowledgeEntry, workspace?: string): string {
    if (entry.scope === 'session') {
      // Session entries are intentionally in-memory; callers pass them around.
      return entry.id
    }
    const dir = this.dirFor(entry.scope as 'project' | 'global', workspace ?? entry.workspace)
    return this.writeTo(entry, dir)
  }

  /** Persist an entry to an explicit directory（用户自定义落盘位置）。 */
  writeTo(entry: KnowledgeEntry, dir: string): string {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${entry.id}.md`)
    writeFileSync(file, serializeEntry(entry), 'utf8')
    return file
  }

  /** List all persisted entries inside one explicit directory（递归含子目录），newest first. */
  listDir(dir: string): KnowledgeEntry[] {
    const out: KnowledgeEntry[] = []
    for (const file of this.walkMd(dir)) {
      try {
        const parsed = parseEntry(readFileSync(file, 'utf8'))
        if (parsed !== undefined) out.push(parsed)
      } catch {
        // skip unreadable entries
      }
    }
    out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))
    return out
  }

  /** Read a single entry by id, searching global then project layers（递归含子目录）. */
  read(id: string, workspace?: string): KnowledgeEntry | undefined {
    const dirs = [this.knowledgeRoot()]
    if (workspace !== undefined) dirs.push(this.projectDir(workspace))
    for (const dir of dirs) {
      for (const file of this.walkMd(dir)) {
        if (basename(file) !== `${id}.md`) continue
        try {
          const parsed = parseEntry(readFileSync(file, 'utf8'))
          if (parsed !== undefined) return parsed
        } catch {
          // skip unreadable
        }
      }
    }
    return undefined
  }

  /**
   * Read an entry from the project layer only（无全局层回退）。
   * 供项目层语义的调用方（如 errata 错题本）精确定位，避免全局层同 id
   * 条目遮蔽项目层条目。
   */
  readProject(id: string, workspace: string): KnowledgeEntry | undefined {
    for (const file of this.walkMd(this.projectDir(workspace))) {
      if (basename(file) !== `${id}.md`) continue
      try {
        const parsed = parseEntry(readFileSync(file, 'utf8'))
        if (parsed !== undefined) return parsed
      } catch {
        // skip unreadable
      }
    }
    return undefined
  }

  /**
   * Remove an entry file from the project layer only（无全局层回退）。
   * 与 {@link readProject} 配套，保证项目层语义的删除不误伤全局层。
   */
  removeProject(id: string, workspace: string): string | undefined {
    for (const file of this.walkMd(this.projectDir(workspace))) {
      if (basename(file) !== `${id}.md`) continue
      try {
        rmSync(file)
        return file
      } catch {
        return undefined
      }
    }
    return undefined
  }

  /** List all persisted entries (global root + optional project, recursive), newest first. */
  list(workspace?: string): KnowledgeEntry[] {
    const out: KnowledgeEntry[] = []
    const dirs = [this.knowledgeRoot()]
    if (workspace !== undefined) dirs.push(this.projectDir(workspace))
    for (const dir of dirs) {
      for (const file of this.walkMd(dir)) {
        try {
          const parsed = parseEntry(readFileSync(file, 'utf8'))
          if (parsed !== undefined) out.push(parsed)
        } catch {
          // skip unreadable entries
        }
      }
    }
    out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))
    return out
  }

  /** Locate an entry file path (recursive search); returns path or undefined. */
  locate(id: string, workspace?: string): string | undefined {
    const dirs = [this.knowledgeRoot()]
    if (workspace !== undefined) dirs.push(this.projectDir(workspace))
    for (const dir of dirs) {
      for (const file of this.walkMd(dir)) {
        if (basename(file) !== `${id}.md`) continue
        try {
          if (parseEntry(readFileSync(file, 'utf8')) !== undefined) return file
        } catch {
          // skip unreadable
        }
      }
    }
    return undefined
  }

  /** 更新条目的 review 审核状态（原位重写）；找不到返回 false。 */
  updateReview(id: string, review: 'proposed' | 'confirmed', workspace?: string): boolean {
    const file = this.locate(id, workspace)
    if (file === undefined) return false
    try {
      const entry = parseEntry(readFileSync(file, 'utf8'))
      if (entry === undefined) return false
      entry.review = review
      entry.lastUsed = new Date().toISOString().slice(0, 10)
      writeFileSync(file, serializeEntry(entry), 'utf8')
      return true
    } catch {
      return false
    }
  }

  /** Delete an entry file (recursive search); returns the deleted path or undefined. */
  remove(id: string, workspace?: string): string | undefined {
    const dirs = [this.knowledgeRoot()]
    if (workspace !== undefined) dirs.push(this.projectDir(workspace))
    for (const dir of dirs) {
      for (const file of this.walkMd(dir)) {
        if (basename(file) !== `${id}.md`) continue
        try {
          rmSync(file)
          return file
        } catch {
          return undefined
        }
      }
    }
    return undefined
  }
}
