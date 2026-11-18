/**
 * 分页与锚点自测（纯函数，不依赖 DOM / DSH）。
 * 覆盖 UI v2 的两种翻页模型与进度恢复语义。
 *
 * 直接加载 TS 源码：本机 node 24 自带类型擦除（type stripping），
 * 源文件里只有 `import type` 与类型注解，无需先构建。
 * 用法：node scripts/paginate-selftest.mjs
 */
import {
  COLUMN_GAP,
  MIN_COLUMN_WIDTH,
  clampView,
  columnCountOf,
  columnWidthOf,
  makePagination,
  percentOfView,
  resolveColumns,
  restoreView,
  screenWidthOf,
  stepOf,
  viewCountOf,
  viewOffset,
  viewOfPercent,
} from '../src/client/paginate.ts';
import {
  encodeAnchor,
  overallPercent,
  pagePercent,
  parseAnchor,
  restorePage,
} from '../src/shared/anchor.ts';

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

// ── 1) 单页 / 双页判定 ────────────────────────────────────
check('窄屏 auto 解析为单页', resolveColumns('auto', 700) === 1, `宽度 700 → ${resolveColumns('auto', 700)}`);
const wideEnough = MIN_COLUMN_WIDTH * 2 + COLUMN_GAP + 64;
check('宽屏 auto 解析为双页', resolveColumns('auto', wideEnough) === 2, `宽度 ${wideEnough} → ${resolveColumns('auto', wideEnough)}`);
check('显式单页不受宽度影响', resolveColumns(1, 2000) === 1);
check('显式双页不受宽度影响', resolveColumns(2, 400) === 2);

// ── 2) 列宽与列数 ────────────────────────────────────────
const oneWidth = columnWidthOf(1000, 1);
const twoWidth = columnWidthOf(1000, 2);
check('单页列宽大于双页列宽', oneWidth > twoWidth, `${oneWidth.toFixed(1)} vs ${twoWidth.toFixed(1)}`);
check('双页两列加间距等于可用宽度', Math.abs(twoWidth * 2 + COLUMN_GAP - oneWidth) < 0.001, `${(twoWidth * 2 + COLUMN_GAP).toFixed(1)} vs ${oneWidth.toFixed(1)}`);
// CSS 多栏 N 列时 scrollWidth = N*列宽 + (N-1)*间距
const scrollWidthOfColumns = (n, width) => n * width + (n - 1) * COLUMN_GAP;
check(
  '列数由 scrollWidth 反推（2 列）',
  columnCountOf(scrollWidthOfColumns(2, 1000), 1000, COLUMN_GAP) === 2,
  `scrollWidth=${scrollWidthOfColumns(2, 1000)} → ${columnCountOf(scrollWidthOfColumns(2, 1000), 1000, COLUMN_GAP)}`,
);
check(
  '列数由 scrollWidth 反推（7 列）',
  columnCountOf(scrollWidthOfColumns(7, 640), 640, COLUMN_GAP) === 7,
  `→ ${columnCountOf(scrollWidthOfColumns(7, 640), 640, COLUMN_GAP)}`,
);

// ── 3) 屏数 ──────────────────────────────────────────────
check('单页：5 列 = 5 屏', viewCountOf(5, 1) === 5);
check('双页：5 列 = 3 屏（末屏半空）', viewCountOf(5, 2) === 3, `→ ${viewCountOf(5, 2)}`);
check('双页：4 列 = 2 屏', viewCountOf(4, 2) === 2);
check('至少一屏', viewCountOf(0, 1) === 1 && viewCountOf(1, 2) === 1);

// ── 3b) 「一屏可见宽度」与「翻页步长」必须分开（回归：翻页不准确的真凶）──
// 一屏右边界止于末列右缘；下一屏首列从「末列右缘 + 一个列间距」起步 —— 二者相差一个 gap。
// 曾经混用这两个量：每翻一屏累积偏移 48px，表现为左侧露白、右侧正文被切。
for (const colsPerView of [1, 2]) {
  const width = columnWidthOf(1000, colsPerView);
  const screen = screenWidthOf(width, colsPerView);
  const step = stepOf(width, colsPerView);
  check(`每屏可见宽度 = 可见列宽 + 列间空白（${colsPerView} 栏）`, Math.abs(screen - (width * colsPerView + COLUMN_GAP * (colsPerView - 1))) < 0.001, `screen=${screen}`);
  check(`翻页步长 = 可见列数 × 列步进（${colsPerView} 栏）`, Math.abs(step - colsPerView * (width + COLUMN_GAP)) < 0.001, `step=${step}`);
  check(`二者相差恰好一个列间距（${colsPerView} 栏）`, Math.abs(step - screen - COLUMN_GAP) < 0.001, `step-screen=${step - screen}`);
  check(`翻页位移必须用步长而非可见宽度（${colsPerView} 栏）`, step !== screen, `step=${step} screen=${screen}`);
}
check('单页每屏位移 = 列宽 + 间距（而非仅列宽）', viewOffset(1, makePagination(1000, 99999, 1)) === stepOf(columnWidthOf(1000, 1), 1), `offset=${viewOffset(1, makePagination(1000, 99999, 1))}`);
check(
  '双页每屏位移 = 2 × (列宽 + 间距)',
  viewOffset(1, makePagination(1000, 99999, 2)) === stepOf(columnWidthOf(1000, 2), 2),
  `offset=${viewOffset(1, makePagination(1000, 99999, 2))}`,
);
// 关键不变式：位移必须是「列步进」的整数倍（否则落不到列边界上）
for (const colsPerView of [1, 2]) {
  const pag = makePagination(1000, 99999, colsPerView);
  const stride = pag.columnWidth + pag.gap;
  let allInteger = true;
  for (let v = 0; v < 8; v += 1) {
    const ratio = viewOffset(v, pag) / stride;
    if (Math.abs(ratio - Math.round(ratio)) > 1e-6) allInteger = false;
  }
  check(`任意屏的位移都是列步进的整数倍（${colsPerView} 栏）`, allInteger, `stride=${stride}`);
}

// ── 4) 屏号与位移 ────────────────────────────────────────
const pagination = makePagination(1000, 3000, 1);
check('分页结果字段齐全', pagination.viewCount >= 1 && pagination.columnWidth > 0 && pagination.columnsPerView === 1);
check('第 0 屏位移为 0', viewOffset(0, pagination) === 0);
check('第 2 屏位移 = 2 屏宽', viewOffset(2, pagination) === 2 * (pagination.columnWidth + pagination.gap), `${viewOffset(2, pagination).toFixed(1)}`);
const doublePagination = makePagination(1200, 6000, 2);
check('双页位移按两列步进', viewOffset(1, doublePagination) === 1 * 2 * (doublePagination.columnWidth + doublePagination.gap), `${viewOffset(1, doublePagination).toFixed(1)}`);

// ── 5) clamp 与百分比换算 ────────────────────────────────
check('负屏号收敛到 0', clampView(-3, 5) === 0);
check('超界屏号收敛到末屏', clampView(99, 5) === 4);
check('非数字屏号收敛到 0', clampView(Number.NaN, 5) === 0);
check('首页百分比为 0', percentOfView(0, 5) === 0);
check('末页百分比为 100', percentOfView(4, 5) === 100);
check('单屏时百分比为 100', percentOfView(0, 1) === 100);
check('50% 换算回中间屏', viewOfPercent(50, 5) === 2, `→ ${viewOfPercent(50, 5)}`);
check('100% 换算到末屏', viewOfPercent(100, 5) === 4);
check('百分比往返一致', viewOfPercent(percentOfView(3, 8), 8) === 3);

// ── 6) 进度恢复：页码优先，越界回落百分比 ────────────────
check('同一视口：直接用页码', restoreView(3, 100, 5) === 3, `→ ${restoreView(3, 100, 5)}`);
// 3 屏时百分比映射到 0..2：60% → round(0.6*2)=1
check('换视口页数变少：按百分比回落', restoreView(20, 60, 3) === 1, `→ ${restoreView(20, 60, 3)}`);
check('无进度：回首页', restoreView(0, 0, 10) === 0);
// 4 屏时 100% → round(1*3)=3，即末屏
check('末页锚点在更少页数下仍到末页', restoreView(9, 100, 4) === 3, `→ ${restoreView(9, 100, 4)}`);
check('页码合法时忽略百分比', restoreView(2, 90, 6) === 2, `→ ${restoreView(2, 90, 6)}`);

// ── 7) 锚点序列化 ────────────────────────────────────────
const epubAnchor = encodeAnchor({ chapter: 3, page: 2, pct: 41.53 });
check('章节书锚点格式', epubAnchor === 'v2;chapter=3;page=2;pct=41.5', epubAnchor);
const parsed = parseAnchor(epubAnchor);
check('锚点往返：章节', parsed?.chapter === 3 && parsed?.page === 2 && Math.abs(parsed.pct - 41.5) < 0.01, JSON.stringify(parsed));
const textAnchor = parseAnchor(encodeAnchor({ page: 7, pct: 58.2 }));
check('文本锚点不含 chapter 字段', textAnchor?.chapter === undefined && textAnchor?.page === 7, JSON.stringify(textAnchor));

// ── 8) 旧数据兼容 ────────────────────────────────────────
check('旧 chapter: 锚点可解析', parseAnchor('chapter:5')?.chapter === 5);
check('旧 page: 锚点按 0 起换算', parseAnchor('page:7')?.page === 6, JSON.stringify(parseAnchor('page:7')));
check('旧 line: 锚点降级为首页', parseAnchor('line:120')?.page === 0);
check('无法识别返回 undefined', parseAnchor('garbage') === undefined);
check('空值返回 undefined', parseAnchor(undefined) === undefined && parseAnchor('') === undefined);

// 两个恢复入口必须刻度一致（历史上 anchor.restorePage 曾用 *pageCount，
// 与 paginate.viewOfPercent 的 *(count-1) 不一致 —— 这里钉住）
let restoreConsistent = true;
for (let count = 2; count <= 12; count += 1) {
  for (const pct of [0, 25, 50, 75, 100]) {
    const anchor = { page: 999, pct };
    if (restorePage(anchor, count) !== restoreView(999, pct, count)) {
      restoreConsistent = false;
      console.log(`    不一致：count=${count} pct=${pct} restorePage=${restorePage(anchor, count)} restoreView=${restoreView(999, pct, count)}`);
    }
  }
}
check('页数与屏数两套恢复刻度一致', restoreConsistent);

// ── 9) 全书百分比 ────────────────────────────────────────
check('10 章的第 5 章中间 ≈ 45%', Math.abs(overallPercent({ chapter: 4, page: 0, pct: 50 }, 10) - 45) < 0.01, `${overallPercent({ chapter: 4, page: 0, pct: 50 }, 10)}`);
check('单章书直接用章内百分比', overallPercent({ page: 0, pct: 70 }, 1) === 70);
check('末章末页 = 100%', overallPercent({ chapter: 9, page: 0, pct: 100 }, 10) === 100);
check('章内百分比辅助函数', pagePercent(0, 11) === 0 && Math.abs(pagePercent(5, 11) - 50) < 0.01);

console.log(allPass ? '\n分页与锚点自测全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
