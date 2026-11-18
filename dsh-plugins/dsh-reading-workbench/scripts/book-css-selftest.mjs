/**
 * 书内 CSS 作用域化自测：node scripts/book-css-selftest.mjs
 *
 * 判据分三层，缺一不可：
 * 1. **正向**：书内层次（font-weight / text-indent / 相对字号）必须被产出；
 * 2. **反向（关键）**：布局类属性（width/height/position/display:none/line-height/color…）
 *    必须被丢弃，且 `@font-face` / `@media print` 不得出现；
 * 3. **判据自检**：先断言「过滤函数对已知应保留/应丢弃的样本给出对应结论」，
 *    否则上面的反向断言可能永远为真（例如函数整体抛错被吞掉，输出恒空，全部反向断言都"通过"）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const {
  scopeBookCss,
  scopeSelector,
  filterDeclaration,
  splitCssRules,
  splitTopLevel,
} = await import('../src/client/book-css.ts');

let allPass = true;
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

const SCOPE = '.dsh-reading-flow';
const OPTS = { scope: SCOPE, dropFontFamily: false };

// ── 0. 判据自检：过滤函数本身必须能区分「该留」与「该丢」 ──
check('自检：text-indent 判定为保留', filterDeclaration('text-indent: 2em', OPTS) !== undefined);
check('自检：height 判定为丢弃', filterDeclaration('height: 587px', OPTS) === undefined);
check('自检：font-size:1.125em 保留', filterDeclaration('font-size: 1.125em', OPTS) !== undefined);
check('自检：font-size:18px 丢弃', filterDeclaration('font-size: 18px', OPTS) === undefined);
check('自检：空值丢弃', filterDeclaration('font-weight:', OPTS) === undefined);
check('自检：无冒号丢弃', filterDeclaration('garbage', OPTS) === undefined);

// ── 1. 解析器骨架：注释 / 字符串 / 嵌套不破坏切分 ──
const tricky = `
/* 顶部注释 { } */
.a { content: "}"; color: red }
.b::before { content: '{'; }
@media screen and (max-width: 600px) {
  .c { text-indent: 1em }
}
@font-face { font-family: "X"; src: url(x.ttf) }
@import url(other.css);
.q { font-weight: bold }
`;
const rules = splitCssRules(tricky);
check('解析：切出 6 条顶层规则', rules.length === 6, `实际 ${rules.length}`);
check(
  '解析：字符串里的 } 不影响配对',
  rules[0]?.prelude === '.a' && rules[0]?.body?.includes('content: "}"'),
);
check('解析：@import 是无 body 的语句', rules.some((r) => r.prelude.startsWith('@import') && r.body === undefined));
check('解析：选择器列表按逗号切分', splitTopLevel('a, b:not(.c, .d), e', ',').length === 3);

// ── 2. 选择器作用域化 ──
check('作用域：.bold → .dsh-reading-flow .bold', scopeSelector('.bold', SCOPE) === `${SCOPE} .bold`);
check('作用域：后代选择器保留结构', scopeSelector('div p', SCOPE) === `${SCOPE} div p`);
check('作用域：子代组合符保留', scopeSelector('ul > li', SCOPE) === `${SCOPE} ul > li`);
check('作用域：html/body/:root 整条丢弃', scopeSelector('body', SCOPE) === undefined);
check('作用域：body.calibre1 整条丢弃', scopeSelector('body.calibre1', SCOPE) === undefined);
check('作用域：body p 剥掉根段', scopeSelector('body p', SCOPE) === `${SCOPE} p`);

// ── 3. 端到端：典型 calibre 书内 CSS ──
const calibreCss = `
.bold { font-weight: bold; line-height: 1.4; }
.calibre_1 { display: block; text-align: center; text-indent: 0; margin: 1em 0; }
.calibre_2 { text-align: justify; text-indent: 2em; margin: 1em 0; line-height: 1.4; }
.calibre_5 { display: block; text-indent: 2em; margin: 2em 0 0 2em; }
.calibre_9 { height: 587px; width: 939px; line-height: 1.4; vertical-align: baseline; }
.calibre1 { display: block; font-size: 1em; padding-left: 0; padding-right: 0; text-align: justify; margin: 0 5pt; }
.calibre2 { font-size: 1.25em; line-height: 1.4; }
.calibre6 { font-size: 0.75em; vertical-align: super; }
body.calibre1 { display: block; font-size: 1em; line-height: 1.4; margin: 0 5pt; }
@page { margin: 0.5in; }
`;
const scoped = scopeBookCss(calibreCss, OPTS);
console.log('\n--- 作用域化产物 ---');
console.log(scoped);
console.log('--- 产物结束 ---\n');

check('端到端：标题字重被保留', scoped.includes('.dsh-reading-flow .bold') && scoped.includes('font-weight: bold'));
check('端到端：正文首行缩进被保留', scoped.includes('text-indent: 2em'));
check('端到端：标题居中保留', scoped.includes('text-align: center'));
check('端到端：相对字号保留（.calibre2）', /\.dsh-reading-flow \.calibre2 \{ font-size: 1\.25em; \}/.test(scoped));
check('端到端：固定宽高被丢弃', !/height\s*:/.test(scoped) && !/width\s*:/.test(scoped));
check('端到端：line-height 被丢弃（用户行距不被覆盖）', !/line-height\s*:/.test(scoped));
check('端到端：body 选择器规则被丢弃', !/body/.test(scoped));
check('端到端：@page 被丢弃', !/@page/.test(scoped));
check('端到端：产物非空（否则反向断言形同虚设）', scoped.length > 100, `长度 ${scoped.length}`);

// ── 4. 字体策略 ──
const fontCss = '.x { font-family: "Source Han Serif"; font-weight: 600 }';
check(
  '字体：dropFontFamily=false 时保留',
  scopeBookCss(fontCss, { scope: SCOPE, dropFontFamily: false }).includes('font-family'),
);
check(
  '字体：dropFontFamily=true 时丢弃（用户设置优先）',
  !scopeBookCss(fontCss, { scope: SCOPE, dropFontFamily: true }).includes('font-family'),
);

// ── 5. 危险属性全量排查（含 display:none / position / float / column / break） ──
const danger = `
.d1 { display: none }
.d2 { position: absolute; top: 0; left: 0 }
.d3 { float: left; width: 50% }
.d4 { column-count: 2; break-inside: avoid }
.d5 { color: #000; background-color: #fff }
.d6 { overflow: hidden; transform: scale(2) }
.d7 { visibility: hidden; opacity: 0 }
`;
const dangerOut = scopeBookCss(danger, OPTS);
check('危险：display:none 被丢弃', !/display\s*:\s*none/i.test(dangerOut), dangerOut);
check('危险：position/top/left 被丢弃', !/position|top\s*:|left\s*:/i.test(dangerOut));
check('危险：float/width 被丢弃', !/float|width/i.test(dangerOut));
check('危险：column/break 被丢弃', !/column|break-/i.test(dangerOut));
check('危险：color/background 被丢弃', !/color\s*:/i.test(dangerOut));
check('危险：overflow/transform 被丢弃', !/overflow|transform/i.test(dangerOut));
check('危险：visibility/opacity 被丢弃', !/visibility|opacity/i.test(dangerOut));

// ── 6. 真实书库回归（存在则跑，不存在跳过） ──
const libraryDir = join(homedir(), '.dsh', 'reading-workbench', 'library');
const realBook = '0a7bec43-ff87-4eb3-9796-94d58b1bd8bd';
const realCss = join(libraryDir, realBook, 'stylesheet.css');
if (existsSync(realCss)) {
  const css = readFileSync(realCss, 'utf8');
  const out = scopeBookCss(css, OPTS);
  const lines = out.split('\n').filter((line) => line.trim() !== '').length;
  check('真实书：产出规则数 > 10', lines > 10, `实际 ${lines}`);
  check(
    '真实书：正文段落规则（.calibre_2 首行缩进）保留',
    out.includes('.dsh-reading-flow .calibre_2') && out.includes('text-indent: 2em'),
  );
  // 「文字全都一样」的直接解药：标题在书里是 <p class="calibre_1"><span class="calibre5"><span class="bold">，
  // 这三条规则缺任何一条，标题就退化回普通段落。
  check('真实书：标题居中规则（.calibre_1）保留', /\.dsh-reading-flow \.calibre_1 \{[^}]*text-align: center/.test(out));
  check('真实书：标题字号规则（.calibre5 族，1.125em 量级）保留', /\.dsh-reading-flow \.calibre5? \{[^}]*font-size: 1\.125em/.test(out) || /font-size: 1\.125em/.test(out));
  check('真实书：粗体规则（.bold）保留', /\.dsh-reading-flow \.bold \{[^}]*font-weight: bold/.test(out));
  check('真实书：固定宽高被清掉', !/(?:^|[^-])width\s*:/.test(out) && !/(?:^|[^-])height\s*:/.test(out));
  check('真实书：所有选择器都在作用域内', out
    .split('}')
    .filter((block) => block.includes('{'))
    .every((block) => block.split('{')[0].split(',').every((sel) => sel.trim() === '' || sel.includes(SCOPE) || sel.includes('@'))));
} else {
  console.log(`SKIP  真实书回归（未找到 ${realCss}）`);
}

console.log(allPass ? '\n书内 CSS 作用域化全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
