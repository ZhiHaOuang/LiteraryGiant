# LG 的 DSH 插件

此目录保存第三方插件的固定源码快照与 LG 自有插件。它们随父仓库版本管理，不依赖用户 `~/.dsh/plugins` 或 LitIsLand 中的源码。框架在相邻的 `../dsh/`。

| 目录 | 固定版本 | 本阶段学习重点 |
|---|---|---|
| `dsh-ascii-sharks` | 0.1.0 | 轻量 Client 插件、背景与生命周期 |
| `dsh-better-sidebar` | 0.30.1 | 文件树、编辑器、侧栏服务和扩展接口 |
| `dsh-claude-style` | 0.19.9 | UI 风格、品牌配置与 Host/Client 分工 |
| `dsh-context` | 0.82.1 | 上下文统计、面板与可见性 |
| `dsh-ops` | 0.5.0 | 工具执行与运行时扩展 |
| `dsh-ai4scholar` | 0.6.6 | 文献工作台、结果列表与详情分栏 |
| `dsh-reading-workbench` | 0.2.0 | 本地书架、分页阅读、划线批注 |
| `lg-brand` | 0.1.0 | LG 自有最小 UI 插件 |
| `lg-books` | 0.1.0 | 作品读取、统计、版本事务与作者 API |
| `lg-dashboard` | 0.1.0 | 小说概况、字数、章节、人物和待审计数 |
| `lg-workbench` | 0.1.0 | 章节/场景编辑、版本比较、候选预览与采用 |
| `lg-execution` | 0.1.0 | 单次模型调用、超时取消、持久预算和重复请求保护 |
| `lg-agent-teams` | 0.1.0 | LG 主／分析／规划／创作四个 Native 预设，按需协作、候选与用量；独立 App 宿主验证通过，日常重启加载 |
| `lg-agents` | 0.1.0 | 专家配置、选区润色、整章候选及编号原文证据审阅 |
| `lg-library` | 0.1.0 | 有界分层检索、来源校验、资料面板与 DSH 原生工具 |
| `lg-memory` | 0.1.0 | 事实审批、时间线、伏笔、人物/读者认知与来源投影 |
| `lg-context` | 0.1.0 | 显式文学材料装配、视角过滤、固定笔记与来源收据 |
| `lg-planning` | 0.1.0 | 创作方向选择／撤回、场景计划审批、卷章骨架与近期窗口 |
| `lg-review` | 0.1.0 | 版本化审阅、正文／一致性检查、作者判断与反馈改稿 |
| `lg-workflows` | 0.1.0 | 逐场起草、整章生成、修订审阅、作者反馈与断点恢复 |
| `lg-author` | 0.1.0 | 个人默认／本书写作偏好、继承、历史与实际模型输入 |
| `lg-export` | 0.1.0 | 作品导出，六类内容支持 Markdown、TXT、Word，复用 DSH 文件保存 |
| `lg-skills` | 0.1.0 | 15 项 DSH 文学技能、作者显式调用与专家方法选择 |
| `lg-impact` | 0.1.0 | 查询章节与资料版本的直接引用，核对改稿影响 |
| `lg-director` | 0.1.0 | DSH 原生任务提议、作者预览确认、专家执行与原调用恢复 |
| `lg-tool-policy` | 0.1.0 | 默认关闭的 Agent 全局工具允许列表，复用原生限制与生命周期 |

`sources.lock.json` 记录各快照的来源、commit、版本与初始导入摘要；DSH 的摘要包含此前 LG 品牌补丁，并非声称等同纯上游 commit。摘要用于记录导入基线，不会随日后的本地修改自动更新。上游许可证及目录规则保留。只省略 context 的大型演示视频，路径已列入清单。

Claude-style 快照采用 npm provenance 对应的 commit。公开快照省略其 [许可证](dsh-claude-style/LICENSE)单独列出的 Anthropic 字体、Clawd 图像及生成图像的脚本。项目启动使用固定 npm 发行包。需要完整重建该主题时，在独立目录取得锁定的上游源码。

当前四个公开插件的 `lib/`、ops 的 `runtime/` 使用锁定 npm 发行产物，经 SHA-512 校验后由 `scripts/prepare-dsh-plugins.py` 准备，生成目录不进入 Git。sharks 的 `lib/` 本来就由上游跟踪，随源码保留。本次没有修改五个插件的业务实现，也没有声称重新编译了它们全部源码。之后修改哪个插件，就按其目录规则安装开发依赖、重新构建与测试那个插件。

AI4Scholar 从锁定的源码构建，阅读工作台入口为 [Workbench.tsx](dsh-ai4scholar/src/client/Workbench.tsx)。准备环境、构建和本地链接命令见 [DSH 开发入口](../docs/dsh-local-app.md#ai4scholar-文献工作台)。

阅读工作台的书架与阅读器入口为 [WorkbenchPage.tsx](dsh-reading-workbench/src/client/panel/WorkbenchPage.tsx)。构建及书库位置见 [阅读工作台接入说明](../docs/dsh-local-app.md#reading-workbench-阅读工作台)。

## lg-brand：最小 UI 插件例子

Host 保持极简；Client 源码与发布产物分开：

- `package.json` 声明 Host/Client exports、DSH bundle 和 Client 依赖信息。
- `cordis.patch.yml` 把 `lg-brand` 行插入 Cordis Loader 树。
- `index.js` 是无业务逻辑的 Host 入口，让 DSH 发现对应 Client 模块。
- `src/client.js` 依赖 `slots` 服务，在 `sidebar.brand.mark` 和 `sidebar.brand.name` 插槽注册头像与名称；注册归属插件 fiber，停用后随生命周期移除。图像为作者指定图片的缩略图，内嵌以避免另加资源路由。
- `client.js` 由本目录 `npm run build` 生成，使用 DSH 的 `window.__ModuleLoader__.load({id, factory})` 协议。不能直接发布普通 ESM；Host Running 不代表客户端已经加载。

React 由 DSH Client 共享模块提供。插件不保存作品状态、不调用模型、不读 Library、不改变 Agent loop。

当前同时启用了 `dsh-claude-style`。它自行管理可见的侧栏品牌，已通过其现成 `brandName` 和品牌图片配置显示 LG；关闭这个主题后由原生品牌槽显示 `lg-brand`。不要用 CSS 争抢或直接修改第三方 node_modules 来解决品牌配置。

文学功能的最新职责、验收和未完成范围见 [插件迁移](../docs/dsh-plugin-migration.md)。早期 bridge/tools 方案由独立 DSH 插件迁移目标替代，新的作品与编辑路径不调用旧后端。

开发：使用项目准备的 Node 24，先 `npm ci --ignore-scripts`，再 `npm run build`、`npm test`。构建器生成各 LG 插件根目录的 `client.js`，这些产物由本地构建生成。React 由 DSH 提供。安装包可用 `npm pack ./lg-books ./lg-dashboard ./lg-workbench ./lg-execution ./lg-agents ./lg-library ./lg-memory ./lg-context ./lg-planning ./lg-review ./lg-workflows ./lg-author ./lg-tool-policy ./lg-director ./lg-impact ./lg-skills ./lg-export --pack-destination ../.dsh-dev/plugin-packages` 生成，再通过 DSH CLI 的 `plugin --profile <profile> add --save-exact <tgz...>` 安装。

本地链接的 OPS 必须与宿主共用 `dsh-scope`，所以开发目录根清单显式把该包声明为 peer。否则本目录安装的测试依赖可能提供另一份作用域模块，导致 Agent 启动报 `Publication scope must match its registration context`。这不修改 OPS 源码；归档安装和本地链接的解析规则不同。可用实际宿主验证，不发起模型调用：

```sh
.dsh-dev/node/bin/node dsh-plugins/scripts/check-host-peers.mjs "$PWD/dsh" "$HOME/.literarygiant-dsh/profiles/desktop"
```

`lg-workflows` 已在独立 web profile 验证安装与四步真实调用。普通源码 CLI 拒绝 `--profile desktop`，但应用自带 CLI 支持；安装前须完全退出 App，命令见开发说明。桌面仍保留原十个文学插件的链接，lg-workflows、lg-author、lg-tool-policy、lg-director、lg-impact 和 lg-skills 尚未安装。

`lg-author` 同样已完成归档/宿主验证，桌面安装待解锁。个人偏好按当前 profile 保存；默认空偏好不增加模型请求开销。旧偏好文件仅兼容读取，确认保存后改用新数据库，原文件保留。

`lg-tool-policy` 已在真实 DSH CLI 验证安装和文件任务，Host 入口 23 行；默认关闭，启用或改配置后需新建会话或重载 Agent。它限制继承的全局工具，OPS 的 Agent 局部工具继续由 OPS 管理。两轮短任务对照及限制见迁移文档；可复制配置在 `examples/file-task-tools.patch.yml`，不要将该文件任务集合直接套用于通用会话。

`lg-director` 已用真实 DSH headless 会话和网页作者 API 验证：原生 Agent 提议精确版本任务，作者检查输入与费用后，专家只生成候选；重复执行／无密钥重启不重复计费。领域服务已与 HTTP connection 解耦，CLI 和桌面使用同一实现。完整 Director 综合／依赖调度与桌面点击尚未完成。见插件自身 README。

`lg-review` 的免费正文检查已接入编辑台：汉字范围、必含／禁用词和精确结尾，读取指定版本、返回位置，不调用模型或改正文。规则暂不持久化；接口及匹配口径见自身 README。

`lg-review` 另提供全书／章节一致性检查，复用审阅历史和作者判断，正文与正式事实不会自动改写。编辑台规则检查、一致性报告及作者处理已在隔离网页用 Chromium 实际点击，并验证重启读取；这不代表桌面 App 或全部面板已经完成验收。
