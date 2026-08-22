# DSH 技能与知识插件 — 需求与技术设计

> 上游输入：`技能与知识插件设计思路.md`（v1，2026-08-18）+ DSH 官方文档与源码调研（v2，2026-08-18）
> 文档版本：v3.0 | 日期：2026-08-21 | 状态：已实现，含平台实测修订
>
> **v3.0 修订要点**（与已安装的 `dsh-skills-manager` 解冲突）：
> 1. M3 更名 **skill-manager → lesson-promote**（包 `@dsh-plugins/lesson-promote`，插件 id / 工具名 / 服务 `ctx.lessonPromote` 同步更名）：已装 `dsh-skills-manager`（skill provider，name=`skill-manager`，rank 50）负责技能安装/启用/停用/更新/移除，本插件不再占用 "skill-manager" 名字；
> 2. **删除版本快照与 `rollback`**：技能版本/生命周期管理归已装 `dsh-skills-manager`；草稿目录默认 `.dsh/lesson-promote/drafts`；
> 3. **approve 同名冲突守卫**：落盘前查询 `ctx.skills` 注册表，同名技能若来自其他来源（dsh-skills-manager / runtime / user / bundled）则拒绝——已装插件优先、不产生遮蔽；仅自己部署层（filesystem/project-dsh）允许幂等重写；注册表查询失败时 fail-closed 拒绝。
>
> **v2.1 修订要点**（基于 DSH 0.1.0-rc.8 平台实测与 `dsh plugin add` 安装验证，v3.0 保留）：
> 1. skill-manager 注册机制改为**文件落盘优先**：不再调用 `ctx.skills.register()`（平台实测：内置 skill-filesystem 默认扫描 `.dsh/skills`，项目层 rank 100 高于 runtime 层 250，且同名预检查会命中自己刚写的草稿导致自阻塞）；
> 2. 草稿与正式技能彻底分离：草稿只写 `.dsh/lesson-promote/drafts/`，`approve` 才落盘 `.dsh/skills/<name>/SKILL.md`；
> 3. 版本快照默认目录迁出 `~/.dsh/skill-manager/`（已被 dsh-skills-manager 占用；v3.0 起不再生成版本快照）；
> 4. 宿主依赖改为 npm 版本（`dsh-*@0.1.0-rc.8`），仓库可独立构建测试；`@dsh-plugins/shared` 依赖声明为 `file:../shared`，`dsh plugin add <path>` 安装时随插件一并解析，无需仓库根前置安装。

## 一、需求分析

### 1.1 目标

在 DeepSeek Harness（DSH）生态中实现三个协同 Cordis 插件，打通闭环：

**自动捕获错误 → 提炼教训 → 晋升技能 → 执行前主动预警**

### 1.2 模块拆分与优先级

| 模块 | 插件包 | 优先级 | 职责 |
|---|---|---|---|
| M1 双层知识库 | `@dsh-plugins/knowledge` | P0 | 项目/全局双层知识条目存储、BM25 检索、主动注入 |
| M2 错误捕获学习 | `@dsh-plugins/errata` | P0 | 订阅工具事件捕获错误、记录教训、触发式预警注入 |
| M3 错题本晋级 | `@dsh-plugins/lesson-promote` | P1 | 教训晋升为技能草稿、审批落盘（含同名冲突守卫；无版本/回滚，生命周期归已装 dsh-skills-manager） |
| M4 共享基础设施 | `@dsh-plugins/shared` | P0 | 条目 Schema、frontmatter 读写、轻量 BM25、路径解析（被 M1/M2/M3 依赖） |

### 1.3 依赖关系

```
M4 shared
 ├─ M1 knowledge（检索/存储）
 ├─ M2 errata（教训条目写入）
 └─ M3 lesson-promote（晋升草稿生成）
M2 → M1（教训落库）；M3 → M2（扫描可晋升条目）
```

### 1.4 约束与假设

1. **运行环境**：DSH 宿主注入 `tools` / `agents` / `skills` / `fs` 等服务（`inject` 声明）；插件自身不启动服务端。
2. **不依赖 LLM 也能运行**：后台提炼为可插拔——无 LLM 服务时用规则式提炼（去重、频次统计），配置 LLM 服务后可用 `ctx.llm` 生成根因与修复模板（v2.1 尚未实现，见 §3.3 预留扩展点）。
3. **落盘持久化**：知识/教训条目一律写文件（Markdown + frontmatter），不依赖 Cordis 内存 Context。
4. **临时注入可回收**：预警注入、运行时注册的临时 Skill 属于可回收副作用；正式落盘条目属于持久副作用。
5. **Node ^22.19 || >=24、pnpm workspace 独立工程**：插件工程独立于 DSH 官方仓库，不修改官方代码。
6. **安装自包含（替代 v2.1 安装前置）**：`@dsh-plugins/shared` 依赖从 `workspace:*` 改为 `file:../shared`——`dsh plugin add <path>` 安装时 pnpm 按相对路径把 shared 一并装入 profile，无需先仓库根 `pnpm install`。后续发布 `@dsh-plugins/shared` 可改用真实版本号。

## 二、技术选型

| 项 | 选型 | 依据 |
|---|---|---|
| 语言 | TypeScript 5.x（strict） | DSH 官方栈；`tsc -b` 构建 |
| 运行时 | Node.js >= 22.19 | DSH engines 要求 |
| 包管理 | pnpm workspace | 与 DSH 一致；`dsh plugin add` 是 pnpm 转发器 |
| 测试 | Vitest | DSH 官方测试框架 |
| 宿主依赖 | `@deepseek-ai/cordis@^4.0.1`、`@deepseek-ai/dsh-*@0.1.0-rc.8`（peer + dev 双声明） | v2.1 起直接使用 npm 发布版本，不再 `link:` 本地仓库构建产物 |
| 存储 | Markdown + frontmatter（对齐 SKILL.md） | 可观测、可进 Git、与 Skill 互转 |
| 检索 | 自实现轻量 BM25 + 标签过滤 | 避免向量库重路线 |

### 2.1 架构分层

```
┌────────────────────────────────────────────────┐
│ dsh-plugins workspace（独立工程）                │
│  shared ← knowledge ← errata ← lesson-promote    │
└──────────────────────────┬─────────────────────┘
                           │ inject: tools/agents/skills
┌──────────────────────────▼─────────────────────┐
│ DSH Harness 宿主（Cordis 运行时，已实测 rc.8）    │
│  - tools/pre-execute / tools/result 流水线事件  │
│  - skill-filesystem（默认扫描 .dsh/skills，rank 100）│
│  - ctx.skills 注册表（runtime 层 rank 250）      │
└────────────────────────────────────────────────┘
```

### 2.2 版本兼容矩阵（v2.1 实测）

| 宿主包 | 版本 | 说明 |
|---|---|---|
| `@deepseek-ai/cordis` | 4.0.1 | `^4.0.1` |
| `@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-session` / `dsh-tools` / `dsh-skill` | 0.1.0-rc.8 | 精确锁定；`defineTool` 输出 schema（含 `type:'json'`）、`tools/pre-execute` waterfall（prepend）、`agent.inject`、`ctx.skills.list/register` 均已按此版本验证 |

## 三、接口设计

### 3.1 共享 Schema（M4 shared）

条目统一格式（`knowledge` 与 `errata` 共用，`errata` 产物可转 `knowledge` 条目或技能草稿）：

```ts
interface KnowledgeEntry {
  id: string                    // kb-YYYYMMDD-NNN
  scope: 'project' | 'global' | 'session'   // session 层为预留，v2.1 工具未暴露
  workspace?: string            // project 层必填
  category: 'convention' | 'fact' | 'decision' | 'pitfall' | 'lesson'
  tags: string[]
  title: string
  body: string
  created: string               // ISO date
  lastUsed: string
  hitCount: number
  confidence: number            // 0..1
  source?: string               // trajectory-ref:evt_xxx 等可追溯引用
  status: 'raw' | 'distilled' | 'promoted' | 'archived'   // promoted/archived 为预留状态
}

interface ErrorLesson extends KnowledgeEntry {
  category: 'lesson'
  tool: string                  // 出错工具名
  argsHashPrefix: string        // 参数哈希前缀，用于命中匹配
  errorType: string
  fix?: string
  relatedSkillId?: string
}
```

存储布局：
```
~/.dsh/knowledge/global/<id>.md          # 全局层（$DSH_HOME/knowledge/global）
<workspace>/.dsh/knowledge/<id>.md       # 项目层（随 Git 走）
```
文件格式：YAML frontmatter（元数据）+ Markdown 正文（与 SKILL.md 同构，可互转）。

### 3.2 dsh-knowledge 插件（M1）

**注入服务**：`['tools', 'agents']`

**暴露工具**（`ctx.tools.register(defineTool(...))`）：

| 工具 | 参数 | 行为 |
|---|---|---|
| `kb.search` | `query: string`（必填）、`scope?: 'project'\|'global'`、`category?: string`、`topK?: number`（默认 5） | BM25 + 标签过滤，返回 Top-K 条目（标题+正文片段+作用域+置信度） |
| `kb.remember` | `title`（必填）、`body`（必填）、`scope`（默认 project）、`category`（默认 fact）、`tags` | 写入知识条目，返回条目 id |
| `kb.forget` | `id` | 删除条目（项目层可删，全局层需 `allowGlobalWrite` 配置） |

**主动注入**：`Config.injections: string[]`（v2.1 与实现一致，为纯文本列表；原设计 `{title, body}[]` 已简化）——通过 `agent/created` 事件对每个 agent `agent.inject()` 注入必读条目全文。

**作用域解析**：`projectRoot = 最近含 .git 的祖先目录（找不到用 cwd）`；检索合并 `project → global`，项目层优先。

### 3.3 dsh-errata 插件（M2）

**注入服务**：`['agents', 'tools']`（落盘直接走 node:fs，不依赖 `fs` 服务注入；`llm` 为预留可选注入）

**事件订阅**：

| 事件 | 模式 | 用途 |
|---|---|---|
| `tools/result` | emit | 观察 `ToolExecutionResult`，`isError === true` 时即时记录原始错误（`tool + errorType + argsHashPrefix + trajectory 引用`），并更新同模式计数 |
| `tools/pre-execute` | waterfall（prepend） | 命中失败模式（`tool + argsHashPrefix` 前缀匹配且历史失败 ≥ 阈值）时，通过 `exec.agent.inject()` 注入预警文本到下一步上下文；返回 `next()` 放行 |
| `agent/turn-end`（`turn/end` session 事件） | emit | **预留扩展点（v2.1 未实现）**：会话边界触发提炼检查 |

**触发式预警注入**（核心机制，与 MisakaNet 的被动查询互补）：

```
tools/pre-execute 触发
  → exec.name + argsHash(args) 前缀匹配错误库
  → 命中且历史失败 ≥ Config.warnAfterFailures（默认 1）
  → exec.agent.inject({
      content: [{ type: 'text', text: 预警文案 }],
      source: { kind: 'errata-warning' }
    })
  → return next()
```

预警文案模板：`上次类似调用(tool X)失败 N 次，原因是 {errorType}，建议先 {fix 或 参考条目}。`

**提炼策略**（v2.1 实现规则式；LLM 式为预留扩展点）：
- 规则式（已实现）：同类错误（同 tool + errorType）累计 ≥ `Config.promoteAfterFailures`（默认 3）时，生成 `status: 'distilled'` 教训条目（含触发条件、错误类型、修复方式留占位待审）。
- LLM 式（预留）：`Config.llm?: boolean` 且宿主提供 `llm` 服务时，调用 `ctx.llm` 生成根因与修复模板（`root_cause_hint`、`fix`）。
- 提炼产物（`status='distilled'` 且计数达标）进入 `lesson-promote` 待审核队列。

### 3.4 lesson-promote 插件（M3，v3.0 由 skill-manager 更名）

**注入服务**：`['skills', 'agents', 'tools']`（`skills` 用于 approve 同名冲突守卫；`agents`/`tools` 为宿主服务）

**职责（v3.0 重设计：只做错题本晋级，不做技能生命周期管理）**：

1. **晋升管道**：扫描 `errata` 的可晋升条目（`status: 'distilled'` 且失败计数达标）→ 生成**技能草稿文件** `<workspace>/.dsh/lesson-promote/drafts/<name>.md`（frontmatter = 记录字段 + 技能字段超集，正文 = 技能正文；批准前可人工编辑，扫描不覆盖已存在草稿的文档）→ 写入待审核清单。
2. **审批落盘**：审核通过（`Config.autoApprove` 为 true 时自动，否则需用户显式调用 `lesson-promote approve <name>`）后，把草稿文档渲染为正式 SKILL.md 写入 `<workspace>/.dsh/skills/<name>/SKILL.md`。
   - **不再调用 `ctx.skills.register()`**：平台内置 `skill-filesystem` 默认扫描 `<project>/.dsh/skills`（项目层 rank 100），文件落盘即被自动发现与加载，且 rank 高于 runtime 层（250）。运行时注册会与 FS 副本同名遮蔽，且"同名预检查"会命中自己刚写的草稿造成永久自阻塞——均已实测，故删除。
3. **同名冲突守卫（v3.0 新增）**：落盘前查询 `ctx.skills.snapshot({ cwd })` 注册表：
   - 同名技能来自其他来源（已装 `dsh-skills-manager` 库 provider=`skill-manager`、runtime、user-dsh、bundled 等）→ **拒绝批准**并报告 provider/source，已装插件优先、不产生遮蔽（dsh-skills-manager rank 50 < 项目层 100，同名时我方会被遮蔽，因此必须前置拒绝）；
   - 同名技能来自本插件自己的部署层（provider=`filesystem`，source=`project-dsh`）→ 允许幂等重写；
   - 注册表查询失败 → **fail-closed 拒绝**（无法确认无冲突就不落盘）。
4. **命令**：提供 `lesson-promote list|approve <name>` 工具（`ctx.tools.register`），无 `rollback`（版本/回滚功能已删除，归已装 `dsh-skills-manager` 管理）。

**SKILL.md frontmatter 规范**（对齐 DSH `skill-filesystem` 解析；正式文件只含技能字段）：
```yaml
---
name: <kebab-case>          # 必填，^[a-z0-9]+(?:-[a-z0-9]+)*$
description: <非空字符串>     # 必填
whenToUse: <可选>
metadata: { errataRef: <条目id>, confidence: <数值>, tool: <工具>, errorType: <类型> }
---
<正文>
```
注意：禁止使用旧驼峰键（`disableModelInvocation` 等会整体拒绝该 skill）。

### 3.5 副作用回收边界（v2.1 修订）

| 副作用 | 回收策略 | 实现 |
|---|---|---|
| 预警注入的 `agent.inject` 消息 | 随 agent 生命周期自然回收 | 无持久化 |
| ~~运行时注册的临时 Skill~~ | ~~`ctx.skills.register()` 返回 disposer，`ctx.effect` 登记~~ | **v2.1 已移除**：改为文件落盘，无运行时注册 |
| 知识/教训条目文件 | **持久，不回收** | 写入 `~/.dsh/knowledge` / `<ws>/.dsh/knowledge`，走独立审批（`kb.forget` 删除） |
| 技能草稿（`.dsh/lesson-promote/drafts/`） | **持久** | 可进 Git；批准前不产生任何运行时效果 |
| 正式技能（`.dsh/skills/<name>/SKILL.md`） | **持久** | 仅 approve 写入，由内置 skill-filesystem 加载 |

### 3.6 安全与质量闸

1. **写全局库需配置**：`allowGlobalWrite` 默认 `false`，`kb.remember(scope: 'global')` 在未配置时报错提示。
2. **预警文案脱敏**：只含工具名、错误类型、建议方向，绝不包含参数原文中的敏感值（参数只做哈希前缀匹配，不落库原文）。
3. **阈值防噪**：错误计数不足（< `warnAfterFailures`）不注入预警；提炼需失败次数达标，防止单次偶发错误污染。
4. **过期归档**：条目 `lastUsed` 超过 `Config.forgetAfterDays`（默认 180）且 `hitCount` 为 0 时，标记 `archived` 供清理。**（v2.1 尚未实现，`archived` 为预留状态）**
5. **项目层可进 Git 可 review**：`.dsh/knowledge`、`.dsh/lesson-promote/drafts`、`.dsh/skills` 均在项目根内。
6. **日志脱敏**：不记录模型参数原文、不记录密钥类信息。

## 四、实施计划

| 步骤 | 内容 | 验证 |
|---|---|---|
| S1 | 搭建 workspace 骨架 + M4 shared（schema/存储/BM25） | `tsc -b` 通过，BM25 单测 |
| S2 | M1 knowledge（工具 + 注入 + 双层解析） | `kb.search/remember` 单测 |
| S3 | M2 errata（捕获 + 预警注入 + 提炼） | 错误捕获/预警注入单测 |
| S4 | M3 lesson-promote（晋升 + 落盘 + 冲突守卫） | 晋升单测（`tests/promote.spec.ts`，8 用例） |
| S5 | 打包 `cordis.patch.yml` + README + 安装到 profile 冒烟 | `dsh plugin add` 成功；**验收项：仓库根 `pnpm install` 后 `@dsh-plugins/shared` 在插件运行时解析成功；与 dsh-skills-manager 同 profile 共存无冲突（无同名工具/服务/插件 id；`.dsh/skills` 草稿不泄漏）** |
| S6 | 代码审查 + 全量测试 + 交付 | vitest 通过（v2.1 已执行） |

## 五、与调研事实的差异修正

### 5.1 v2.0 既有修正（保留）

| 原设计假设 | 实际（调研结论） | 应对 |
|---|---|---|
| 订阅 `tool/start` 注入预警 | 无 `tool/start` 事件；执行前拦截点是 `tools/pre-execute`（waterfall） | 改用 `tools/pre-execute` + `agent.inject` |
| 订阅 `tool/result(isError=true)` | `tool/result` 是 session 持久日志事件；运行时观察用 `tools/result`（emit），`isError` 在 `ToolExecutionResult` | 用 `tools/result` 做实时捕获 |
| 错误后用户纠正（turn/end 负反馈） | `turn/end` 存在但无"用户纠正"结构化事件 | v2.1 不实现语义级纠正捕获，留扩展点 |
| `ctx.skills.register()` 签名 | `SkillRegistration` 必填 name/description/content，rank 由作用域决定（runtime=250） | v2.1 起主流程不再调用（见 5.2） |
| 插件打包 | `package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` insert 行 | 按真实规范打包 |

### 5.2 v2.1 新增修正（平台实测）

| 原设计假设 | 平台事实（0.1.0-rc.8 实测） | 应对 |
|---|---|---|
| 草稿写入 `.dsh/skills/`，审批后 `ctx.skills.register()` 注册 | 内置 skill-filesystem 默认扫描 `<project>/.dsh/skills`（rank 100），**写文件即生效**；runtime 注册 rank 250 被同名遮蔽；`ctx.skills.list()` 同名预检查命中自己刚写的草稿 → approve 永久自阻塞 | 草稿只写 `.dsh/lesson-promote/drafts/`；approve 落盘 `.dsh/skills/<name>/SKILL.md`；删除 register 与预检查 |
| 版本快照放 `~/.dsh/skill-manager/versions/` | `~/.dsh/skill-manager/` 已被 dsh-skills-manager 占用（`state.json` 严格校验 + `.agents/skills`） | v2.1 迁至 `~/.dsh/dsh-plugins/skill-manager/versions/`；**v3.0 起删除版本快照**（技能版本管理归已装 dsh-skills-manager） |
| `dsh plugin add` 一条命令安装 | link 安装下 `@dsh-plugins/shared`（`workspace:*`）不解析，插件加载即崩（实测 `Cannot find package '@dsh-plugins/shared'`） | 依赖改为 `file:../shared`，`dsh plugin add` 安装时自动解析；发布 shared 后可改用真实版本号 |
| devDeps `link:` 本地 DSH 仓库构建产物 | 仓库独立于官方，链接目标不可移植 | 改用 npm 版本（`cordis@^4.0.1`、`dsh-*@0.1.0-rc.8`），可独立构建/测试 |
| peerDeps `dsh-*@0.1.0-rc.5` | 运行时宿主为 rc.8（profile `autoInstallPeers: false`） | peer 锁定 `0.1.0-rc.8`，与兼容矩阵一致 |

### 5.3 v3.0 新增修正（与已装插件解冲突）

| 原设计 | 冲突事实 | 应对 |
|---|---|---|
| M3 插件 id / 工具名 / 服务名用 `skill-manager` | 已装 `dsh-skills-manager` 的 skill provider 名就叫 `skill-manager`（rank 50），注册表不同但名字易混 | 更名 **lesson-promote**（包/插件 id/工具/`ctx.lessonPromote` 统一更名），语义聚焦"错题本晋级" |
| 提供版本快照 + `rollback` | 技能安装/启用/停用/更新/移除与版本管理是已装 `dsh-skills-manager` 的职责，重复实现易混淆 | **删除版本快照与 rollback**，草稿目录默认 `.dsh/lesson-promote/drafts` |
| approve 直接落盘 `.dsh/skills/<name>/SKILL.md` | 与已装插件同技能名时，rank 50（dsh-skills-manager）会遮蔽项目层 rank 100；反之会遮蔽 runtime/user 技能 | **同名冲突守卫**：落盘前查 `ctx.skills.snapshot`，其他来源同名 → 拒绝；自己部署层（filesystem/project-dsh）→ 允许；查询失败 → fail-closed 拒绝 |

## 六、冲突与兼容性分析（v3.0 复核，安装前核对）

以下清单基于对宿主全部 195 个 `@deepseek-ai/*` 包与 web profile 已装第三方插件的扫描，**均为空闲**，可直接安装：

| 维度 | 占用情况 | 结论 |
|---|---|---|
| 插件 id（`knowledge`/`errata`/`lesson-promote`） | base 行与已装插件均无同名 | 无冲突 |
| 工具名（`kb.search`/`kb.remember`/`kb.forget`/`lesson-promote`） | 无同名工具 | 无冲突 |
| 服务名（`ctx.lessonPromote`） | 无同名服务 | 无冲突 |
| 消息源 kind（`knowledge-injection`/`errata-warning`） | 无同名 | 无冲突 |
| 事件接缝（`tools/result`、`tools/pre-execute`、`agent/created`） | 平台公开接缝，多订阅者共存（dsh-tool-jobs、approval、agent-presets 等） | 无冲突（errata 永远放行不拦截） |
| 存储路径（`.dsh/knowledge`、`~/.dsh/knowledge/global`、`.dsh/lesson-promote/drafts`、`.dsh/skills`） | `.dsh/skills` 为内置 skill-filesystem 默认扫描根（设计内利用）；其余无其他使用者 | 无冲突 |
| 与 `dsh-skills-manager` 的关系 | 其占用 `~/.dsh/skill-manager/`（本插件不碰）；provider 名 `skill-manager` 与本插件工具名 `lesson-promote` 无同名；技能命名空间经 approve 同名冲突守卫保护 | 无冲突：已装插件负责技能生命周期，本插件只做错题本晋级 |

## 七、待确认项（默认决策，可随时调整）

1. 插件工程独立于官方仓库——默认执行。
2. LLM 提炼默认关闭（规则式兜底），需要时配置 `llm: true`——v2.1 未实现，预留扩展点。
3. 预警注入默认开启阈值 `warnAfterFailures: 1`（首次失败即提示），提炼阈值 `promoteAfterFailures: 3`。
4. `@dsh-plugins/shared` 保持仓库内联，依赖用 `file:../shared`（安装自包含、无需仓库根前置）；如对外发布则改用真实版本号依赖。
5. v3.0 起 `approve` 后草稿文档的后续编辑**不会**自动同步到正式技能（已删除版本/回滚机制）；errata 教训的 `fix` 更新也不自动流入已批准技能（需删草稿重新晋升）——如需要自动同步可后续加 lesson 变更监听。
