# DSH Plugins — 技能管理与知识学习插件

基于 DeepSeek Harness（DSH）Cordis 生态的插件工程，实现"自动捕获错误 → 提炼教训 → 晋升技能 → 执行前主动预警"闭环。

## 插件一览

| 插件包 | 名称 | 职责 | 发布状态 |
|---|---|---|---|
| `dsh-kb` | knowledge | 项目/全局双层知识库单包：agent 工具（`kb_search`/`kb_remember`/`kb_forget`/`kb_generate`/`kb_list`）+ 会话注入 + host Remote + 设置页「知识库」面板。V2 起支持 **LLM 事实提取**（`mode=llm`）与 **proposed/confirmed 人工确认** | ✅ npm 已发布 |
| `@dsh-knowledge/errata` | errata | 错误捕获与预警：订阅 `tools/result` 沉淀教训（"错题本"），`tools/pre-execute` 命中失败模式时向 agent 注入预警 | 本地 |
| `@dsh-knowledge/lesson-promote` | lesson-promote | 错题本晋级：把反复失败的教训晋升为技能草稿、审批落盘为正式技能（v3.0 起更名为 lesson-promote，见下） | 本地 |
| `@dsh-knowledge/shared` | shared | 共享基础设施：条目 Schema（frontmatter + Markdown）、落盘存储、轻量 BM25 检索（无外部依赖） | 本地 |
| `@dsh-knowledge/client-ui-errata` | client-ui-errata | 浏览器设置页「错题」面板：三态分组 + 归档/反悔/删除/一键晋级 | 本地 |

## Web UI 设置页面板（错题 + 知识库）

宿主端把错题与知识库暴露为 Typert Remote 服务（`ctx.remote.errata.*` / `ctx.remote.knowledge.*`），两个浏览器客户端包向 `settings.section` 注册「错题」「知识库」顶级分区。设计文档见：

- `docs/DSH插件-错题WebUI展示方案.md`（决策定稿：三态映射选视图过滤、能力边界 MVP 分阶段）
- `docs/DSH插件-错题WebUI-官方仓库集成补丁.md`（四个注册面：host 行 / client 行 / tsconfig.client 聚合 / web-app 依赖）
- `docs/DSH插件-错题WebUI-交付说明.md`（质量门禁结果与已知问题）

**host / agent 双入口**：Remote 服务是 host 平面服务（Web profile 里 agent 平面按会话挂载），故三包各拆独立 host 入口（`@dsh-plugins/errata/host`、`@dsh-plugins/knowledge/host`、`@dsh-plugins/lesson-promote/host`，包 `exports` 的 `./host`），agent 平面主入口只保留工具逻辑。本地 `cordis.patch.yml` 维持 agent 平面挂载；host 行在迁入官方仓库后按集成补丁加入 web 组合。

## 工作原理

```
tools/result (isError) ──► errata 记录教训（参数哈希前缀，不落原文）
                              │ 同类错误 ≥ promoteAfterFailures → distilled
                              ▼
tools/pre-execute ──► errata 命中失败模式（warnAfterFailures）──► agent.inject 预警
                              │
                              ▼
lesson-promote list ──► 扫描 distilled 教训 ──► 生成技能草稿（.dsh/lesson-promote/drafts/<name>.md，
                      │                          含记录字段 + 完整技能文档，批准前可人工编辑）
                      │ approve（需用户显式调用，先过同名冲突守卫）
                      ▼
       写入 .dsh/skills/<name>/SKILL.md（内置 skill-filesystem 项目层 rank 100 自动加载）
```

**v3.0 机制说明（更名 + 与已装插件解冲突）**：

1. **更名**：原 `skill-manager` 更名为 **`lesson-promote`**（包 `@dsh-plugins/lesson-promote`，插件 id / 工具名 / 服务 `ctx.lessonPromote` 同步更名）。已安装的 `dsh-skills-manager` 插件（skill provider，name=`skill-manager`，rank 50）负责技能的安装/启用/停用/更新/移除等**生命周期管理**；本插件只做**错题本晋级**，两者职责互补、互不占用名字。
2. **删除重复功能**：v3.0 不再提供版本快照与 `rollback`（技能版本管理归 `dsh-skills-manager`），草稿目录默认改为 `.dsh/lesson-promote/drafts`。
3. **同名冲突守卫**：`approve` 前查询平台 `ctx.skills` 注册表——若同名技能已由其他来源占用（`dsh-skills-manager` 库 rank 50 / runtime / user / bundled 等），**拒绝批准**并提示，保证已装插件优先、不产生同名遮蔽；仅当同名技能来自内置 `filesystem` provider 的项目层（`<ws>/.dsh/skills`，source=`project-dsh`，即本插件自己的部署层）时才允许幂等重写。
4. **落盘即加载**：DSH 内置 `skill-filesystem` 默认扫描 `<project>/.dsh/skills`（项目层 rank 100，高于 runtime 层 250）。草稿阶段只写 `.dsh/lesson-promote/drafts/`，绝不写 `.dsh/skills/`；`approve` 落盘 `.dsh/skills/<name>/SKILL.md` 后平台自动发现并加载，**不需要也不应该再调用 `ctx.skills.register()`**。

## 安装

**已发布到 npm（headless + UI 单包，自包含）**：

```bash
dsh plugin --profile <name> add dsh-kb
```

> `dsh-kb@0.2.0` 单包全功能：agent 工具（`kb_search`/`kb_remember`/`kb_forget`/`kb_generate`/`kb_list`）+ 会话注入 + host Remote + 设置页「知识库」面板（`dsh.client` 浏览器 bundle，含「获取知识库」生成方式选择与 proposed 确认按钮）。内嵌 shared 存储层，唯一运行依赖 zod。errata/lesson-promote/client-ui-errata 暂未发布，留在本仓库本地安装。
>
> 版本线：`0.1.0` 首发 → `0.1.1` 多根 workspace 发现 → `0.1.5` 容量上限 + 分类子目录 + kb_generate/kb_list → `0.1.6` Windows 下拉修复（homedir 默认根 + 工作区候选）→ `0.1.7` Windows 下拉惰性读取 workspaceRegistry（新开工作区免重启即现）→ `0.2.0` **V2：LLM 事实提取 + proposed/confirmed 确认机制**。

**本地开发安装（源码 link）**：三个插件包各自带 `cordis.patch.yml`（声明 `dsh.bundle.patch`），用 DSH 插件命令逐个安装到 profile。

```bash
pnpm install                                   # 仅本地开发/测试需要（构建 + 单测）
dsh plugin --profile <name> add /path/to/plugins/packages/knowledge
dsh plugin --profile <name> add /path/to/plugins/packages/errata
dsh plugin --profile <name> add /path/to/plugins/packages/lesson-promote
```

`dsh plugin` 会自动把声明了 `dsh.bundle.patch` 的包追加进 `dsh.profile.bundles`，无需手改配置。

```yaml
- id: knowledge-host
  config:
    # Windows 项目不在用户目录时，把开发盘根配进来（可多根）
    # 默认：用户主目录 + dsh 已打开的工作区（workspaceRegistry）恒在候选列表
    projectScanRoot:
      - 'D:/Code'
```

## 配置

在 profile 的 `cordis.patch.yml` 或 home 层覆盖各插件 `config`：

```yaml
- id: knowledge
  config:
    allowGlobalWrite: false   # 允许写全局层知识库（默认 false）
    injections:               # agent 创建时主动注入的必读条目（纯文本列表，全文注入）
      - 项目编码规范：所有接口必须校验 JWT；禁止硬编码密钥。
    injectKnowledgeIndex: true # 注入知识库索引（条目标题清单）让 AI 读取，默认 true
    injectKnowledgeMax: 50     # 索引最多列出多少条标题
- id: errata
  config:
    warnAfterFailures: 1      # 失败 ≥1 次即注入预警
    promoteAfterFailures: 3   # 同类错误 ≥3 次晋升为 distilled 教训
- id: lesson-promote
  config:
    autoApprove: false        # 默认需用户显式 approve
    promoteAfterFailures: 3
    draftsDir: .dsh/lesson-promote/drafts   # 草稿清单目录（默认）
```

## 使用（模型可见工具）

| 工具 | 说明 |
|---|---|
| `kb_search` | 检索知识库（query 必填；scope/category/topK/review 可选） |
| `kb_generate` | 按扫描范围生成知识条目（scope 必填；project 需 workspace；categories/mode 可选；summary 整文件摘要或 llm 事实提取；总容量上限 50 万字符、分类子目录落盘） |
| `kb_list` | 列出知识库条目（scope/category/limit/review 可选） |
| `kb_remember` | 写入知识条目（global 写入需 `allowGlobalWrite`） |
| `kb_forget` | 删除条目 |
| `lesson-promote` | `list` 列出草稿（自动扫描可晋升教训并生成草稿）；`approve <name>` 批准并把草稿落盘为正式技能（含同名冲突守卫，已装插件优先） |

## AI 如何读取知识库

1. **会话注入（主机制）**：每个 agent 创建时自动注入**知识库索引**（条目标题清单 +
   使用提示），模型会话开始即知知识库内容概览，需要细节时调 `kb_search` 读全文。
   开关：`injectKnowledgeIndex`（默认 true）、`injectKnowledgeMax`（默认 50 条）。
2. **工具检索**：`kb_search` 对标题+正文做 BM25 全文检索，按需取详情。
3. **晋级技能**：`lesson-promote approve` 把教训晋升为 `<workspace>/.dsh/skills/` 技能，
   内置 skill-filesystem 自动加载为模型可见技能。
4. **人工**：设置页「知识库」面板浏览/阅读/删除（含「获取知识库」扫描生成）。

## 存储布局

```
<workspace>/.dsh/knowledge/<分类>/<id>.md          # 项目层（分类子目录，如 architecture/、deployment/）
~/.dsh/knowledge/<分类>/<id>.md                    # 全局层（如 environment/、conventions/；旧平铺 global/ 兼容可读）
<workspace>/.dsh/lesson-promote/drafts/<name>.md   # 技能草稿（记录字段 + 完整技能文档，可人工编辑）
<workspace>/.dsh/skills/<name>/SKILL.md            # 正式技能（仅 approve 写入，内置 skill-filesystem 加载）
```
> 条目为 frontmatter + Markdown；V2 的 LLM 提取条目带 `review: proposed`，面板确认后变 `confirmed`。

## 与已安装插件的关系

- **`dsh-skills-manager`（已安装）**：技能生命周期管理（安装/启用/停用/更新/移除，库在 `~/.dsh/skill-manager/`，provider name=`skill-manager`，rank 50）。本插件**不与其共享任何存储路径**，也不重复其功能；`approve` 的同名冲突守卫保证已装插件的同名技能优先。
- **`dsh-context`（已安装）**：会话上下文观测/管理（session projections），与本插件的知识注入（`agent/created` 全文注入）机制不同、互不影响。

## 开发

```bash
pnpm install            # 安装依赖（workspace + 宿主 peer 包）
pnpm build              # tsc -b 编译全部包到 lib/
pnpm test               # vitest 单元测试
pnpm typecheck          # 类型检查
```

宿主依赖（`@deepseek-ai/cordis`、`dsh-tools`、`dsh-agent`、`dsh-skill`、`dsh-llm`、`dsh-session`）以 **peerDependencies + devDependencies 直接使用 npm 版本**（`cordis@^4.0.1`、`dsh-*@0.1.0-rc.8`），不再依赖本地 DSH 仓库的 `link:` 构建产物，仓库可独立构建与测试。与 DSH 宿主版本兼容性：已验证 **0.1.0-rc.8**。

## 安全设计

- 教训条目只存参数哈希前缀（`argsHashPrefix`），不落参数原文，预警文案不含敏感值。
- 全局层知识写入默认关闭，需显式 `allowGlobalWrite: true`。
- 技能批准默认需人工确认（`autoApprove: false`）；草稿批准前不会以任何形式出现在技能目录中；approve 前做同名冲突守卫，绝不覆盖已装插件/其他来源的技能。
- 所有条目为 UTF-8 Markdown + frontmatter，可进 Git 评审与回滚。

## 已知限制

1. **LLM 提取按文件逐文件调用**（每文件一次 `ctx.llm` 请求，单批 1500 maxTokens）；《知识库思路.md》的多小文件 8K token 分批尚未实现。
2. **检索为关键词 BM25**（标题/正文），无 embeddings 语义检索——同义改写可能搜不到。
3. **user-profile 引导式问答未做**（全局库该分类走人工 `kb_remember` 或后续迭代）。
4. LLM 提取依赖宿主 `llm` 与 `agentDefaultModel` 服务可用（web profile 均具备）；不可用时 `mode=llm` 报错提示改用 summary，不影响其他功能。
5. `approve` 后草稿文档的后续编辑**不会**自动同步到正式技能（已删除版本/回滚机制）；需要人工重新落盘或删除草稿后重新晋升。
6. `dsh plugin add` 依赖 pnpm 网络与缓存路径，沙箱受限环境可能需要在权限设置中放行 pnpm 缓存目录。
