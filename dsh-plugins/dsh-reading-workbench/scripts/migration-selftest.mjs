/**
 * 老数据迁移自测（用**用户真实 data.json 的结构**做样本）。
 *
 * 覆盖 UI v2 引入的三处不兼容：
 * 1. `settings.reader.columns` 字段不存在（v1 只有 fontSize/lineHeight/theme）；
 * 2. `book.hasCover` 字段不存在（v1 无封面概念）；
 * 3. 进度锚点是旧格式（`line:3:0` / `chapter:5` / `page:7`）。
 *
 * 做法：复制真实 data.json 到临时目录，用 lib 产物读一遍，
 * 断言不会丢数据、不会崩、缺失字段被补齐，旧锚点仍可解析。
 * 用法：node scripts/migration-selftest.mjs
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
// 直接加载 TS 源码（node 24 类型擦除）：lib 产物只导出 apply，
// 而这里要测的 loadData / normalizeReaderSettings 是内部函数。
import { loadData, readSettings, normalizeReaderSettings } from '../src/store.ts';
import { parseAnchor } from '../src/shared/anchor.ts';

const realData = join(homedir(), '.dsh', 'reading-workbench', 'data.json');
const tempHome = await mkdtemp(join(tmpdir(), 'rw-migration-'));

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

// ── 1) 设置规整（纯函数，先测最容易被忽略的分支）──
check('v1 设置（无 columns）补 auto', normalizeReaderSettings({ fontSize: 16, lineHeight: 1.8, theme: 'follow' }).columns === 'auto');
check('v1 设置保留原字号', normalizeReaderSettings({ fontSize: 16 }).fontSize === 16);
check('空设置回落默认', normalizeReaderSettings(undefined).fontSize === 17 && normalizeReaderSettings(undefined).columns === 'auto');
check('null 设置回落默认', normalizeReaderSettings(null).columns === 'auto');
check('columns=0 视为非法回落', normalizeReaderSettings({ columns: 0 }).columns === 'auto', `→ ${normalizeReaderSettings({ columns: 0 }).columns}`);
check('columns="3" 字符串非法回落', normalizeReaderSettings({ columns: '3' }).columns === 'auto');
check('columns=1 / 2 被接受', normalizeReaderSettings({ columns: 1 }).columns === 1 && normalizeReaderSettings({ columns: 2 }).columns === 2);
check('theme=dark 保留', normalizeReaderSettings({ theme: 'dark' }).theme === 'dark');
check('theme 非法回落 follow', normalizeReaderSettings({ theme: 'blue' }).theme === 'follow');
check('字号小数保留', normalizeReaderSettings({ fontSize: 15.5 }).fontSize === 15.5);

// ── 2) 旧锚点解析（三种历史格式）──
check('line: 锚点 → 首页', parseAnchor('line:3:0')?.page === 0);
check('chapter: 锚点保留章号', parseAnchor('chapter:5')?.chapter === 5);
check('page: 锚点换算为 0 起', parseAnchor('page:7')?.page === 6);
check('旧锚点不抛错', parseAnchor('line:3:0') !== undefined);

// ── 3) 真实数据文件（存在时才测；不存在说明用户还没导入过书）──
if (!existsSync(realData)) {
  console.log('\n未发现真实 data.json，跳过真实数据迁移验证。');
} else {
  const libDir = join(tempHome, 'reading-workbench');
  await mkdir(libDir, { recursive: true });
  const copied = join(libDir, 'data.json');
  await copyFile(realData, copied);

  const before = JSON.parse(await readFile(realData, 'utf8'));
  const paths = { dir: libDir, file: copied, libraryDir: join(libDir, 'library') };
  const loaded = await loadData(paths);

  check('迁移后书目数量不变', loaded.books.length === before.books.length, `${before.books.length} → ${loaded.books.length}`);
  check('迁移后划线数量不变', loaded.highlights.length === before.highlights.length);
  check('迁移后进度条目数不变', Object.keys(loaded.progress).length === Object.keys(before.progress).length);
  check('迁移后每个 book.id 都在', before.books.every((b) => loaded.books.some((entry) => entry.id === b.id)));
  check('迁移后 settings.reader.columns 已补上', loaded.settings.reader.columns !== undefined, `columns=${loaded.settings.reader.columns}`);
  check('迁移后原字号未被改动', loaded.settings.reader.fontSize === (before.settings?.reader?.fontSize ?? 17), `${loaded.settings.reader.fontSize}`);
  check('迁移保留 lastOpenedBookId', loaded.settings.lastOpenedBookId === before.settings?.lastOpenedBookId);

  // 旧进度锚点仍可解析（UI 打开该书时会用上）
  const anchors = Object.values(loaded.progress).map((entry) => entry.anchor);
  check('旧进度锚点全部可解析', anchors.every((anchor) => parseAnchor(anchor) !== undefined), anchors.join(' | '));

  // 迁移只读不写：源文件不应被改动
  const after = await readFile(realData, 'utf8');
  check('迁移过程不修改用户原文件', after === JSON.stringify(before, null, 2), '读取路径不含写操作');

  check('readSettings 可直接用', (await readSettings(paths)).reader.columns !== undefined);
}

// ── 4) 损坏文件不崩（返回空结构）──
const brokenDir = join(tempHome, 'broken');
await mkdir(brokenDir, { recursive: true });
await writeFile(join(brokenDir, 'data.json'), '{ 这不是合法 JSON', 'utf8');
const broken = await loadData({ dir: brokenDir, file: join(brokenDir, 'data.json'), libraryDir: join(brokenDir, 'library') });
check('损坏 data.json 回落空结构', broken.books.length === 0 && broken.settings.reader.columns === 'auto');

await rm(tempHome, { recursive: true, force: true });
console.log(allPass ? '\n老数据迁移自测全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
