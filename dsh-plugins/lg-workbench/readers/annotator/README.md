# Markdown Annotator — LG 阅读对照适配

上游：https://github.com/3361805598-gif/dsh-md-annotator

固定 commit：`75f7f4d7c7cad205ed7cda7b687774e0db8a4254`，版本 0.9.0，MIT。源码完整下载在 `upstream/`，未修改上游源码；其 LICENSE 保留。

## 实际复用

`upstream/lib/src/` 的 styles、store、parser、selection、panel、files、documents、blocks、viewer、sidebar 原代码拼接并打包。直接渲染上游 `MarkdownDocument` / `MdAnnotateView`，使用原版段落预览、段落/选区批注、卡片连线、批注清单和重锚定。没有重做一套相似样式。

## LG 适配边界

- `readonly-toolbar.js` 替代原源码编辑/文件保存工具栏；只读正文、临时试用批注。
- `bridge.js` 接受父窗口章节消息，把正文送入原版 document store。无 Host、Better Sidebar、凭据或网络接口。
- 原版“写入对话草稿”的按钮/反馈文字在打包时改为“整理摘录”，处理器只把报告发回父窗口，不启动模型或发送对话。
- `frame.css` 提供 DSH 主题变量默认值和容器尺寸；批注主体样式来自上游。页面 CSP 限制为内联脚本/样式及 data 图片，禁止网络连接、远程图片与 base URL。
- 批注只在 iframe 内存中，切换方案/关闭试用窗口即丢失；同一窗口切换章节后返回可找回。
- 上游 JSON 导出功能保留，需要父 iframe sandbox 允许下载才可实际导出；父端可用 `allow-scripts allow-downloads` 支持用户手动导出，不需要 same-origin。

## 消息接口

```js
// iframe -> parent
{type:'lg-reader:ready'}
{type:'lg-reader:quote',text:'批注报告',chapterId:'book-path/chapter-id'}
// parent -> iframe; chapterId 必须同时区分书籍、章节和正文版本
{type:'lg-reader:chapter',title:'章节标题',text:'正文',chapterId:'book-path/chapter-id/version',theme:'light'}
```

消息源必须是 parent。`preview.html` 自包含，可用 iframe `srcDoc` 加载，sandbox 最少 `allow-scripts`；不需要 same-origin。`theme` 可为 dark。

## 构建与验证

`build.mjs` 使用 LG 已锁定的 esbuild、React 18.3.1 与 ReactDOM 18.3.1，不安装新依赖。必须显式设置 `LG_DSH_ROOT`（已有 dsh 目录）与 `LG_PLUGINS_ROOT`（已有 dsh-plugins 目录）；缺失即报错。React 许可证附在 `LICENSE-React`。

```sh
LG_DSH_ROOT=/absolute/path/to/dsh LG_PLUGINS_ROOT=/absolute/path/to/dsh-plugins node build.mjs
node verify.mjs
```

验证使用已有 Playwright 和隔离 Chromium；通过正文渲染、只读工具栏、添加批注、右侧卡片、摘录回传、章节隔离与返回、无外部请求、无浏览器错误，并通过 securitypolicyviolation 事件确认远程图片被 CSP 阻止。另已运行上游 `node test/unit.mjs`，通过。`annotator-proof.png` 为合成章节实际截图。
