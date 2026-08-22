# 插件 Web UI 面板展示方案（错题 + 知识库）

> 目标：在 DeepSeek Harness Web UI 的设置页新增两个自定义面板——「错题」按「观察中 / 已晋级 / 已归档」三态分组，支持归档与晋级；「知识库」按「全局 / 项目」双层展示，支持手动增删查条目。
> 落地方向：加入 DSH 官方生态，把插件迁入官方仓库、复用其构建流水线（已选定子选项 A）。
> 日期：2026-08-21 ｜ 状态：方案设计，决策已定（三态映射选视图过滤、能力边界走 MVP 分阶段），可进入实现

## 背景与目标

DSH 的 `errata` 插件已经能在工具执行出错时自动记录教训，并把失败次数、错误类型、修复建议沉淀到本地文件。但目前这些数据没有任何可视界面，只能靠文件系统手工查看。

本方案要补上这一环：在 Web UI 的设置页里，把错题按三种状态分组展示，并允许用户对单条错题执行「晋级为技能」和「归档」两个动作。数据来源不变，仍然是 `errata` 现有的本地文件存储，只是在宿主进程与浏览器之间加一条只读通道，再在设置页挂一个自定义面板。

`knowledge` 插件同理：它已维护一套「全局 / 项目」双层知识库，却没有可视界面。本方案一并补上第二个面板，让用户在设置页直接手动增删查知识条目。

## 现状梳理

三个插件（`knowledge`、`errata`、`lesson-promote`）目前是一个独立 workspace，包名带 `@dsh-plugins/` 前缀。它们的职责分工里，`errata` 持有错题数据（`ErrorLesson`，含 `status` 字段），`lesson-promote` 负责把教训晋升为技能，`knowledge` 提供知识检索。技能晋升插件原名 `skill-manager`，已改名为 `lesson-promote`，当前版本 0.3.0，peer 依赖已对齐 `dsh-agent` 0.1.0-rc.8。

要让错题出现在 Web UI，现有代码缺两块：宿主端没有把错题暴露给浏览器的方法，也没有任何客户端 UI 插件。

## 两条核心机制

DSH 官方仓库里，这类「宿主数据进设置页」的需求已经有成熟范式，由两条机制配合完成。

**Remote 数据通道**解决「浏览器怎么拿到宿主进程里的错题」。宿主的服务继承 `TypertRemoteService` 并给方法加 `@Remote` 装饰器，构建期生成严格的描述符，浏览器端通过 `ctx.remote.<命名空间>.<方法>` 直接调用。调用走普通 HTTP POST（`/api/<命名空间>/<方法>`），一次请求返回一个结果。官方仓库里只读插件清单 `dsh-host-plugin-inventory` 就是这个范式的最简样例。

**Slot 挂载点**解决「面板出现在设置页的哪个位置」。设置页由 `settings.section` 这个列表槽位驱动，每个注册项就是导航里的一行。新增一个顶级分区，就是在 `settings.section` 上注入一个带唯一 id 的注册项，内容组件自绘。组件只接收纯数据与回调，不接触宿主上下文。

有一个需要明确排除的路径：`settings namespace`。需要说明：`host/apiproxy` 的 settings 域服务于**所有**已注册分节，插件注册自己的分节即可从浏览器配置，并不存在需要改 apiproxy 的封闭允许名单（官方 README 明示 "this proxy adds no boundary of its own"）。排除它的真正理由是**语义错位**：settings 是配置表单协议（schemastery schema、脱敏分层值、update/replace/mutate、revision 冲突检测），面向「配置项」而非「列表 + 动作」；把错题列表塞进去既不合适渲染，也会把列表数据写进用户配置层。所以错题/知识库面板必须走 Remote 通用通道。

## 三态设计

现有 `status` 枚举是四个值：`raw`、`distilled`、`promoted`、`archived`。界面展示三组，映射已定（见「决策结论」）：**视图过滤**——保留底层四态，`raw` 对应「观察中」，`distilled` 并入「观察中」（视为「已提炼待注册」），`promoted` 对应「已晋级」，`archived` 对应「已归档」。纯视图层过滤，不动状态机，零迁移。展示口径：存 4 态、显 3 组；观察中组内 distilled 条目带「可晋级」标记，raw 条目不可晋级。

## 动作语义

面板提供两个单条操作，语义已确定如下。

**归档**：归档不是删除动作，而是把条目转入「已归档」分组。用户在该分组内仍可查看归档条目，并可「反悔」（取消归档、回到原状态）或「删除」（永久移除该条），归档因此是可逆、可清理的两步式设计。落地时需在 `LessonStore` 新增状态变更与删除能力（`setStatus` / `remove`，`EntryStore` 已有 `remove` 可复用）：当前存储层只有自动晋升（`maybePromote` 的 raw→distilled），没有人工改态与删除的入口。

**晋级**：晋级动作一键把教训直接注册为技能，即时反馈强。落地方式与 `lesson-promote` 现状对齐：当前实现是「草稿 → 批准」两段式（`scanPromotable` 只接受 `status==='distilled' && errorCount>=阈值` 的条目，`draftSkill` 写 `.dsh/lesson-promote/drafts/`，`approve` 才写 `.dsh/skills/<name>/SKILL.md`，且 `autoApprove=false` 默认需显式批准）。面板的晋级动作 = 对满足条件的 distilled 条目执行「生成草稿 + 立即批准」的原子操作，**保留同名冲突守卫**（已安装的 dsh-skills-manager 技能优先，冲突时拒绝并提示），跳过人工编辑草稿环节但不绕过安全守卫。误操作暂不提供撤销（技能生命周期归 dsh-skills-manager），以确认弹窗降低误触概率。

## 迁入官方仓库的落地方向

路径 1 的核心是把开发环境挪进 DSH 官方仓库，借用它的构建流水线。方向已定，选子选项 A：加入官方生态，插件直接放进官方仓库。

**选定子选项 A。** 把 `errata` 改造成官方仓库里的一个包，并新增一个 `dsh-client-ui-errata` 客户端包，两者都进 `packages/` 目录。优点是可以直接用官方的 `typert-generator` 生成 Remote 描述符、用 `tsdown` 的 `clientBundle` 打客户端产物，链路最顺。代价是包要进官方仓库，命名和目录都要对齐官方约定，改动会落在 fork 出来的官方代码上。

子选项 B 是 fork 官方仓库作构建宿主、插件保持独立，已不采用，仅作备选记录。

选定 A 后，插件需要新增两类产物：宿主端的 Remote 描述符，以及浏览器端的客户端 bundle。这两类产物在官方流水线里都是构建期生成的，不是手写。

## 包与目录调整

`errata` 需要增加一个宿主端服务，把错题列表和归档、晋级动作暴露成 Remote 方法。方法只返回 JSON 可表示的纯数据，不把宿主内部的复杂对象传出去。

新增一个客户端 UI 包，专责设置页里的错题面板。它声明 `dsh.client`（`platform: 'web'`），导出 `./client` 产物，在 `apply` 里向 `settings.section` 注册分区，组件里调 `ctx.remote.errata.*` 拉数据并渲染三组列表。

四个注册面不能漏，漏任何一个都会在更晚的环节失败：

1. **宿主行**：`web-app/cordis.patch.yml` 里为 errata 的 Remote 服务加 host 行。当前 `errata` 行是 agent 平面（`inject: [agents, tools]`），而 Web profile 里 agent 平面按会话挂载——Remote 服务必须像 `plugin-inventory` 一样以 host 平面行挂载，浏览器才能调到；
2. **客户端行**：`web-app/cordis.patch.yml` 再加一行 `ui-settings-errata`；
3. **聚合引用**：客户端包的 `tsconfig.client.json` 聚合引用；
4. **依赖声明**：`web-app/package.json` 加对应依赖。

## 知识库 UI 面板

`knowledge` 插件已经是一个「双层知识库」：全局层落盘在 `<dshHome>/knowledge/global/`，项目层落盘在 `<workspace>/.dsh/knowledge/`，条目是 Markdown + YAML frontmatter，结构已对齐 `SKILL.md`。底层已有 `kb.search` / `kb.remember` / `kb.forget` 三个工具，但没有可视界面。数据模型保持现状的「固定两库 + 条目管理」，不做多命名库扩展。

本面板与错题面板共用同一条 Remote + Slot 链路，需新增三块：

**宿主端 `KnowledgeRemoteService`**：在 `knowledge` 包内新增一个继承 `TypertRemoteService` 的服务，把列表、添加、删除能力暴露成 `@Remote` 方法（`list` / `remember` / `forget`），命名空间 `knowledge`，方法显式携带 `workspace` 参数（见「项目定位」），只返回 JSON 纯数据。

**客户端 UI 包 `dsh-client-ui-knowledge`**：声明 `dsh.client`（`platform: 'web'`），在 `apply` 里向 `settings.section` 注册「知识库」分区，组件调 `ctx.remote.knowledge.*` 渲染条目列表，顶部加「全局 / 项目」作用域切换，条目支持增删查。

**四个注册面**：与错题面板完全一致的收尾——宿主行（`web-app/cordis.patch.yml` 为 `KnowledgeRemoteService` 加 host 平面行，当前 `knowledge` 行同为 agent 平面）、客户端行（`web-app/cordis.patch.yml` 加 `ui-settings-knowledge`）、`tsconfig.client.json` 聚合引用、`web-app/package.json` 加依赖。

两个必须处理的工程点：

- **全局写权限**：`knowledge` 的 `allowGlobalWrite` 默认 `false`。「全局」作用域下的添加操作要么受该开关约束（禁用时提示只读），要么把这个开关提升成可配置项。
- **项目定位**：现有 `findProjectRoot` 依赖进程 `cwd` + 找 `.git`，而 Web 宿主进程的 cwd 是 CLI 启动目录，不是任何会话的 workspace；且 Remote 服务是宿主平面服务，宿主平面上**没有单一「当前会话」**（多会话并存），「改成当前会话的 workspace」在宿主平面不成立。改为：Remote 方法**显式携带 `workspace` 参数**（错题条目本身带 `workspace` 字段，天然支持跨工作区列举），面板绑定活跃会话或提供工作区选择。

## 关键约束与风险

Remote 描述符是构建期生成的。`@Remote` 方法签名、命名空间或参数类型一旦改动，必须重跑宿主构建再跑客户端构建，否则浏览器端会因为缺少严格描述符而拒绝调用。

`settings.section` 的 id 必须全局唯一，与官方已有的 `general`、`plugins`、`models` 不冲突即可。面板组件遵循官方约定，只通过 props 拿到数据与回调，不跨包 import 具体组件。

还有一个现实的工程代价：迁入官方仓库意味着后续的改动、升级都要跟随官方仓库的节奏，`typert-generator` 和客户端构建链的版本变动会直接影响到插件。

## 决策结论（原待确认项）

迁入方式（子选项 A、加入官方生态）与下述两个决策点均已敲定。本节保留利弊分析作为决策记录，结论见各小节末尾的「已定」标注。

### 决策一：三态映射 —— 合并方案 vs 视图过滤方案

背景：底层 `status` 枚举是四个值 `raw / distilled / promoted / archived`，界面要的是三组「观察中 / 已晋级 / 已归档」。`raw`（观察中）与 `archived`（已归档）的对应没有争议，分歧集中在 `distilled` 与 `promoted` 如何处理。

**选项 A：合并方案（把 `distilled` 与 `promoted` 合并为「已晋级」）**

利：

- 三组与三态一一对应，导航和分组最简洁，用户心智负担最低，符合最初「三态分组」的直觉。
- 界面无需解释「第四态」，不存在"某个状态藏起来了"的认知成本。

弊：

- 语义失真：`distilled` 是「已提炼成教训」，`promoted` 是「已晋升为技能」，两者不是同一件事。「已晋级」这个词会让用户误以为 `distilled` 也已经变成了技能，实际并没有。
- 需要动 `errata` 的状态机（至少加一层映射，可能涉及历史数据迁移），改动面和回归风险大于视图层方案。
- 一旦合并，`distilled` 与 `promoted` 的边界在展示上被抹平，未来若想单独展示「已提炼待晋升」这一中间态，还得再拆回去。

**选项 B：视图过滤方案（保留四态，界面只展示三组，`distilled` 暂时折叠）**

利：

- 不动底层存储与状态机，纯视图层过滤，改动最小、风险最低，`errata` 现有逻辑与测试不受影响。
- 数据完整性保留，`distilled` 的信息不丢，后续想调整展示策略随时可改。
- 底层事实与界面视图解耦，符合"底层是事实、界面是视图"的工程原则。

弊：

- 需要一个「折叠/隐藏」第四态的显示策略，若处理不周，用户会问"我的 `distilled` 错题去哪了"。
- 四态与三组的映射不够直观，可能需要一句文案说明中间态的去向。

**已定：选 B（视图过滤），`distilled` 并入「观察中」**。除既有理由（不动状态机、零迁移、数据完整性）外，还有两点代码级依据：

- 合并方案（A）会**真破坏晋级链路**：`lesson-promote` 的 `scanPromotable` 硬编码筛选 `status === 'distilled' && errorCount >= 阈值`，一旦在存储层合并 distilled 与 promoted，已注册的技能会被当成待提炼条目重新扫描，或待注册条目被漏掉，且涉及历史数据迁移。
- 视图过滤下「第四态」不需要隐藏：面板把 distilled 显示为「观察中」组内**可晋级条目**——晋级按钮只对 distilled 条目可用（raw 条目禁用并提示失败次数），`promoted` 已在「已晋级」组，用户不会问「distilled 去哪了」。

### 决策二：面板能力边界 —— 仅查看 vs 加筛选/搜索/批量

背景：面板的功能范围直接决定客户端包的复杂度。

选项 A（MVP：查看 + 单条操作）

- 利：开发最快，客户端包极简，Remote 方法少、出错面小，符合"先把通道跑通"的第一目标。
- 弊：错题量大以后体验差，翻找困难。

选项 B（完整版：加筛选/搜索/批量操作）

- 利：用户体验好，数据量大时依然可用；三态分组本身已是一种天然筛选，在此基础上加搜索/批量是自然延伸。
- 弊：复杂度显著上升——客户端要维护分页/搜索/筛选状态，批量操作需要对应的 Remote 批量接口与确认交互，开发和回归成本成倍增加。
- 弊：在"通道尚未验证"的阶段过早加能力，风险前置，容易在基础设施没稳时就陷进 UI 细节。

**已定：V1 走 A（MVP），搜索/批量留增量**。除既有理由外，还有两点代码级依据：

- 错题量天然不会爆炸：`LessonStore.record` 按 `patternKey(tool, errorType)` 聚合计数，同工具同错误类型只占一条，列表长度 ≈ 工具 × 错误类型组合数，而非失败次数，三组列表在真实数据量下长期够用。
- 搜索后补成本极低：官方 `PluginInventorySettingsTab` 已示范纯客户端内存过滤（拉一次快照本地筛），搜索不需要新增 Remote 方法，V1 无需为其预留接口。

V1 范围：三态分组 + 单条归档/晋级；Remote 方法压到最少（`list` / `archive` / `promote`），先跑通通道。批量操作与搜索待数据量增长、用户明确反馈后再增量补。
