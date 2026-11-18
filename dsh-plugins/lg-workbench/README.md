# lg-workbench

作者控制的章节与场景编辑台。依赖 lg-books；通过 DSH 的受信任连接 API 读写，不调用旧 Python 后端或 Codex。

## 2026-11-11：章节阅读器对照

入口：文学编辑台 → 选择作品和章节 → 阅读对照。可切换鲸歌沉浸阅读、Reading Workbench 分页及 Annotator 批注，支持上/下一章、章节下拉、已有版本选择和展开阅读。原有编辑/采用入口保留，未保存编辑时不能切换。

这是一轮基座体验：直接复用各上游的真实阅读 UI，在 sandbox iframe 内使用当前所选版本的完整正文；不安装其 Agent 或数据后端，不复制作品目录、不写正文、不调用模型。试用批注只在当前阅读器内存中保留，切换章节/版本/方案或退出即清除，Annotator 可导出 JSON 或整理可复制摘录。阅读设置也不跨窗口保存。暂不承诺采用其中任何一个作为正式基座。

| 方案 | 固定源码 | 复用范围 | 许可 |
| --- | --- | --- | --- |
| Whalesong 0.1.4 | `2cd40d762a0ee742af3655a7b4711b65e4f81689` | ReaderPage、PrefsControls、排版 CSS | LGPL-3.0-or-later |
| Reading Workbench 0.2.0 | `0780abab8201c1b1dd7297dbbdc4cbc15248a92a` | ReaderView、FlowReader、分页和划线 | MIT |
| Markdown Annotator 0.9.0 | `75f7f4d7c7cad205ed7cda7b687774e0db8a4254` | MarkdownDocument、MdAnnotateView、批注卡片和连线 | MIT |

固定来源、适配器、上游原始源码及第三方许可保存在 `readers/<方案>/`，文件 SHA-256 见各自 `copy-manifest.json`。没有复制上游 `.git` 或 `node_modules`。阅读器保留自己的样式，不将全局 CSS 注入 DSH。消息桥只接受当前 iframe 的 ready/back/quote；章节载荷不包含宿主凭据或可执行操作。CSP 禁止网络请求，sandbox 不允许同源访问；仅额外允许作者主动导出下载。

已知体验限制：Reading Workbench 原版工具条在约 420px 窄栏下会拥挤/截断；Annotator 的正文布局偏紧凑，适合审阅而非沉浸阅读。此次不通过重新设计上游 UI 隐藏差异。鲸歌隐藏了没有媒体数据的音频入口；批注报告只整理为文本，不会自动发送给 Agent。

重建各阅读器按各自 README 执行，依赖在隔离目录准备；运行时没有新增服务。随后从 `dsh-plugins` 执行：

```sh
node lg-workbench/scripts/build-reader-previews.mjs
node scripts/build.mjs lg-workbench
node --test lg-workbench/tests/*.test.mjs
node --test --test-name-pattern=lg-workbench tests/client.test.mjs
```

`tests/reader-desktop.mjs` 为单独的真实 App 回归，需 `LG_READER_TEST_ROOT` 指向 LitIsLand 的本轮集成测试目录，`LG_PLAYWRIGHT_MODULE` 指向已安装 Playwright，可选 `LG_READER_TEST_HOME` 指向独立 profile。不使用日常 profile 运行该测试。单元验证选中版本、跨书章节标识和消息来源；桌面验证三个真实阅读器、切章、候选版本与未保存编辑保护。各上游阅读器还在独立 Chromium iframe 验证字号/分页/批注等交互。

修改另存版本；候选不覆盖正文；采用和拒绝须预览后点击确认。整章任一场景变化会拒绝旧快照提交。操作收据支持同请求重试。保存当前正文或采用候选会自动创建或更新整章 Markdown，回执显示文件位置。发生外部冲突时到「章节文件」比较。磁盘错误修复后可在该页重试原同步。历史版本改稿先另存为候选。旧审批规则尚未迁移的候选不可在此采用。

安装 lg-agents 和 lg-execution 并配置模型后，可在右侧文本框选区，预览实际模型输入与费用预留，再运行润色或证据审阅。润色只保存候选；审阅显示原文句段与版本位置。模型调用成功与结果校验通过分别显示；不自动采用建议。

启用 lg-library 后，任务面板可检索并选择最多 3 条参考资料；最终发送的片段出现在完整模型输入中。未选择资料时，普通编辑与文学任务不依赖 Library。资料发生变化时，旧预览、生成后的候选写入或采用会被阻止，需重新检索和审阅。

当前空场景可选择“按批准计划起草空场景”，需要 lg-planning / lg-context 和已批准的非空计划。任务针对整个空场景，结果显示实际字数、目标范围及不足提示；打开候选后仍需作者比较和采用。生成期间或采用前计划、正文、材料发生变化会阻止写入。

启用 lg-review 后，使用“审阅此选区／查看已保存报告”进入持久化审阅面板，可查看证据、作者处理历史，选择问题要求润色。改稿范围固定为该报告版本与选区，选区外内容由程序保留；需要退出按问题改稿后才能自由编辑或更换选区。源候选已有的计划、材料与反馈采用条件沿来源链继续复核。

章节文件同步位于文学编辑台的「章节文件」。支持旧版 Markdown 标记与同步基线。确认导入会在同一事务保存所有变更段落及回执。双侧修改需选择保留的一方或先手工合并。更新磁盘文件时，原件留在作品的 `.literarygiant/chapter-sync-backups/`。新基线存于作品 SQLite，旧 CLI 不读取这份基线。

旧版章节导入中断时，编辑台会检查日志、历史版本和逐段正文摘要。若已提交，确认后登记原导入基线并更新相关全文检索条目。若尚未提交且文件与原快照一致，确认后继续原导入。恢复收据保存在作品 SQLite，旧日志保留供核对。
