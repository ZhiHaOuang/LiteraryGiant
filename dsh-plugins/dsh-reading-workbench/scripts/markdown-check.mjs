/**
 * Markdown 渲染管线验证：用 jsdom 提供真 DOM，直接加载源码里的 renderMarkdown，
 * 断言渲染结构与消毒效果。Node 24 原生支持剥离类型后 import .ts。
 * 用法：node scripts/markdown-check.mjs
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// DOMPurify 在浏览器/类浏览器环境下工作，先建好全局 DOM 再动态导入被测模块。
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

const { renderMarkdown } = await import('../src/client/markdown.ts');

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

// 1) 样例文档渲染出正确的结构
const sample = readFileSync(join(here, 'fixtures', 'sample.md'), 'utf8');
const sampleHtml = renderMarkdown(sample);
check('样例文档渲染出 h1', sampleHtml.includes('<h1'));
check('样例文档渲染出 h2', sampleHtml.includes('<h2'));
check('样例文档渲染出段落', sampleHtml.includes('<p>'));
check('标题文本保留', sampleHtml.includes('阅读工作台'), undefined);

// 2) GFM 结构：列表 / 引用 / 代码 / 表格
const gfm = renderMarkdown(
  ['- 甲', '- 乙', '', '> 引用一行', '', '```js', 'const a = 1;', '```', '', '| A | B |', '| - | - |', '| 1 | 2 |'].join('\n'),
);
check('渲染无序列表', gfm.includes('<ul>') && gfm.includes('<li>'));
check('渲染引用块', gfm.includes('<blockquote>'));
check('渲染代码块', gfm.includes('<pre>') && gfm.includes('<code'));
check('渲染表格（GFM）', gfm.includes('<table>') && gfm.includes('<th>'));

// 3) 消毒：脚本 / 事件属性 / javascript: 链接必须被清掉
const dirty = renderMarkdown(
  ['<script>alert(1)</script>', '', '<img src="x" onerror="alert(2)">', '', '[点我](javascript:alert(3))', '', '<iframe src="http://evil"></iframe>'].join('\n'),
);
check('清除 <script>', !dirty.includes('<script'));
check('清除 onerror 事件属性', !dirty.includes('onerror'));
check('清除 javascript: 链接', !dirty.includes('javascript:'));
check('清除 <iframe>', !dirty.includes('<iframe'));

// 4) 正常图片与链接保留
const safe = renderMarkdown('![图](https://example.com/a.png)\n\n[链接](https://example.com)');
check('保留 https 图片', safe.includes('<img') && safe.includes('https://example.com/a.png'));
check('保留 https 链接', safe.includes('<a ') && safe.includes('https://example.com'));

console.log(allPass ? '\nMarkdown 渲染管线全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
