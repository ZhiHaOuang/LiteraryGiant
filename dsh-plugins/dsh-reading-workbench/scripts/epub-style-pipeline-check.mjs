/**
 * EPUB 章节样式链路判据：node scripts/epub-style-pipeline-check.mjs
 *
 * 这是一道**前提防线**，断言的是「书内样式为什么不能靠章节 HTML 自带」：
 *
 * 1. `sanitizeHtml`（DOMPurify）会把 `<link rel="stylesheet">` 与 `<style>` **整个删掉**
 *    —— 这是安全上的正确行为（注入 `<link>` 会让书内 CSS 全局生效，改坏整个 GUI）。
 *    因此书内样式只能走 Host 的 `/styles` 通道取出来、作用域化后再注入（见 client/book-css.ts）。
 * 2. `class` 属性与语义标签会被保留 —— 它们是作用域化选择器的唯一挂载点。
 *
 * ⚠️ 如果哪天第 1 条变成 PASS=「link 被保留」，**不要**顺手改断言：
 *    那意味着章节 HTML 里的外部样式表会被浏览器真的加载，作用域化机制被绕开、
 *    书内 `p` / `body` 规则将污染整个 DSH 界面。正确做法是同时确认注入路径已改为
 *    「把 link 从 HTML 里剥掉、只保留 /styles 通道」。
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

const { sanitizeHtml } = await import('../src/client/markdown.ts');
const { rewriteChapterHtml } = await import('../src/client/chapter-html.ts');

let allPass = true;
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

const chapter = `<?xml version='1.0' encoding='utf-8'?>
<html xmlns="http://www.w3.org/1999/xhtml"><head>
  <title>章</title>
  <link rel="stylesheet" type="text/css" href="../stylesheet.css"/>
  <style>.calibre_1 { text-align: center; }</style>
</head><body class="calibre1">
  <p class="calibre_1"><span class="calibre5"><span class="bold">02 周期的特征</span></span></p>
  <p class="calibre_2">正文第一段，带<span class="italic">斜体</span>。</p>
  <img class="calibre_9" src="../images/00001.jpeg" height="587" width="939"/>
</body></html>`;

const rewritten = rewriteChapterHtml(chapter, {
  chapterHref: 'text/part0006.html',
  assetUrl: (path) => `api/reading-workbench/asset?bookId=B&path=${encodeURIComponent(path)}`,
});
// 重写阶段：书内 CSS 的 href 应当被改写到 /asset（说明路径解析没问题）
check('重写：stylesheet 的相对路径被解析为包内路径', rewritten.includes('path=stylesheet.css'));
check('重写：图片路径同样被解析', rewritten.includes('path=images%2F00001.jpeg') || rewritten.includes('path=images/00001.jpeg'));

const sanitized = sanitizeHtml(rewritten);

// ── 前提判据 ──
check('消毒：<link rel="stylesheet"> 被剥离（书内 CSS 不能靠 HTML 自带）', !/<link/i.test(sanitized));
check('消毒：<style> 被剥离（否则内联样式同样全局生效）', !/<style/i.test(sanitized));
check('消毒：class 属性保留（作用域选择器的挂载点）', /class="calibre_1"/.test(sanitized) && /class="bold"/.test(sanitized));
check('消毒：语义标签保留', /<p\b/.test(sanitized) && /<img\b/.test(sanitized));
check('消毒：脚本被清除', !/<script/i.test(sanitizeHtml('<script>alert(1)</script><p>x</p>')));

// ── 反证判据：产物必须非空，否则上面「不存在 link」可能只是因为整段被清空 ──
check('反证：消毒后的正文非空', sanitized.trim().length > 0, `长度 ${sanitized.trim().length}`);
check('反证：正文文字保留', sanitized.includes('02 周期的特征') && sanitized.includes('正文第一段'));

console.log(allPass ? '\nEPUB 章节样式链路判据全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
