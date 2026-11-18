# Whalesong 章节阅读对照

来源：<https://github.com/xuhao1/whalesong-studio>，0.1.4，固定提交 `2cd40d762a0ee742af3655a7b4711b65e4f81689`。上游代码为 LGPL-3.0-or-later；完整许可在 `upstream/LICENSE` / `upstream/COPYING`，React、React DOM、Scheduler 许可在 `licenses/`。

直接复用上游 `src/client/reader/parts.tsx` 的 `ReaderPage`、`PrefsControls`、`useReaderPrefs` 和原始样式，不仿写正文排版。适配器仅负责 LG 章节消息、容器布局；无音频的试用隐藏原版声音标记开关。没有加载 Whalesong 后台、Agent、生成、保存正文或媒体接口。

`preview.html` 可直接放进 `iframe.srcDoc`，使用 `sandbox="allow-scripts"`，不添加 `allow-same-origin`。HTML 自含全部 JS/CSS，CSP 禁止网络请求与表单；书中 Markdown 图片只用本地透明占位，此试用不展示外部媒体。字体使用系统字体。原版阅读偏好在受限 iframe 中仅保留于当前阅读器实例，关闭后不持久化。

宿主监听 `{type:'lg-reader:ready'}` 并只向对应 iframe 发送：

```js
{ type:'lg-reader:chapter', chapterId:'book/version/chapter', title:'第一章', text:'正文',
  bookTitle:'书名', chapterIndex:1 }
```

`bookTitle`、`chapterIndex` 可选；缺章序时不显示虚构章序。重复同章同正文消息不重置滚动；切换章节重置阅读位置。只接受父窗口消息，标题及正文由 React 安全渲染。

复现：复制 `copy-manifest.json` 中列出的文件并保留目录结构，运行 `npm ci --ignore-scripts --no-audit --no-fund` 和 `npm run build`。本目录另保留完整上游 clone 供研究，但产品仅需清单中的文件，不需要 `node_modules` 或完整上游资产。

验证：`test.mjs` 在真正 `sandbox="allow-scripts"` iframe 内测试 65 段中文、字号、纸张/夜间主题、重复消息保留滚动、章节切换、390px 溢出与 JavaScript 错误。需要环境变量 `LG_PLAYWRIGHT_MODULE` 和 `LG_CHROMIUM_EXECUTABLE`。2026-11-11 已通过，使用合成正文，没有模型调用。
