/**
 * Filesystem-backed entry storage for the DSH knowledge/errata plugins.
 *
 * Layout:
 *   global : <dshHome>/knowledge/global/<id>.md
 *   project: <workspace>/.dsh/knowledge/<id>.md
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

  private globalDir(): string {
    return join(this.dshHome, 'knowledge', 'global')
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

  /** List all persisted entries inside one explicit directory（自定义落盘浏览），newest first. */
  listDir(dir: string): KnowledgeEntry[] {
    const out: KnowledgeEntry[] = []
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    } catch {
      return []
    }
    for (const file of files) {
      try {
        const parsed = parseEntry(readFileSync(join(dir, file), 'utf8'))
        if (parsed !== undefined) out.push(parsed)
      } catch {
        // skip unreadable entries
      }
    }
    out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))
    return out
  }

  /** Read a single entry by id, searching global then project layers. */
  read(id: string, workspace?: string): KnowledgeEntry | undefined {
    const dirs = [this.globalDir()]
    if (workspace !== undefined) dirs.push(this.projectDir(workspace))
    for (const dir of dirs) {
      const file = join(dir, `${id}.md`)
      try {
        const parsed = parseEntry(readFileSync(file, 'utf8'))
        if (parsed !== undefined) return parsed
      } catch {
        // missing or unreadable -> try next layer
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
    const file = join(this.projectDir(workspace), `${id}.md`)
    try {
      return parseEntry(readFileSync(file, 'utf8'))
    } catch {
      return undefined
    }
  }

  /**
   * Remove an entry file from the project layer only（无全局层回退）。
   * 与 {@link readProject} 配套，保证项目层语义的删除不误伤全局层。
   */
  removeProject(id: string, workspace: string): string | undefined {
    const file = join(this.projectDir(workspace), `${id}.md`)
    try {
      rmSync(file)
      return file
    } catch {
      return undefined
    }
  }

  /** List all persisted entries (global + optional project), newest first. */
  list(workspace?: string): KnowledgeEntry[] {
    const out: KnowledgeEntry[] = []
    const dirs = [this.globalDir()]
    if (workspace !== undefined) dirs.push(this.projectDir(workspace))
    for (const dir of dirs) {
      let files: string[]
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.md'))
      } catch {
        continue
      }
      for (const file of files) {
        try {
          const parsed = parseEntry(readFileSync(join(dir, file), 'utf8'))
          if (parsed !== undefined) out.push(parsed)
        } catch {
          // skip unreadable entries
        }
      }
    }
    out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))
    return out
  }

  /** Delete an entry file; returns the deleted path or undefined. */
  remove(id: string, workspace?: string): string | undefined {
    const dirs = [this.globalDir()]
    if (workspace !== undefined) dirs.push(this.projectDir(workspace))
    for (const dir of dirs) {
      const file = join(dir, `${id}.md`)
      try {
        rmSync(file)
        return file
      } catch {
        // continue
      }
    }
    return undefined
  }
}
