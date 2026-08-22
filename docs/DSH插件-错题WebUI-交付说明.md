# DSH 插件 Web UI 面板 — 交付说明

> 对应方案：《DSH插件-错题WebUI展示方案.md》（决策已定版）与《DSH插件-错题WebUI-官方仓库集成补丁.md》。
> 日期：2026-08-21 ｜ 状态：本地独立 workspace 开发完成（宿主端可运行可测试；客户端包源码级交付，web 集成待迁入官方仓库）

## 一、本次交付内容

### 1. 宿主端（可运行、已单测）

| 包 | 新增能力 | 文件 |
|---|---|---|
| `@dsh-plugins/errata` | `ErrataRemoteService`（list / archive / unarchive / remove / promote）；`LessonStore` 新增改态与删除 | `src/remote.ts`、`src/typert.host.ts`、`src/host.ts`、`src/lessons.ts` 扩展 |
| `@dsh-plugins/knowledge` | `KnowledgeRemoteService`（list / remember / forget，显式 workspace，allowGlobalWrite 约束） | `src/remote.ts`、`src/typert.host.ts`、`src/host.ts` |
| `@dsh-plugins/lesson-promote` | `LessonPromoteStore.approve`（草稿批准 + 同名冲突守卫，供一键晋级复用）；host 入口暴露 store | `src/index.ts` 扩展、`src/host.ts` |
| `@dsh-plugins/shared` | `ErrorLesson.archivedFrom`（归档反悔记录原状态，frontmatter `archived_from`，向后兼容） | `src/schema.ts` |

### 2. 客户端（浏览器 React 面板，源码级交付）

| 包 | 面板 | 能力 |
|---|---|---|
| `@dsh-plugins/client-ui-errata` | 设置页「错题」分区（`settings.section` id `errata`） | 三态分组（观察中 = raw + distilled 带「可晋级」标记 / 已晋级 / 已归档）、工作区选择、单条归档 / 反悔 / 删除 / 晋级 |
| `@dsh-plugins/client-ui-knowledge` | 设置页「知识库」分区（id `knowledge`） | 全局 / 项目切换、项目层 workspace 输入、条目增删查、全局写权限提示 |

### 3. 文档

- `docs/DSH插件-错题WebUI展示方案.md`（决策定稿版）
- `docs/DSH插件-错题WebUI-官方仓库集成补丁.md`（四个注册面 + 包对照表 + 验证清单）

## 二、质量门禁结果

| 门禁 | 结果 |
|---|---|
| 类型检查（宿主）`pnpm typecheck` | ✅ 通过（0 error） |
| 类型检查（客户端）`pnpm typecheck:client` | ✅ 通过（0 error，react-jsx + DOM lib） |
| 构建 `pnpm build` | ✅ 通过（lib 产物含 host.js / typert.host.js） |
| 单元测试 `pnpm test` | ✅ 35/35 通过（errata lessons 6 + errata remote 9 + knowledge remote 5 + lesson-promote 8 + 客户端契约测试 7） |
| Typert manifest 运行时校验 | ✅ 两个宿主 manifest 结构合法（package/face/schemas/model/invocations），strict zod codec 拒绝非法数据 |
| 描述符一致性 | ✅ host manifest 与客户端 remote-client 描述符逐字段一致（errata 5 端点 / knowledge 3 端点） |

## 三、阶段五代码审查结论（独立第三方）

审查员对 20+ 文件逐字段核对（对照官方 dsh-host-plugin-inventory / dsh-typert-loader / dsh-api-gateway 实现），结论摘要：

**P0 ×2（已修复）**
- 客户端 `ctx.remote.*` 是**位置参数**约定（运行时按描述符参数顺序逐位 parse、校验实参个数），原 api 封装误用 args 对象 → 面板所有操作在真实运行时失败。已改为位置参数签名（`list(workspace?)` / `archive(lessonId, workspace?)` 等），面板调用省略 undefined 尾参（网关 `acceptsUndefined` 允许缺省），并新增 7 个客户端契约测试防回归。

**P1：无**（协议层、服务层、安全红线、归档/晋级语义均无 P1 缺陷）

**P2（已处理 4/4）**
- 工作区可达性：errata 面板由下拉改为自由输入路径，可触达任意项目层错题。
- errata-host 网关时序：`promote` 改为方法内每次 `ctx.get('lessonPromote')`（不再构造期冻结）。
- 两个面板 `load` 请求竞态：加序号守卫丢弃过期响应。
- knowledge 面板 scope 切换残留：切换时清空 workspace，project 视图空 workspace 提交前提示。

**P3（11/11 全部处理）**
- P3-1 sourceLocation 行号修正为方法声明行；
- P3-2 promote 返回剔除 undefined `file`（避免 strict 编码拒绝），schema 保持 optional；
- P3-3 文档记录：promote 批准失败时草稿已落盘（幂等、便于重试，行为可接受）；
- P3-4 全局层条目晋级给出明确提示（「仅项目层条目可晋级」）；
- P3-5 `EntryStore` 新增 `readProject`/`removeProject`，errata 只操作项目层（防全局层同 id 遮蔽）；
- P3-6 文档记录：errata 与 lesson-promote 的 `promoteAfterFailures` 双配置源（行为保守正确，建议统一配置来源）；
- P3-7 `nextEntryId` 撞 id 循环递增加固（单进程内同步 record 无竞态，跨进程短窗口防覆盖）；
- P3-8 删除二次确认由 `window.confirm` 改为内联确认态（避免嵌入式 WebView 受限）；
- P3-9 `unwrap` 折叠装配错误（reject 的原始 Error 统一包装）；
- P3-10 `KnowledgeEntryView` 补齐 lesson 可选字段（与 wire schema 对齐）；
- P3-11 host 入口手工 `ctx.typert.register(TYPERT)`，移除 `./typert` export（不再依赖 loader 扫描，避免双注册）。

## 四、已知问题与限制（如实记录）

1. **客户端包未做 web 集成验证**：本地无官方仓库 checkout，`tsdown clientBundle`、`web-app/cordis.patch.yml`、`web-app/package.json` 依赖与 `tsconfig.client.json` 聚合按《官方仓库集成补丁》接入后方可端到端验证；客户端包本地仅通过类型检查。
2. **Typert 描述符为手写**：`src/typert.host.ts` 与客户端 `typert.remote-client.ts` 按官方生成格式手写（strict + zod v4）。迁入官方仓库后应删除手写文件、由 `typert-generator` 构建期生成（格式一致，无行为差异）。
3. **客户端组件未做组件级测试**：本地未引入 @testing-library / dsh-client-test-runtime；宿主端业务逻辑已单测覆盖。组件测试随官方仓库测试链补齐。
4. **`list` 缺省 workspace 语义**：errata `list()` 缺省返回宿主默认工作区（进程 cwd 项目根）的项目层 + 全局层；面板 V1 提供工作区下拉（选项来自已返回条目的 workspace 去重）。多项目场景下首次进入可能只看到默认项目，切换工作区后刷新。
5. **晋级动作依赖 lesson-promote host 入口**：web 组合未挂载 `lesson-promote-host` 时，面板晋级按钮会返回「lesson-promote 插件未启用」；归档 / 反悔 / 删除不受影响。
6. **知识库全局写入**：`allowGlobalWrite=false`（默认）时全局 scope 下添加条目会返回宿主拒绝文案；面板已提示只读。
7. **P3 全部处理完毕**：11 项 P3 均已修复或文档记录（见上节），无遗留未决 P3。

## 四、安装与 E2E 验证（2026-08-21 实装）

**安装结果**：`dsh plugin add --profile web` 已把 5 个插件全部装入 web profile（bundles + link 依赖），组合合成经 `--dump-config` 验证全部行就位：

```yaml
# == @dsh-plugins/errata
- id: errata            # agent 平面工具 + 预警
- id: errata-host       # host 平面 Remote（inject: [typert]，手工注册 manifest）
# == @dsh-plugins/lesson-promote
- id: lesson-promote
- id: lesson-promote-host  # host 平面晋级 store（inject: [skills]）
# == @dsh-plugins/knowledge
- id: knowledge
- id: knowledge-host    # host 平面 Remote（inject: [typert]）
# == @dsh-plugins/client-ui-errata
- id: ui-settings-errata    # 设置页「错题」分区
# == @dsh-plugins/client-ui-knowledge
- id: ui-settings-knowledge # 设置页「知识库」分区
```

**冒烟验证**（模拟 cordis Context）：errata-host 注册 `@dsh-plugins/errata` manifest（5 端点）+ `errata` Remote 服务；knowledge-host 注册 manifest（3 端点）+ `knowledge` Remote 服务，均通过。客户端 `lib/client.js`（`window.__ModuleLoader__.load` 格式）经 VM 加载验证导出 `{NS, apply, inject}` 正常。

**E2E 前置**：安装后需**重启 dsh web**（当前 3080 端口的运行实例仍是旧组合），设置页将出现「错题」「知识库」两个分区。

**E2E 验证点建议**：
1. 设置页出现「错题」「知识库」分区且能拉到数据（空列表或已有条目）；
2. 错题面板：归档 → 反悔、删除（内联二次确认）、晋级（仅 distilled 条目按钮可用）；
3. 知识库面板：全局/项目切换、添加条目、删除条目（全局写受 allowGlobalWrite 约束时提示）；
4. 工作区：输入具体项目路径后列表按该工作区刷新。

## 五、发布说明（相对上一个插件版本）

**功能变更**
- 新增 errata 宿主 Remote 服务（`ctx.remote.errata.*`）：错题列表、归档（可反悔）、删除、一键晋级（草稿 + 立即批准，保留同名冲突守卫）。
- 新增 knowledge 宿主 Remote 服务（`ctx.remote.knowledge.*`）：知识条目列表 / 添加 / 删除，显式 workspace 参数，全局写入受 allowGlobalWrite 约束。
- 新增两个浏览器设置页面板：错题（三态分组）与知识库（全局 / 项目双层）。
- lesson-promote 新增 `LessonPromoteStore.approve` 与 host 平面入口。

**兼容性**
- 底层条目 schema 仅新增可选字段 `archived_from`，旧条目解析不受影响（缺省 undefined，反悔时按 errorCount 自动推导状态）。
- 现有 agent 平面工具（errata 预警、kb.*、lesson-promote 工具）行为不变；Remote 服务仅在 host 平面入口挂载时提供。

**未决事项**
- 迁入官方仓库后的构建链验证（typert-generator / tsdown clientBundle）。
- 客户端组件测试与 E2E（设置页面板交互）。
