/**
 * 交付产物最终核对：确认磁盘上的 lib/client.cjs 就是含 UI v2 的那一份。
 * 用文件方式写检查（避免 shell 引号问题）。
 * 用法：node scripts/bundle-feature-check.mjs
 */
import { readFile } from 'node:fs/promises';

const code = await readFile('lib/client.cjs', 'utf8');

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

// UI v2 各视图的类名必须都在产物里
const features = [
  ['书架封面网格', 'dsh-reading-grid'],
  ['书卡（封面按钮）', 'dsh-reading-cardcover'],
  ['生成式封面', 'dsh-reading-gencover'],
  ['分页视口', 'dsh-reading-viewport'],
  ['分页正文流', 'dsh-reading-flow'],
  ['阅读工具条', 'dsh-reading-toolbar'],
  ['版式切换（分段控件）', 'dsh-reading-segmented'],
  ['状态条与进度条', 'dsh-reading-statusbar'],
  ['PDF 双页容器', 'dsh-reading-pdfpages'],
];
for (const [label, token] of features) {
  check(`${label} 已打进产物`, code.includes(token), token);
}

// 锚点编解码：v2 前缀与字段拼接
check('锚点 v2 前缀在产物内', code.includes("'v2'") || code.includes('"v2"'), 'v2');
check('锚点 page= 字段在产物内', code.includes('page='));
check('锚点 chapter= 字段在产物内', code.includes('chapter='));
check('锚点 pct= 字段在产物内', code.includes('pct='));

// 旧的 line: 兼容分支也要保留（老进度可读）
check('旧锚点 line: 兼容分支保留', code.includes('line:'));

// 封面与设置路由（document-relative，不带前导斜杠）
check('封面路由为 document-relative', code.includes('api/reading-workbench/cover'));
check('设置路由为 document-relative', code.includes('api/reading-workbench/settings'));
check('未出现前导斜杠的 API 路径', !code.includes("'/api/reading-workbench"));

// 体积合理性（pdfjs 内联，几 MB 属正常；异常膨胀要警惕）
const sizeMb = code.length / 1024 / 1024;
check('产物体积在合理区间', sizeMb > 1 && sizeMb < 12, `${sizeMb.toFixed(2)} MB`);

console.log(allPass ? '\n产物特性核对全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
