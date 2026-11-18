# Reading Workbench / LG 章节试用

这是 `keyboard-leo/dsh-reading-workbench` 0.2.0 固定源码的真实 ReaderView 组件，非仿制界面。上游提交、许可与构建依赖见 SOURCE.json。上游源码未修改；`adapter.jsx` 提供纯文本章节和仅驻留内存的划线/笔记/进度接口。试用页不包含 PDF 导入、不调用模型、不访问网络，也不写入 LG 正文。

产物 `preview.html` 自包含全部 JavaScript 与 CSS，可放进 `sandbox="allow-scripts"` 的 iframe srcDoc。收到父页面的 `{type:'lg-reader:chapter',chapterId,title,text}` 后显示对应正文；准备好时发 `{type:'lg-reader:ready'}`，点击返回发 `{type:'lg-reader:back'}`。重复同章同正文不会重置当前位置；正文变化会清除该章过期试用批注。关闭 iframe 后所有试用标记和进度清空。

从本目录运行 `LG_DSH_ROOT=/absolute/path/to/LiteraryGiant/dsh node build.mjs` 可重建。必须指定 DSH 依赖根目录；使用固定 esbuild 0.28.2、React/React DOM 18.3.1、DOMPurify 3.4.16、marked 18.0.11，没有在项目安装新依赖。`copy-manifest.json` 列出本试用所需文件及 SHA-256，不含 node_modules、.git、整套上游后端和测试截图；打包运行依赖的许可位于 licenses/。

试用初始字号20、行距1.8、衬线字体、自适应单双页；中文 TXT 使用保留原换行模式。工具条、排版分页、划线抽屉和字号操作均来自上游组件。`pdf-unavailable.jsx` 是构建时禁用不属于本试用范围的 PDF 分支。颜色为 iframe 内提供的 DSH 主题变量，不影响宿主主题。

`test-preview.mjs` 使用已安装 Playwright 和 LitIsLand Chromium，在禁同源 iframe 中验证翻页、字号、划线、换章、重复消息、无网络及无脚本错误。仅合成正文，未接触真实作品。
