/**
 * 章节 HTML 重写回归（覆盖 2026-10-16 asset not found 事故）。
 * 用 jsdom 提供真 DOM，直接加载源码纯函数，断言重写结果。
 * 用法：node scripts/chapter-html-check.mjs
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { resolveChapterPath, rewriteChapterHtml } = await import('../src/client/chapter-html.ts');

let allPass = true;
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

const asset = (path) => `api/reading-workbench/asset?bookId=B&path=${encodeURIComponent(path)}`;

// ── 1) 路径归一化：以章节文件所在目录为基准 ──
check('同目录相对路径', resolveChapterPath('OEBPS/text/ch1.xhtml', 'ch2.xhtml') === 'OEBPS/text/ch2.xhtml', resolveChapterPath('OEBPS/text/ch1.xhtml', 'ch2.xhtml'));
check('上一级相对路径', resolveChapterPath('OEBPS/text/ch1.xhtml', '../images/pic.png') === 'OEBPS/images/pic.png', resolveChapterPath('OEBPS/text/ch1.xhtml', '../images/pic.png'));
check('多级上溯', resolveChapterPath('a/b/c/ch.xhtml', '../../img/x.png') === 'a/img/x.png', resolveChapterPath('a/b/c/ch.xhtml', '../../img/x.png'));
check('包内绝对路径', resolveChapterPath('OEBPS/text/ch1.xhtml', '/OEBPS/style/main.css') === 'OEBPS/style/main.css');
check('百分号转义解码', resolveChapterPath('OEBPS/text/ch1.xhtml', '../images/a%20b.png') === 'OEBPS/images/a b.png');
check('带 fragment 去掉锚点', resolveChapterPath('OEBPS/text/ch1.xhtml', '../images/p.png#frag') === 'OEBPS/images/p.png');

// ── 2) 重写：图片/样式走 asset，章节间链接走委托，外链补 target ──
const html = [
  '<html><body>',
  '<img src="../images/pic.png" alt="图"/>',
  '<link rel="stylesheet" href="../style/main.css"/>',
  '<a href="ch2.xhtml">下一章</a>',
  '<a href="ch2.xhtml#sec1">带锚点跳章</a>',
  '<a href="#local">章内锚点</a>',
  '<a href="https://example.com/doc">外链</a>',
  '<img src="data:image/png;base64,AAAA"/>',
  '</body></html>',
].join('');

const out = rewriteChapterHtml(html, { chapterHref: 'OEBPS/text/ch1.xhtml', assetUrl: asset });
const doc = new dom.window.DOMParser().parseFromString(out, 'text/html');

const img = doc.querySelector('img[alt="图"]');
check('章节图片解析到正确 asset 路径', img?.getAttribute('src') === asset('OEBPS/images/pic.png'), img?.getAttribute('src'));
const css = doc.querySelector('link[rel="stylesheet"]');
check('样式相对路径解析正确', css?.getAttribute('href') === asset('OEBPS/style/main.css'), css?.getAttribute('href'));
const chapterLink = doc.querySelector('a[data-dsh-chapter-link]');
check('章节间链接改为委托标记', chapterLink?.getAttribute('data-dsh-chapter-link') === 'OEBPS/text/ch2.xhtml', chapterLink?.getAttribute('data-dsh-chapter-link'));
check('章节间链接不再指向 asset', chapterLink?.getAttribute('href') === '#');
const anchorLink = [...doc.querySelectorAll('a')].find((a) => a.textContent === '章内锚点');
check('章内锚点原样保留', anchorLink?.getAttribute('href') === '#local', anchorLink?.getAttribute('href'));
const external = [...doc.querySelectorAll('a')].find((a) => a.textContent === '外链');
check('外链补 target=_blank', external?.getAttribute('target') === '_blank');
check('data: 图片原样保留', doc.querySelector('img[src^="data:"]') !== null);

// ── 3) 回归：不再产生「把 xhtml 丢给 asset」的错误重写 ──
check('产物中不存在 xhtml 的 asset URL', !/asset[^"']*\.xhtml/.test(out), undefined);

console.log(allPass ? '\n章节 HTML 重写回归全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
