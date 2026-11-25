# LiteraryGiant：DSH 源码与本机开发入口

更新日期：2026-11-07。此版本用于本机体验与插件开发；文学能力正在改写为独立 DSH 插件，进度见 [迁移与验收](dsh-plugin-migration.md)。

## AI4Scholar 文献工作台

AI4Scholar 0.6.6 的 MIT 源码位于 `dsh-plugins/dsh-ai4scholar/`。桌面通过本地目录链接加载，侧栏入口为 **Ai4Scholar**。在仓库根目录执行以下命令准备依赖、构建和检查工作台。

```sh
python3 scripts/dsh.py --dir ../dsh-plugins/dsh-ai4scholar install --frozen-lockfile --ignore-scripts
python3 scripts/dsh.py --dir ../dsh-plugins/dsh-ai4scholar run build
python3 scripts/dsh.py --dir ../dsh-plugins/dsh-ai4scholar exec vitest run tests/workbench-ui.test.ts tests/workbench-controller.test.ts tests/workbench.test.ts
```

首次注册可在桌面「插件 → 添加插件」填写项目绝对路径的 `link:` 引用。在 App 完全退出时，也可从仓库根目录使用打包 CLI。

```sh
LG_ROOT="$(pwd -P)"
DSH_HOME="$HOME/.literarygiant-dsh" ELECTRON_RUN_AS_NODE=1 \
  /Applications/LiteraryGiant.app/Contents/MacOS/LiteraryGiant --expose-internals \
  /Applications/LiteraryGiant.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js \
  plugin --profile desktop add --offline --save-exact "link:$PWD/dsh-plugins/dsh-ai4scholar"
```

修改源码后重新构建，再重开 App 加载。进工作台查看界面不需要模型凭据，付费文献来源使用在设置页另行配置的 AI4Scholar API Key。

## Reading Review 章节阅读审阅

当前章节阅读与审阅使用 [`lg-reading-review`](../dsh-plugins/lg-reading-review/README.md)，直接读取 LG 作品及版本。日常 App 的阅读入口使用该插件，旧独立 Reading 插件已退出日常配置。

## 2026-11-07 交付记录

日常 App 已补齐全部 23 个源码链接插件，并在实际桌面逐项验证运行。入口与当前限制见 [交付与体验](dsh-delivery-20261107.md)。本页此前“16 个链接、七个待补装”是历史状态，已完成。当前整套 tgz 为 `.dsh-dev/plugin-packages/20261107-legacy-chapters/`，17 包共 207 文件；摘要见 `legacyChapterAdoptionValidation.archives`。本机日常 App 使用源码链接，DMG 仍为原宿主包，未内嵌这些新插件。

文学执行器已配置 GLM-4.5-Air 和 DSH 私有凭据引用。预算沿用累计 ¥10，已有预留 ¥7.446666；正式本机账本在 `~/.literarygiant-dsh/literary-execution/model-budget.sqlite3`。原生聊天设置保持原状，文学执行器预算只约束文学任务，不代表原生聊天的消费上限。

## 启动与产物

文中的 `$LITISLAND_ROOT` 代表本机 LitIsLand 根目录，`$LG_ROOT` 代表当前项目根目录。

- 新 App：`/Applications/LiteraryGiant.app`。
- 打开：`open -a /Applications/LiteraryGiant.app`。
- 版本：`0.2.2-rc.1.20261104.1`，沿用作者已确认的本地测试版本号。
- 平台：macOS arm64；本机 ad-hoc 签名，无 Developer ID 公证，不是正式发行版。
- DMG：`$LITISLAND_ROOT/deepseek-harness/apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/literarygiant-0.2.2-rc.1.20261104.1-mac-arm64-unsigned.dmg`。
- SHA-256：`dc99ecf1b1b482b3f7e4554f9e0b7ac741dc2ae870f4aaff32e1ee9ad47b6013`。

App 图标来自作者指定的 `IMG_7822.JPG`，仅进行格式与尺寸转换。窗口、菜单、欢迎页和侧栏品牌已显示 LiteraryGiant。未配置或迁移 API 凭据；若启动出现欢迎页，可选择 Add API Key → Set up later 浏览界面。

原官方 `/Applications/DeepSeek Harness.app`、旧 LG `~/Applications/LiteraryGiant.app` 均保留。两个 LG 同名，使用上述的绝对路径打开本次 DSH 版本。

## 独立配置

| 项目 | 本次值 |
|---|---|
| Bundle ID | `com.literarygiant.desktop` |
| OS URL scheme | `literarygiant://open`，不接管官方 `dsh://` |
| 默认 DSH_HOME | `~/.literarygiant-dsh` |
| 插件 profile | `~/.literarygiant-dsh/profiles/desktop` |
| Electron userData | `~/Library/Application Support/LiteraryGiant DSH` |

启动时显式传入非空 `DSH_HOME` 仍会覆盖默认值；正常 Finder 启动使用上述 LG 默认值。Electron 的显式 `--user-data-dir` 也保留供测试使用。

目录隔离不等于文件访问沙箱。此阶段不将真实作品目录交给通用文件工具编辑。

## 已安装并启用的插件

| 包 | 固定版本或来源 | 最终 UI 状态 |
|---|---|---|
| dsh-ascii-sharks | 项目内源码，0.1.0 | 1 running |
| dsh-better-sidebar | 0.30.1 | 1 running |
| dsh-claude-style | 0.19.9 | 1 running |
| dsh-context | 0.82.1 | 1 running |
| dsh-ops | 0.5.0 | 1 running |
| lg-brand | `link:$LG_ROOT/dsh-plugins/lg-brand`，0.1.0 | 1 running |

六个插件现在均使用 `link:$LG_ROOT/dsh-plugins/<包名>`。五个第三方包的版本和源码 commit 固定，未升级版本、未添加兼容豁免、未修改其业务实现。重新启动 App 后，已逐个核对 Source 路径与 Running 状态。

Claude 风格插件会自行替换侧栏品牌，因此使用它已有的配置设置 LG 名称：

```yaml
- id: ui-skin-claude-style
  config:
    brandName: LiteraryGiant
```

这条 patch 位于 LG 的 `profiles/desktop/cordis.patch.yml`；该插件的品牌图片位于 LG home 下的 `dsh-claude-style/brand/mark.png`。`lg-brand` 则通过原生 slots 提供关闭该主题后的品牌显示。主题与动画插件可能覆盖同一画面区域，“运行中”不表示所有装饰同时可见。

插件安装到本机 profile，**不包含在 DMG 内**。当时除五个学习插件和 lg-brand，已添加 lg-books、lg-dashboard、lg-workbench、lg-execution、lg-agents、lg-library、lg-memory、lg-context、lg-planning、lg-review，共 16 个本地链接；均依赖项目目录继续存在。换机器先准备构建产物与依赖，再注册新路径，或安装已生成的 tgz。新模型执行器默认预算为 0，模型路由和凭据仍须在本机配置；本次真实模型验证使用独立 LitIsLand profile，桌面配置尚未迁入该验证凭据。现有 App 二进制来自上一次打包，本次未重新生成 DMG。

维护插件时先完全退出此 App，从仓库根目录使用自己的 home 和打包 CLI，避免操作官方 profile。例如：

```sh
LG_ROOT="$(pwd -P)"
DSH_HOME="$HOME/.literarygiant-dsh" ELECTRON_RUN_AS_NODE=1 \
  /Applications/LiteraryGiant.app/Contents/MacOS/LiteraryGiant \
  --expose-internals \
  /Applications/LiteraryGiant.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js \
  plugin --profile desktop add --save-exact \
  "link:$LG_ROOT/dsh-plugins/dsh-ascii-sharks" \
  "link:$LG_ROOT/dsh-plugins/dsh-better-sidebar" \
  "link:$LG_ROOT/dsh-plugins/dsh-claude-style" \
  "link:$LG_ROOT/dsh-plugins/dsh-context" \
  "link:$LG_ROOT/dsh-plugins/dsh-ops" \
  "link:$LG_ROOT/dsh-plugins/lg-brand"
```

## 源码与重建

- 正式框架源码：`$LG_ROOT/dsh`。
- 基线 commit：`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，DSH `0.2.2-rc.1`、Cordis `4.1.0`。
- 采用源码快照，跟随 LiteraryGiant 父仓库管理；没有嵌套 `.git` 或新增子模块。本轮未提交或推送。
- 保留此前 LG 品牌、桌面隔离目录与运行时清单修复。上游包名、服务名和 Cordis 接口不变。
- 第三方插件版本和来源见 `dsh-plugins/sources.lock.json`，Claude-style 素材范围见 [插件说明](../dsh-plugins/README.md)。
- 本机工具链在忽略目录 `.dsh-dev/node`，Node `24.22.1`、pnpm `11.28.5`。换机器使用 PATH 上 Node >=24.9 或设置 `LG_NODE` 为 Node 可执行文件；无需复制 LitIsLand。
- LitIsLand 中的 checkout 和 `lg-dsh-import-20261107/snapshot` 继续作为实验与验证副本保留。

从 LiteraryGiant 根目录准备并构建：

```sh
python3 scripts/dsh.py install --frozen-lockfile
python3 scripts/prepare-dsh-plugins.py
python3 scripts/dsh.py --dir ../dsh-plugins/dsh-better-sidebar install --prod --frozen-lockfile --ignore-scripts
python3 scripts/dsh.py --dir ../dsh-plugins/dsh-context install --prod --frozen-lockfile --ignore-scripts
python3 scripts/dsh.py run build --profile local
```

`dsh.py` 在 `dsh/` 中运行固定 pnpm；首次安装使用 npm 获取固定 pnpm，安装阶段通过 CI 模式跳过上游 Git hooks。`prepare-dsh-plugins.py` 下载并验证四个锁定发行包，只准备 `lib/` 和 `runtime/`；不会覆盖不同内容的本地构建，重复执行会保留已有构建。sharks 的上游已跟踪 `lib/`，lg-brand 无须构建。上述生产依赖足以加载固定产物，修改插件源码时另按其规则安装开发依赖并构建。

从项目源码启动一个独立 Web 开发环境：

```sh
DSH_HOME="$PWD/.dsh-dev/home" python3 scripts/dsh.py dsh web --no-open --host 127.0.0.1 --port 0
```

这个 Web profile 与桌面 profile 分开；不会自动带上桌面的插件配置。停止用 Ctrl-C。日志中启动 URL 含本机访问令牌，不将完整 URL 提交或复制到公开文档。

以后重建 macOS arm64 安装包使用项目入口：

```sh
python3 scripts/dsh.py run package:desktop:mac:arm64:unsigned --build-version 0.2.2-rc.1.20261104.1
```

这个版本号仅沿用作者已确认的本地测试版本；后续新版本按上游打包规则处理。完整打包验证来自前次隔离 checkout；本次项目目录验证的是完整 build。其他平台、签名发布与更新服务不在本轮范围。

额外修复：Finder 会在构建目录生成 `.DS_Store`，而 electron-builder 不把它打入 ASAR。运行时清单现在仅排除这种 Finder 元数据，真实文件的哈希、成员和执行权限检查仍保留；回归测试覆盖元数据出现及真实文件被修改的情况。

## 验证记录

本次源码迁入：隔离副本与实际 `LiteraryGiant/dsh` 的完整 build 均为 10 项通过、0 失败，包括 Host/Client 编译、bundle、aggregate check、Web 与 Desktop bundle；插件产物完整性校验通过。六个项目路径插件在已安装 App 中均为 `1 total · 1 running`。五个第三方插件的全部源码测试和重新编译不在本次验证范围。

实际项目源码 Web 入口使用独立空 home 启动成功；按正常 Cookie 认证流程访问首页返回 HTTP 200、标题 LiteraryGiant，随后停止测试进程。23,776 个导入文件的摘要与导入基线一致；12 个被上游忽略规则挡住的已跟踪测试夹具以精确路径登记到父 Git，真实依赖和构建缓存仍被忽略。辅助脚本语法检查与产物准备的重复执行通过。

此前 App 品牌与打包验证：

- 5 个相关测试文件、156 项测试通过：构建环境、构建流程、运行时完整性、桌面环境、菜单文案。
- 最终完整构建及 Host／Client aggregate checks 通过。
- 打包前后原生工具和运行时 smoke 通过，包括 pty、ripgrep、glob、sharp、koffi、离线插件安装，以及 DOCX/XLSX/PPTX 转 PDF。
- 安装后的 `codesign --verify --deep --strict` 通过。
- 实际打开最终 App；窗口与侧栏名称、头像和六个插件的 Running 状态已在 UI 核对。
- 未调用付费模型，未验证文学生成质量；文学业务桥接、正式作品写入与 Library 接入尚未实现。

模块边界与下一步见 [文学模块与最小接入](dsh-module-map.md)，插件例子见 [dsh-plugins](../dsh-plugins/README.md)。

已发现安装包中的 `runtime/cli/bin/dsh` 仍指向旧可执行文件名 DeepSeek Harness，故该包装脚本目前不可用；上文直接调用 LiteraryGiant 可执行文件的入口已实际验证 --help。源码中的 macOS/Windows 包装脚本已改为 LiteraryGiant，4 项启动器／分派测试在隔离与项目通过。为保留签名和运行时清单，本次未修改已安装 App 或重新生成 DMG；修复随下次打包生效，Windows 执行仍未实机验证。

### 隔离网页 UI 验收（2026-11-07）

Mac 锁屏不妨碍 headless Chromium 检查独立网页 profile。本批使用 DSH 锁定 Playwright 1.61.1，浏览器运行包仅在 LitIsLand 测试目录；没有新增产品依赖。已实际点击文学编辑台的免费规则、一致性报告、作者理由与确认，并验证重启后选择历史报告和读取理由。初次账户弹窗使用自带关闭按钮，不填新凭据；使用 DOM 就绪而非 networkidle 等待持续连接页面。后续的桌面实测见下节。

### 已安装 App 的独立 profile 验收（2026-11-07）

使用同一份 `/Applications/LiteraryGiant.app`、独立 Electron userData 和独立 DSH_HOME 做了两次桌面验收。项目链接方式加载了 22 个插件。第二个全新 profile 离线安装 16 个文学与执行插件的 tgz，并链接品牌与五个学习插件。插件管理器中，两次均逐项核对了 22 个来源和各自的 `1 total · 1 running`。独立包的 165 个已安装文件均与对应 tgz 字节一致。包名、文件数和摘要见 [桌面验证记录](dsh-plugin-validation-20261107.json) 的 `packagedDesktopValidation`。

用三章合成作品实测了九个桌面面板。控制台显示正文计数 18、已采用计数 9。编辑台将修改保存为候选，当前正文保持原文。免费规则检查命中一个禁用词，修订影响页能反查该候选。还验证了文学方法选择、工作流起草顺序、作者偏好历史、资料检索与来源哈希、读者视角查询和构思表单。任务分派插件补上 Cordis 的 `slots` 服务声明后，源码和 tgz 均通过桌面冷启动与任务列表刷新。此批桌面测试使用合成资料，模型调用为零。

日常 desktop profile 已有 16 个项目链接，内含作者指定的五个基础插件。还差以下七个（含本次新增的 `lg-export`）。保存编辑并完全退出日常 App 后，在本仓库根目录运行：

```sh
LG_ROOT="$(pwd -P)"
DSH_HOME="$HOME/.literarygiant-dsh" ELECTRON_RUN_AS_NODE=1 \
  /Applications/LiteraryGiant.app/Contents/MacOS/LiteraryGiant \
  --expose-internals \
  /Applications/LiteraryGiant.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js \
  plugin --profile desktop add --offline --save-exact \
  "link:$PWD/dsh-plugins/lg-workflows" "link:$PWD/dsh-plugins/lg-author" \
  "link:$PWD/dsh-plugins/lg-tool-policy" "link:$PWD/dsh-plugins/lg-director" \
  "link:$PWD/dsh-plugins/lg-impact" "link:$PWD/dsh-plugins/lg-skills" "link:$PWD/dsh-plugins/lg-export"
open -a /Applications/LiteraryGiant.app
```

在已有源码链接的测试 profile 中，切换同版本 tgz 后，pnpm 将 specifier 改为 file，实际模块仍解析到原链接。因此独立安装包的验收使用了全新 profile，并逐个核对实际模块目录。

本次作品导出另用全新的隔离桌面 profile 安装 17 个 tgz 和六个链接，174 个归档成员均与安装位置逐字节相同。DSH 文件保存服务在隔离下载目录完成 18 种内容与格式组合。桌面「另存为」入口可见，本批保存操作使用「下载」。

章节文件更新归入 lg-books 与 lg-workbench。入口为「文学编辑台 → 章节文件」。本批在新建桌面 profile 安装 17 个 tgz 及六个链接，176 个归档文件与实际安装一致。两个更新包的相对路径与摘要在验证记录的 `chapterFileValidation.archives` 中。日常 profile 已链接这两个插件的项目目录，本批冷启动验证在隔离 profile 完成。

旧导入恢复沿用同一面板。最新安装包路径和 SHA-256 见验证记录的 `legacyChapterRecoveryValidation.archives`。验证使用独立桌面 profile 和合成作品，两种中断均实际点击恢复并冷启动复查。

故事索引使用更新后的 lg-books 与 lg-dashboard。安装包路径和摘要在验证记录的 `storyIndexValidation.archives` 中。独立桌面实测覆盖读取、来源检查、切换作品、重建、来源变化和冷启动。

章节分析证据使用更新后的 lg-books、lg-planning 和 lg-dashboard。包路径与 SHA-256 见验证记录的 `analysisIndexValidation.archives`。在作品含已选方向时配套启用新版规划插件，供同一事务校验历史选项。

作者编辑自动同步由 lg-books 和 lg-workbench 提供。包路径和摘要见验收记录的 `automaticChapterMirrorValidation.archives`。本次验证使用独立桌面 profile，覆盖实际保存、采用与冷启动重试。

规划变更同步使用 lg-books、lg-planning 与 lg-workbench。作者在「故事规划」预览并确认变更，提交结果显示受影响的章节。在记录的「历史」展开该次操作，可重试单个待同步章节。验证记录的 `structureMirrorValidation.archives` 列出本轮独立桌面安装的归档相对路径与 SHA-256。

整章规则改稿配套使用 lg-workflows、lg-review、lg-workbench 与 lg-agents。最终离线包路径和摘要见 `chapterWorkflowRulesValidation.archives`。「文学工作流 → 整章生成」可展开规则表，打开已生成候选的流程可查看结果并勾选失败项。

章节质量报告更新 lg-review、lg-workbench 和共享审阅面板所在的 lg-planning 客户端构建。安装包路径与摘要见验收记录的 `chapterQualityValidation.archives`。

文学专家设置使用更新的 lg-agents。在 Plugins 打开 lg-agents 可编辑当前 profile 下的专家设置。安装包相对路径与 SHA-256 见 `specialistSettingsValidation.archives`。

事实提取与资料分析的界面修复涉及 lg-memory、lg-library 与共用请求代码所在的 lg-agents。可从「故事记忆 → 从正文提取记忆」或「文学资料 → 选择用于分析」验证。最终归档路径和哈希见 `authorExtractionPanelsValidation.archives`。

逐章待审版本清单使用更新的 lg-books、lg-dashboard 和 lg-workbench。独立桌面安装包与摘要在 `dashboardPendingVersionsValidation.archives`。

编辑台的受监督候选采用更新 lg-books 与 lg-workbench。最终包路径和哈希见 `supervisedAcceptanceValidation.archives`。

采用后的章节分析发布配套使用 lg-books 与 lg-workbench。最终归档及摘要见 `acceptedReportPublicationValidation.archives`。

章节候选监督生成需使用配套的 lg-agents、lg-books、lg-library、lg-workbench。打开「文学编辑台」，选择当前章的一份候选，点「检查或补齐监督报告」。安装归档及 SHA-256 在验证记录的 `candidateAnalysisGenerationValidation.archives`。日常 profile 与本轮独立验证 profile 分开。

控制台「章节候选监督」使用 lg-dashboard 和 lg-books。旧书可以在此启用旧版定义的五类监督，新建作品时在预览中列出监督文件。对应归档与摘要见 `bookSupervisionPolicyValidation.archives`。

文学工作流的场景采用预览与文学编辑台共用监督审阅组件。新版 lg-workflows 与 lg-workbench 的安装归档与摘要见 `workflowSceneSupervisionValidation.archives`。

原生会话分派候选监督使用 lg-director、lg-agents 和 lg-workbench。对应离线包和摘要见 `directorCandidateAnalysisValidation.archives`。模型在当前作品的会话中查询候选版本与类别；作者在「文学任务」选择该作品后查看、确认并执行提议。

在「故事规划 → 创作方向」选定具体方案后，点击「按此方向起草章节」。全书或卷级方向先选目标章。安装包和 SHA-256 见 `chapterDirectionWorkflowValidation.archives`。

### 本机可安装的整套独立插件（2026-11-07，含跨章起草）

本次兼容的 17 个独立 tgz 在本仓库的 `.dsh-dev/plugin-packages/20261107-legacy-chapters/`。各包的文件名、SHA-256 和成员数见 `chapterSequenceValidation.archives`。这个本机生成目录没有测试适配器。五个学习插件及 lg-brand 仍使用本仓库的对应目录链接。

在仓库根目录执行下列命令，可安装到指定 DSH_HOME 中已初始化的独立 desktop profile。将 `LG_TEST_HOME` 设为该独立目录的绝对路径。验证使用本机已有的离线依赖缓存。同版本源码链接的替换限制见前文。

```sh
DSH_HOME="${LG_TEST_HOME:?请先设置独立的 LG_TEST_HOME}" ELECTRON_RUN_AS_NODE=1 \
  /Applications/LiteraryGiant.app/Contents/MacOS/LiteraryGiant --expose-internals \
  /Applications/LiteraryGiant.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js \
  plugin --profile desktop add --offline --save-exact \
  "$PWD"/.dsh-dev/plugin-packages/20261107-legacy-chapters/*.tgz \
  "link:$PWD/dsh-plugins/lg-brand" "link:$PWD/dsh-plugins/dsh-ascii-sharks" \
  "link:$PWD/dsh-plugins/dsh-better-sidebar" "link:$PWD/dsh-plugins/dsh-context" \
  "link:$PWD/dsh-plugins/dsh-claude-style" "link:$PWD/dsh-plugins/dsh-ops"
```

在同一安装来源的新桌面 profile 逐项检查了这 23 个条目，插件管理器均显示其组件已运行。

在「文学工作流 → 旧版运行历史」查看本书旧运行，预览并确认导入。切换「查看已导入快照」可在原运行目录离线后重读，打开关联版本需要对应作品数据库仍保留正文。

在「文学工作流 → 按章节顺序起草」按需要的顺序加入章节并填写每章要求。采用或拒绝当前候选后再预览下一章，预览中可展开核对实际的前章结尾。

## Books / Library 加载（2026-11-08）

源码和插件已接入首次创作根目录选择。根目录中的 Books/ 每个有效 LG 作品文件夹对应一个原生 workspace，Library/ 为共享索引库；新书默认落入 Books/书名。书架总览提供全局 Dashboard，书名和 workspace 右键菜单打开本书 Dashboard，本书新对话使用该书 cwd。目录只在启动/页面刷新时重新发现。普通目录、损坏作品和符号链接给出提示，不自动改写。

对话仍由 DSH home 保存并按 workspace 关联，尚未实现随书文件夹携带的完整聊天存储。首次本地创作无需账号和模型密钥；模型设置按需配置。原 App 更新/重启的最终状态见 handoff 最新条目。

## 目录选择修正（2026-11-08）

Books 创作目录与 Library 参考库分别选择，可位于不同位置；所选目录本身直接生效，不追加同名子目录。此前的“共用根目录”设计已撤回，旧配置只保留路径兼容，不自动移动或清理用户数据。
