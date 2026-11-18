/**
 * 书内样式收集（Host 半）自测：node scripts/book-styles-selftest.mjs
 *
 * 针对的真实缺陷（2026-10-20 真机首测）：`readdir(..., { recursive: true })` 返回的
 * `Dirent.parentPath` 是**绝对路径**，拼出来的「包内路径」带盘符，
 * 后续 `join(bookDir, 绝对路径)` 读不到文件 —— 表现为 `/styles` 返回 200 但 `css` 为空、
 * `warnings` 里全是「读取失败」，前端静默退化成统一美化。这类缺陷纯靠肉眼看不出来，
 * 所以这里的最关键判据是「files 必须是相对书根的路径」。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { collectBookStyles, MAX_STYLE_FILE_BYTES } = await import('../src/book-styles.ts');

let allPass = true;
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

const root = await mkdtemp(join(tmpdir(), 'dsh-book-styles-'));
try {
  // 造一个典型 EPUB 布局：OEBPS/ 下放章节与样式，另一份根级样式
  await mkdir(join(root, 'OEBPS', 'styles'), { recursive: true });
  await writeFile(join(root, 'OEBPS', 'styles', 'main.css'), '.bold { font-weight: bold; }', 'utf8');
  await writeFile(join(root, 'OEBPS', 'page.css'), '.p { text-indent: 2em; }', 'utf8');
  await writeFile(join(root, 'OEBPS', 'chapter.html'), '<p class="p">正文</p>', 'utf8');
  await writeFile(join(root, 'big.css'), 'x'.repeat(MAX_STYLE_FILE_BYTES + 10), 'utf8');

  const payload = await collectBookStyles(root, 'epub');
  console.log('\n--- 收集结果 ---');
  console.log(JSON.stringify({ files: payload.files, cssLength: payload.css.length, warnings: payload.warnings }, null, 2));
  console.log('--- 结束 ---\n');

  // ── 判据自检（先确认判据本身能分辨）：路径判据必须能识别出绝对路径 ──
  const looksAbsolute = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
  check('自检：判据能把 "C:/x/a.css" 认成绝对路径', looksAbsolute('C:/x/a.css'));
  check('自检：判据不把 "OEBPS/a.css" 认成本绝对路径', !looksAbsolute('OEBPS/a.css'));

  // ── 正向：相对路径 + 内容合并 ──
  check('路径：文件清单非空（否则后面的路径断言形同虚设）', payload.files.length > 0, `实际 ${payload.files.length}`);
  check('路径：全部是相对书根的路径', payload.files.every((file) => !looksAbsolute(file)), payload.files.join(', '));
  check('路径：嵌套目录保留结构', payload.files.includes('OEBPS/styles/main.css'), payload.files.join(', '));
  check('路径：根级文件正确', payload.files.includes('OEBPS/page.css'));
  check('内容：两份样式都被合并', payload.css.includes('font-weight: bold') && payload.css.includes('text-indent: 2em'));
  check('内容：保留来源注释便于排查', payload.css.includes('/* OEBPS/styles/main.css */'));
  check('过滤：超大样式表被跳过并记 warning', payload.warnings.some((w) => w.includes('big.css')), payload.warnings.join(' | '));
  check('过滤：超大表的内容没有混进产物', !payload.css.includes('xxxxxxxxxx'));

  // ── 非 epub：不该去扫目录 ──
  const mobiPayload = await collectBookStyles(root, 'mobi');
  check('非 epub 返回空清单', mobiPayload.css === '' && mobiPayload.files.length === 0 && mobiPayload.warnings.length === 0);

  // ── 目录不存在：静默空结果（不是异常） ──
  const missing = await collectBookStyles(join(root, 'no-such-dir'), 'epub');
  check('目录不存在时返回空结果而非抛错', missing.css === '' && missing.files.length === 0);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(allPass ? '\n书内样式收集自测全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
