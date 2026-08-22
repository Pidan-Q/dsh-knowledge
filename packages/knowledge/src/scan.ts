/**
 * KnowledgeScanner —— 按《项目知识库扫描范围.md》《全局知识库扫描范围.md》
 * 实现的无 LLM 确定性扫描：把项目工作区 / DSH home 的文档与配置文件提取为
 * 知识条目（经 EntryStore 落盘为 frontmatter + Markdown）。
 *
 * 幂等：以 `scope + source` 为键，已存在的 source 跳过（只新增，绝不覆盖
 * 或删除既有条目）。排除规则、分类表、提取规则见两份规格文档。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { EntryStore, type EntryCategory, type KnowledgeEntry } from '@dsh-plugins/shared'

/**
 * 把路径规范化为正斜杠分隔（Windows 兼容关键）。
 * 理由：条目经 YAML frontmatter 落盘，反斜杠会被 JSON 引号包裹而最小
 * YAML 解析器不做转义解码，往返后变成双反斜杠、幂等键失配；正斜杠匹配
 * 简单 YAML 标量模式、裸存无损往返，且 Node fs 在 Windows 上接受正斜杠。
 */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

/** 扫描语义分类（见两份扫描范围文档）；落盘时经 CATEGORY_MAP 映射为条目 schema 的合法分类。 */
export type ScanCategory =
  | 'architecture' | 'deployment' | 'devices' | 'conventions' | 'glossary' | 'decisions' | 'environment'

/** 语义分类 → 条目 category（条目 schema 仅允许 convention/fact/decision/pitfall/lesson；
 * 语义分类原样保留在 tags 首位）。 */
export const CATEGORY_MAP: Record<ScanCategory, EntryCategory> = {
  architecture: 'fact',
  deployment: 'fact',
  devices: 'fact',
  conventions: 'convention',
  glossary: 'fact',
  decisions: 'decision',
  environment: 'fact',
}

/** 单个扫描源文件的分类归属。 */
export interface ScanSource {
  category: ScanCategory
  /** 相对扫描根的 glob 列表（`*` 单段、`**` 跨段），按序匹配、首个命中生效。 */
  patterns: string[]
}

/** 项目层分类表（与《项目知识库扫描范围.md》第 3 节一一对应）。 */
export const PROJECT_SOURCES: readonly ScanSource[] = [
  { category: 'architecture', patterns: ['README.md', 'AGENTS.md', 'docs/architecture*.md', 'docs/adr/**/*.md'] },
  { category: 'deployment', patterns: ['package.json', 'Dockerfile', 'docker-compose.yml', 'Makefile', '.env.example', 'docs/deploy*.md'] },
  { category: 'devices', patterns: ['docs/devices*.md', 'docs/devices/**/*.md', 'config/**/*.yaml', 'ha-config/**/*.yaml'] },
  { category: 'conventions', patterns: ['AGENTS.md', 'CONTRIBUTING.md', '.editorconfig', 'tsconfig.json', 'eslint.config.*', 'docs/conventions*.md'] },
  { category: 'glossary', patterns: ['README.md', 'docs/glossary*.md', 'docs/domain*.md'] },
  { category: 'decisions', patterns: ['docs/adr/**/*.md', 'docs/decisions*.md', 'docs/rfcs/**/*.md', 'CHANGELOG.md'] },
]

/** 全局层分类表（与《全局知识库扫描范围.md》第 3 节对应）。 */
export const GLOBAL_SOURCES: readonly ScanSource[] = [
  { category: 'environment', patterns: [] },
  { category: 'conventions', patterns: [] },
]

const MAX_FILE_BYTES = 256 * 1024
const MAX_BODY_CHARS = 8 * 1024
const MAX_HEAD_LINES = 40
const MAX_HEADINGS = 30
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.dsh', 'dist', 'build', 'out', 'coverage', 'lib'])
const EXCLUDED_FILES = new Set([
  '.env', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'npm-shrinkwrap.json',
  '.gitignore', '.npmrc', '.gitmodules', '.gitattributes',
])
const EXCLUDED_EXT = new Set(['.log', '.pid', '.socket', '.sqlite', '.sqlite3', '.db', '.lock'])

/** 扫描结果。 */
export interface ScanResult {
  /** 命中扫描源且通过排除规则的文件数。 */
  scanned: number
  /** 实际写入的条目数。 */
  generated: number
  /** 跳过数（重复 source / 空内容 / 超限）。 */
  skipped: number
  /** 本次新生成的条目。 */
  entries: KnowledgeEntry[]
}

/** 把 glob 编译为正则：单个星号匹配单段、双星号匹配跨段（双星后接斜杠时前缀可匹配零目录）。 */
export function globToRegExp(pattern: string): RegExp {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 3
        } else {
          re += '.*'
          i += 2
        }
      } else {
        re += '[^/]*'
        i += 1
      }
      continue
    }
    re += c.replace(/[\\^$+()[\]{}|]/g, '\\$&')
    i += 1
  }
  return new RegExp(`^${re}$`)
}

/** 项目层路径排除：目录/文件名/扩展名黑名单。 */
export function isProjectExcluded(relPath: string): boolean {
  const segments = relPath.split('/')
  if (segments.some((seg) => EXCLUDED_DIRS.has(seg))) return true
  const name = segments[segments.length - 1] ?? ''
  if (EXCLUDED_FILES.has(name)) return true
  const ext = extnameOf(name)
  if (EXCLUDED_EXT.has(ext)) return true
  if (name === '.env' || (name.startsWith('.env.') && !name.endsWith('.example'))) return true
  return false
}

function extnameOf(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx <= 0 ? '' : name.slice(idx)
}

/** 判断文本是否为可读 UTF-8（含 NUL 即视为二进制）。 */
export function looksBinary(buf: Buffer): boolean {
  return buf.includes(0)
}

/** 生成形如 kb-YYYYMMDD-NNN 的条目 id（当日已有序号递增）。 */
export function nextScanId(existing: readonly KnowledgeEntry[], date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const prefix = `kb-${y}${m}${d}-`
  let max = 0
  for (const entry of existing) {
    if (!entry.id.startsWith(prefix)) continue
    const seq = Number(entry.id.slice(prefix.length))
    if (Number.isInteger(seq) && seq > max) max = seq
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`
}

/** Markdown 正文提取：头部若干行 + 全部 `##`/`###` 小节标题。 */
export function extractMarkdownBody(text: string): string {
  const lines = text.split(/\r?\n/)
  const head: string[] = []
  let started = false
  for (const line of lines) {
    if (head.length >= MAX_HEAD_LINES) break
    if (!started && line.trim() === '') continue
    started = true
    head.push(line)
  }
  const headings = lines.filter((line) => /^#{2,3}\s/.test(line)).slice(0, MAX_HEADINGS)
  const parts: string[] = []
  const headText = head.join('\n').trim()
  if (headText.length > 0) parts.push(headText)
  if (headings.length > 0) parts.push('## 小节', ...headings.map((h) => h.trim()))
  return parts.join('\n\n').slice(0, MAX_BODY_CHARS)
}

/** package.json 提取：name/description/scripts + 依赖键名清单。 */
export function extractPackageJson(text: string): string {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>
    const lines: string[] = []
    if (typeof pkg.name === 'string') lines.push(`name: ${pkg.name}`)
    if (typeof pkg.description === 'string') lines.push(`description: ${pkg.description}`)
    if (pkg.scripts !== undefined && typeof pkg.scripts === 'object' && pkg.scripts !== null) {
      lines.push('scripts:')
      for (const [key, value] of Object.entries(pkg.scripts as Record<string, unknown>)) {
        lines.push(`  ${key}: ${String(value)}`)
        if (lines.length > MAX_HEAD_LINES + 8) break
      }
    }
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      const deps = pkg[section]
      if (deps !== undefined && typeof deps === 'object' && deps !== null) {
        const keys = Object.keys(deps as Record<string, unknown>)
        lines.push(`${section} (${keys.length}): ${keys.slice(0, 60).join(', ')}`)
      }
    }
    return lines.join('\n').slice(0, MAX_BODY_CHARS)
  } catch {
    return ''
  }
}

/** Dockerfile 提取：FROM/ENV/RUN/EXPOSE/CMD/WORKDIR 指令行。 */
export function extractDockerfile(text: string): string {
  const wanted = /^(FROM|ENV|RUN|EXPOSE|CMD|WORKDIR|ARG|LABEL)\b/
  return text.split(/\r?\n/).filter((line) => wanted.test(line.trim())).slice(0, MAX_HEAD_LINES).join('\n').slice(0, MAX_BODY_CHARS)
}

/** docker-compose 提取：服务名 + image + ports。 */
export function extractCompose(text: string): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let service: string | undefined
  for (const raw of lines) {
    const line = raw.trimEnd()
    const svc = /^  ([A-Za-z0-9_.-]+):\s*$/.exec(line)
    if (svc) {
      service = svc[1]!
      out.push(`service ${service}:`)
      continue
    }
    const image = /^    image:\s*(.+)$/.exec(line)
    if (image && service !== undefined) out.push(`  image: ${image[1]!.trim()}`)
    const ports = /^    ports:\s*$/.exec(line)
    if (ports && service !== undefined) out.push('  ports: …')
    if (out.length > MAX_HEAD_LINES + 12) break
  }
  return out.join('\n').slice(0, MAX_BODY_CHARS)
}

/** Makefile 提取：顶层 target 名。 */
export function extractMakefile(text: string): string {
  const targets = text.split(/\r?\n/)
    .filter((line) => /^[A-Za-z0-9_.-]+:/.test(line) && !line.startsWith(' ') && !line.startsWith('\t'))
    .map((line) => line.split(':')[0]!.trim())
  return targets.length > 0 ? `targets:\n${targets.map((t) => `  ${t}`).join('\n')}`.slice(0, MAX_BODY_CHARS) : ''
}

/** 通用文本提取：头部若干行 + 顶层 key（YAML 配置类）。 */
export function extractPlain(text: string): string {
  const lines = text.split(/\r?\n/)
  const head: string[] = []
  let started = false
  for (const line of lines) {
    if (head.length >= MAX_HEAD_LINES) break
    if (!started && line.trim() === '') continue
    started = true
    head.push(line)
  }
  return head.join('\n').trim().slice(0, MAX_BODY_CHARS)
}

/** os-release 提取：NAME / VERSION / PRETTY_NAME。 */
export function extractOsRelease(text: string): string {
  return text.split(/\r?\n/)
    .filter((line) => /^(NAME|VERSION|PRETTY_NAME)=/.test(line))
    .join('\n')
    .slice(0, MAX_BODY_CHARS)
}

/** ~/.bashrc 提取：alias 行。 */
export function extractBashAliases(text: string): string {
  return text.split(/\r?\n/).filter((line) => /^\s*alias\s/.test(line)).join('\n').slice(0, MAX_BODY_CHARS)
}

/** 按文件名选择提取器。 */
export function extractFor(name: string, text: string): string {
  if (name === 'package.json') return extractPackageJson(text)
  if (name === 'Dockerfile') return extractDockerfile(text)
  if (name === 'docker-compose.yml') return extractCompose(text)
  if (name === 'Makefile') return extractMakefile(text)
  if (name.endsWith('.md')) return extractMarkdownBody(text)
  if (name === '/etc/os-release') return extractOsRelease(text)
  return extractPlain(text)
}

/** 递归收集扫描根下全部相对路径（posix 分隔），跳过排除目录。 */
export function walkFiles(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    names.sort()
    for (const name of names) {
      if (EXCLUDED_DIRS.has(name)) continue
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) visit(full)
      else if (st.isFile()) out.push(relative(root, full).split(sep).join('/'))
    }
  }
  visit(root)
  return out
}

/** 知识扫描器：项目层 / 全局层。 */
export class KnowledgeScanner {
  private readonly store: EntryStore
  private readonly dshHome: string

  constructor(store: EntryStore, dshHome?: string) {
    this.store = store
    this.dshHome = dshHome ?? store.dshHome
  }

  /** 项目层扫描：按 PROJECT_SOURCES 匹配 workspace 下文件并生成条目。
   * @param targetDir - 用户自定义落盘目录；缺省写入 <workspace>/.dsh/knowledge。 */
  scanProject(workspace: string, targetDir?: string): ScanResult {
    const result: ScanResult = { scanned: 0, generated: 0, skipped: 0, entries: [] }
    const today = new Date().toISOString().slice(0, 10)
    // 自定义落盘时按该目录读既有条目做幂等与序号（默认仍走层目录）
    const existing = targetDir === undefined ? this.store.list(workspace) : this.store.listDir(targetDir)
    const seen = new Set(existing.filter((e) => e.source !== undefined).map((e) => `${e.scope}::${e.source}`))
    const ids = existing.slice()

    // 收集 相对路径 → 语义分类（首个匹配分类生效，预编译正则、单次遍历）
    const compiled = PROJECT_SOURCES.map((source) => ({
      category: source.category,
      regexps: source.patterns.map(globToRegExp),
    }))
    const matched = new Map<string, ScanCategory>()
    for (const file of walkFiles(workspace)) {
      if (isProjectExcluded(file)) continue
      for (const source of compiled) {
        if (source.regexps.some((re) => re.test(file))) {
          matched.set(file, source.category)
          break
        }
      }
    }

    for (const [file, semantic] of [...matched.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const full = join(workspace, file)
      // 落盘路径统一规范化为正斜杠（Windows 往返无损，幂等键稳定）
      const fullPosix = toPosix(full)
      const workspacePosix = toPosix(workspace)
      let buf: Buffer
      try {
        if (statSync(full).size > MAX_FILE_BYTES) {
          result.skipped += 1
          continue
        }
        buf = readFileSync(full)
      } catch {
        result.skipped += 1
        continue
      }
      if (looksBinary(buf)) {
        result.skipped += 1
        continue
      }
      result.scanned += 1
      const text = buf.toString('utf8')
      const body = extractFor(basename(file), text)
      if (body.trim().length === 0) {
        result.skipped += 1
        continue
      }
      const key = `project::${fullPosix}`
      if (seen.has(key)) {
        result.skipped += 1
        continue
      }
      const entry: KnowledgeEntry = {
        id: nextScanId(ids),
        scope: 'project',
        workspace: workspacePosix,
        category: CATEGORY_MAP[semantic],
        tags: [semantic, extnameOf(basename(file)).slice(1) || 'txt', 'scanned'],
        title: file,
        body,
        created: today,
        lastUsed: today,
        hitCount: 0,
        confidence: 0.6,
        source: fullPosix,
        status: 'raw',
      }
      ids.push(entry)
      seen.add(key)
      if (targetDir === undefined) this.store.write(entry, workspace)
      else this.store.writeTo(entry, toPosix(targetDir))
      result.generated += 1
      result.entries.push(entry)
    }
    return result
  }

  /** 全局层扫描：DSH home 配置 + 少量只读系统信息源。
   * @param targetDir - 用户自定义落盘目录；缺省写入 <dshHome>/knowledge/global。 */
  scanGlobal(targetDir?: string): ScanResult {
    const result: ScanResult = { scanned: 0, generated: 0, skipped: 0, entries: [] }
    const today = new Date().toISOString().slice(0, 10)
    const existing = targetDir === undefined ? this.store.list() : this.store.listDir(targetDir)
    const seen = new Set(existing.filter((e) => e.source !== undefined).map((e) => `${e.scope}::${e.source}`))
    const ids = existing.slice()

    const sources: { title: string; path: string; category: ScanCategory; extract: (text: string) => string }[] = [
      { title: this.displayHome('settings.yaml'), path: join(this.dshHome, 'settings.yaml'), category: 'environment', extract: extractPlain },
      { title: this.displayHome('cordis.patch.yml'), path: join(this.dshHome, 'cordis.patch.yml'), category: 'conventions', extract: extractPlain },
    ]
    // 平台专属源：显式按平台守卫，Windows 上根本不尝试（不存在也不报错）
    if (process.platform === 'linux') {
      sources.push({ title: '/etc/os-release', path: '/etc/os-release', category: 'environment', extract: extractOsRelease })
    }
    if (process.platform !== 'win32') {
      sources.push({ title: '~/.bashrc', path: join(homedir(), '.bashrc'), category: 'environment', extract: extractBashAliases })
    }
    // profiles/*/package.json（环境）与 cordis.patch.yml（约定）
    const profilesDir = join(this.dshHome, 'profiles')
    if (existsSync(profilesDir)) {
      let profiles: string[]
      try {
        profiles = readdirSync(profilesDir).sort()
      } catch {
        profiles = []
      }
      for (const name of profiles) {
        const profileDir = join(profilesDir, name)
        try {
          if (!statSync(profileDir).isDirectory()) continue
        } catch {
          continue
        }
        sources.push({
          title: this.displayHome(`profiles/${name}/package.json`),
          path: join(profileDir, 'package.json'),
          category: 'environment',
          extract: extractPackageJson,
        })
        sources.push({
          title: this.displayHome(`profiles/${name}/cordis.patch.yml`),
          path: join(profileDir, 'cordis.patch.yml'),
          category: 'conventions',
          extract: extractPlain,
        })
      }
    }

    for (const source of sources) {
      let buf: Buffer
      try {
        if (statSync(source.path).size > MAX_FILE_BYTES) {
          result.skipped += 1
          continue
        }
        buf = readFileSync(source.path)
      } catch {
        // 全局源缺失/不可读是常态，静默跳过
        result.skipped += 1
        continue
      }
      if (looksBinary(buf)) {
        result.skipped += 1
        continue
      }
      result.scanned += 1
      const body = source.extract(buf.toString('utf8'))
      if (body.trim().length === 0) {
        result.skipped += 1
        continue
      }
      // 落盘路径统一规范化为正斜杠（Windows 往返无损，幂等键稳定）
      const pathPosix = toPosix(source.path)
      const key = `global::${pathPosix}`
      if (seen.has(key)) {
        result.skipped += 1
        continue
      }
      const entry: KnowledgeEntry = {
        id: nextScanId(ids),
        scope: 'global',
        category: CATEGORY_MAP[source.category],
        tags: [source.category, basename(source.path), 'scanned'],
        title: source.title,
        body,
        created: today,
        lastUsed: today,
        hitCount: 0,
        confidence: 0.6,
        source: pathPosix,
        status: 'raw',
      }
      ids.push(entry)
      seen.add(key)
      if (targetDir === undefined) this.store.write(entry)
      else this.store.writeTo(entry, toPosix(targetDir))
      result.generated += 1
      result.entries.push(entry)
    }
    return result
  }

  /** 把 $DSH_HOME 下的路径显示为 ~/.dsh/...（若 dshHome 即 ~/.dsh；Windows 上 HOME 不存在，用 os.homedir）。 */
  private displayHome(rel: string): string {
    const home = homedir()
    if (resolve(this.dshHome) === resolve(join(home, '.dsh'))) {
      return join('~/.dsh', rel).split(sep).join('/')
    }
    return toPosix(join(this.dshHome, rel))
  }
}
