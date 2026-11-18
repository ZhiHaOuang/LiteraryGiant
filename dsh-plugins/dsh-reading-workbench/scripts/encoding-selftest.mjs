/**
 * 文本编码判定与 txt 虚拟单元切分自测（不依赖 DSH、不碰真实书库）。
 *
 * 覆盖 2026-10-19 乱码事故的判据：
 * 1. GBK/GB2312 老文件必须被正确解码（而不是解出 U+FFFD）；
 * 2. 解码一律严格模式 —— 解不出来就报错，绝不静默产出替换符；
 * 3. 已损坏的历史副本必须被 `inspectReplacementDamage` 识别；
 * 4. txt 虚拟单元切分的偏移契约（units 拼接 === 原文、start/end 连续）。
 *
 * 用法：node scripts/encoding-selftest.mjs
 */
import { decodeTextBytes, inspectReplacementDamage, TextDecodeError } from '../src/shared/text-encoding.ts';
import { splitTextUnits, toUnitRange, unitIndexOfOffset, MIN_UNIT_CHARS } from '../src/client/txt-units.ts';

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

const encoder = new TextEncoder();
/** 这串 GBK 字节（取自真实文件头部）对应的正确中文。 */
const GBK_SAMPLE = '　　【蓝天航空公司的淫荡空姐】';
// 「　　【蓝天航空公司的空姐】」的 GBK 字节（取自真实文件的头部）
const GBK_BYTES = new Uint8Array([
  0xa1, 0xa1, 0xa1, 0xa1, 0xa1, 0xbe, 0xc0, 0xb6, 0xcc, 0xec, 0xba, 0xbd, 0xbf, 0xd5,
  0xb9, 0xab, 0xcb, 0xbe, 0xb5, 0xc4, 0xd2, 0xf9, 0xb5, 0xb4, 0xbf, 0xd5, 0xbd, 0xe3,
  0xa1, 0xbf,
]);

// ── 1. 解码：BOM 族 ──
console.log('== 编码判定 ==');
{
  const bytes = encoder.encode('中文 UTF-8');
  const decoded = decodeTextBytes(bytes);
  check('无 BOM 的 UTF-8 正确解码', decoded.text === '中文 UTF-8' && decoded.encoding === 'utf-8', `encoding=${decoded.encoding}`);
}
{
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('带 BOM 的 UTF-8')]);
  const decoded = decodeTextBytes(bytes);
  check('UTF-8 BOM 被剥离并识别', decoded.text === '带 BOM 的 UTF-8' && decoded.hadBom === true, `hadBom=${decoded.hadBom}`);
}
{
  const bytes = new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]); // UTF-16LE 的「中文」
  const decoded = decodeTextBytes(bytes);
  check('UTF-16LE BOM 正确解码', decoded.text === '中文' && decoded.encoding === 'utf-16le', `text=${decoded.text}`);
}
{
  const bytes = new Uint8Array([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87]); // UTF-16BE 的「中文」
  const decoded = decodeTextBytes(bytes);
  check('UTF-16BE BOM 正确解码', decoded.text === '中文' && decoded.encoding === 'utf-16be', `text=${decoded.text}`);
}

// ── 2. 解码：GBK 老文件（事故本体） ──
{
  const decoded = decodeTextBytes(GBK_BYTES);
  check('GBK 字节被识别为 gb18030', decoded.encoding === 'gb18030', `encoding=${decoded.encoding}`);
  check('GBK 解码结果无替换符', !decoded.text.includes('\uFFFD') && decoded.text === GBK_SAMPLE, JSON.stringify(decoded.text));
}
{
  // 反证：同样的字节用 UTF-8 宽松解码会产出大量 U+FFFD（旧实现的症状）
  const loose = new TextDecoder('utf-8').decode(GBK_BYTES);
  const damage = inspectReplacementDamage(loose);
  check('反证：旧写法（UTF-8 宽松）会产出替换符', damage.count > 0, `count=${damage.count}`);
}

// ── 3. 严格模式：解不出来必须报错，不许降级 ──
{
  let threw = false;
  try {
    decodeTextBytes(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  } catch (error) {
    threw = error instanceof TextDecodeError;
  }
  check('非 UTF-8 且非 GB18030 的字节显式抛错', threw, `TextDecodeError=${threw}`);
}
{
  const ascii = decodeTextBytes(encoder.encode('plain ascii'));
  check('纯 ASCII 走 UTF-8 分支', ascii.encoding === 'utf-8' && ascii.text === 'plain ascii');
}
{
  const empty = decodeTextBytes(new Uint8Array(0));
  check('空字节返回空文本', empty.text === '' && empty.encoding === 'utf-8');
}

// ── 4. 损坏检测闸门 ──
console.log('\n== 损坏检测 ==');
{
  const clean = inspectReplacementDamage('正常的正文，没有任何替换符。');
  check('干净文本不判定为损坏', clean.damaged === false && clean.count === 0);
}
{
  const broken = '正常开头' + '\uFFFD'.repeat(50) + '正常结尾';
  const damage = inspectReplacementDamage(broken);
  check('大量替换符判定为损坏', damage.damaged === true, `count=${damage.count} ratio=${damage.ratio.toFixed(3)}`);
}
{
  // 单个替换符不足以判定（可能是正文里真的引用了这个字符）
  const single = inspectReplacementDamage('正文里有一个 \uFFFD 而已');
  check('个别替换符不误报', single.damaged === false, `count=${single.count}`);
}

// ── 5. txt 虚拟单元切分 ──
console.log('\n== txt 虚拟单元切分 ==');
{
  check('空文本切出 0 个单元', splitTextUnits('').length === 0);
}
{
  const short = '很短的一本书。\n只有两行。\n';
  const units = splitTextUnits(short);
  check('短文本只有 1 个单元（行为与旧实现一致）', units.length === 1 && units[0].text === short, `units=${units.length}`);
}
{
  // 章节标记切分：标记行后接足够长的正文
  const text = `第一章 开始\n${'字'.repeat(MIN_UNIT_CHARS + 500)}\n第二章 继续\n${'词'.repeat(500)}\n`;
  const units = splitTextUnits(text);
  check('按章节标记切成 2 个单元', units.length === 2, `units=${units.length}`);
  check('单元标题取自标记行', units[0]?.title === '第一章 开始' && units[1]?.title === '第二章 继续', units.map((u) => u.title).join(' / '));
}
{
  // 偏移契约：拼接必须等于原文，区间必须连续
  const text = `第一章 开始\n${'字'.repeat(5000)}\n第二章 继续\n${'词'.repeat(5000)}\n第三章 收尾\n${'句'.repeat(5000)}\n`;
  const units = splitTextUnits(text, 3000);
  const joined = units.map((unit) => unit.text).join('');
  check('单元拼接 === 原文', joined === text, `len=${joined.length}/${text.length}`);
  let contiguous = true;
  for (let index = 0; index < units.length; index += 1) {
    if (units[index].start !== (index === 0 ? 0 : units[index - 1].end)) contiguous = false;
    if (units[index].text !== text.slice(units[index].start, units[index].end)) contiguous = false;
  }
  check('unit.text === text.slice(start, end) 且区间连续', contiguous, `units=${units.length}`);
}
{
  // 无标记的长文本按字数上限切
  const text = '甲'.repeat(25_000);
  const units = splitTextUnits(text, 10_000);
  check('无标记长文按上限切分', units.length >= 3, `units=${units.length}`);
  check('切点均在行边界（单行无换行时仍完整覆盖）', units.map((u) => u.text).join('') === text);
}

// ── 6. 单元区间换算（划线锚点用全书偏移，渲染用单元内偏移） ──
console.log('\n== 单元内/全书偏移换算 ==');
{
  const unit = { start: 1000, end: 2000 };
  check('完全在单元内', JSON.stringify(toUnitRange(unit, 1200, 50)) === JSON.stringify({ offset: 200, length: 50 }));
  check('跨左边界被截断', JSON.stringify(toUnitRange(unit, 950, 100)) === JSON.stringify({ offset: 0, length: 50 }));
  check('完全在单元外返回 undefined', toUnitRange(unit, 5000, 100) === undefined);
  check('刚好贴右边界返回 undefined', toUnitRange(unit, 2000, 10) === undefined);
}
{
  const text = `${'甲'.repeat(5000)}\n${'乙'.repeat(5000)}\n`;
  const units = splitTextUnits(text, 3000);
  check('偏移定位到首个单元', unitIndexOfOffset(units, 100) === 0, `units=${units.length}`);
  check('偏移定位到末尾单元', unitIndexOfOffset(units, text.length - 1) === units.length - 1);
  check('空单元列表回落 0', unitIndexOfOffset([], 999) === 0);
}

console.log(allPass ? '\n编码与切分自测全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
