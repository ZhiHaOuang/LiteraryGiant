/**
 * 章节切分修正（chapterSplit = 2）自测：纯标题页并入下一章 + 文件名标题回退。
 *
 * 背景（实测）：EPUB 的 spine 是文件清单，不是逻辑章节。《情绪流龙头战法》里
 * 「第一章 股市的起源和本质」是一个 12 字的纯标题文件，正文在下一个文件
 * （`chapter007`，实为「第一节 股市的起源」）。旧实现按文件切章，用户点「第一章」
 * 只看到一行标题，翻一页就到第二节，观感是「这章没读完就进下一章」。
 *
 * 判据都带**反证**：同一份数据走旧逻辑（不做 splitChapters）必须不满足新断言，
 * 否则断言可能永远为真、形同虚设。
 *
 * 用法：node scripts/chapter-split-selftest.mjs
 */
import { bodyOfHtml, isTitleOnlyPage, splitChapters, titleFromBody } from '../src/epub.ts';

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

/** 构造章节 HTML（body 内容 + 可选 head）。 */
function page(body, head = '<head><meta charset="utf-8"></head>') {
  return `<!DOCTYPE html><html><head>${head.replace(/<\/?head>/g, '')}</head><body>\n${body}\n</body></html>`;
}

// ── 1) 纯标题页判定 ────────────────────────────────────────────────────────
const titlePage = page('<h3 class="num">第一章</h3><h3 class="name">股市的起源和本质</h3>');
const titlePageBody = bodyOfHtml(titlePage);
check('标题页（只有 h3 标题）判为纯标题页', isTitleOnlyPage(titlePageBody) === true);
check(
  '正文页（含长段落）不判为标题页',
  isTitleOnlyPage(bodyOfHtml(page('<p>股票是商品经济及生产力发展的产物。'.repeat(8) + '</p>'))) === false,
);
check('封面页（无文字）不判为标题页', isTitleOnlyPage('<img src="cover.jpg" />') === false);

// ── 2) 标题回退 ───────────────────────────────────────────────────────────
const sectionBody = bodyOfHtml(
  page('<div><h3 class="num">第一节</h3><h3 class="name">股市的起源</h3></div><h4>1. 16世纪</h4><p>正文</p>'),
);
check('文件名式章节从 h1~h6 提取标题', titleFromBody(sectionBody) === '第一节 股市的起源', `实际 ${titleFromBody(sectionBody)}`);

// ── 3) 合并 + 标题回退（模拟《情绪流龙头战法》结构）────────────────────────
const manifest = {
  title: '测试书',
  chapters: [
    { index: 0, title: 'cover', href: 'OEBPS/Text/cover.xhtml' },
    { index: 1, title: '第一章 股市的起源和本质', href: 'OEBPS/Text/chapter006.xhtml' },
    { index: 2, title: 'chapter007', href: 'OEBPS/Text/chapter007.xhtml' },
    { index: 3, title: '第二节 股市的本质', href: 'OEBPS/Text/chapter008.xhtml' },
  ],
};
const htmlByHref = {
  'OEBPS/Text/cover.xhtml': page('<img src="../Images/cover.jpg" />'),
  'OEBPS/Text/chapter006.xhtml': titlePage,
  'OEBPS/Text/chapter007.xhtml': page(
    '<div><h3>第一节</h3><h3>股市的起源</h3></div><p class="bodytext">' + '正文内容很长。'.repeat(60) + '</p>',
  ),
  'OEBPS/Text/chapter008.xhtml': page('<p class="bodytext">' + '第二节正文。'.repeat(60) + '</p>'),
};
const split = splitChapters(manifest, (href) => htmlByHref[href] ?? '');
const byIndex = new Map(split.chapters.map((chapter) => [chapter.index, chapter]));

check('标题页被标记 skip', byIndex.get(1)?.skip === true);
check('正文页不标 skip', byIndex.get(2)?.skip === undefined);
check('封面不标 skip', byIndex.get(0)?.skip === undefined);
check(
  '正文页 href 改指合并文件（同目录）',
  byIndex.get(2)?.href === 'OEBPS/Text/chapter007.merged.xhtml',
  `实际 ${byIndex.get(2)?.href}`,
);
check(
  '文件名标题回退为真实标题',
  byIndex.get(2)?.title === '第一节 股市的起源',
  `实际 ${byIndex.get(2)?.title}`,
);
check('已有正常标题不被改写', byIndex.get(3)?.title === '第二节 股市的本质');
check('合并文件恰好一个', split.writes.length === 1, `实际 ${split.writes.length}`);
const mergedHtml = split.writes[0]?.html ?? '';
check('合并文件包含标题页正文', mergedHtml.includes('股市的起源和本质'));
check('合并文件保留本章正文', mergedHtml.includes('正文内容很长'));
check('合并文件保留原 head', mergedHtml.includes('<meta charset="utf-8">'));
check('index 与数组下标保持一一对应（旧进度/划线锚点不错位）', split.chapters.every((chapter, index) => chapter.index === index));

// 反证：同一份数据不做 splitChapters 时，上面这些断言都不成立
const naive = manifest.chapters.map((chapter) => ({ ...chapter }));
check(
  '反证：旧逻辑不标 skip（说明断言有鉴别力）',
  naive.every((chapter) => chapter.skip === undefined),
);
check('反证：旧逻辑的标题仍是文件名 chapter007', naive[2]?.title === 'chapter007');

// ── 4) 连续标题页 + 末尾标题页 ─────────────────────────────────────────────
const chain = splitChapters(
  {
    chapters: [
      { index: 0, title: '第一部分 股市之我见', href: 'a.xhtml' },
      { index: 1, title: '第一章', href: 'b.xhtml' },
      { index: 2, title: '正文', href: 'c.xhtml' },
      { index: 3, title: '附录页', href: 'd.xhtml' },
    ],
  },
  (href) =>
    ({
      'a.xhtml': page('<h2>第一部分 股市之我见</h2>'),
      'b.xhtml': page('<h3>第一章</h3>'),
      'c.xhtml': page('<p>' + '正文。'.repeat(80) + '</p>'),
      'd.xhtml': page('<h2>附录页</h2>'),
    })[href] ?? '',
);
check('连续标题页都被标记 skip', chain.chapters[0]?.skip === true && chain.chapters[1]?.skip === true);
check('连续标题页内容按序并入下一章', (chain.writes[0]?.html ?? '').includes('第一部分 股市之我见') && (chain.writes[0]?.html ?? '').includes('第一章'));
check('末尾标题页不标 skip（没有下一章可并，保持可达）', chain.chapters[3]?.skip !== true);
check('末尾标题页不产生合并写入', chain.writes.length === 1, `实际 ${chain.writes.length}`);

console.log(allPass ? '\n章节切分自测通过' : '\n章节切分自测失败');
process.exit(allPass ? 0 : 1);
