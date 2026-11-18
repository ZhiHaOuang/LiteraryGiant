// asar 取证工具：解析 header 并支持按路径读取任意文件。
// 用途：从 DSH 打包产物里读官方包的 README / package.json / 源码，
// 用于确认运行时契约（禁止凭记忆写 slot/service 名）。
// 用法：node scripts/team/asar-tool.mjs list <regex>
//       node scripts/team/asar-tool.mjs read <path> [输出文件]
import fs from 'node:fs';
import path from 'node:path';

const ASAR = 'D:/soft/deepseek harness/resources/app.asar';

/** 解析 asar 头，返回 { entries, dataBase }。 */
function open() {
  const fd = fs.openSync(ASAR, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  // 头结构：4 个 uint32，JSON 长度在第 12 字节（不是第 4 —— 按 4 取会截断成 2 字节）。
  const jsonLen = head.readUInt32LE(12);
  const jb = Buffer.alloc(jsonLen);
  fs.readSync(fd, jb, 0, jsonLen, 16);
  fs.closeSync(fd);
  const header = JSON.parse(jb.toString('utf8'));
  const entries = [];
  (function walk(node, prefix) {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const p = prefix + '/' + name;
      if (value.files) walk(value, p);
      else entries.push({ path: p, size: value.size, offset: Number(value.offset) });
    }
  })(header, '');
  return { entries, dataBase: 16 + jsonLen };
}

/** 读某个 asar 内文件的原始文本。 */
function readFile(entryPath, index) {
  const entry = index.entries.find((e) => e.path === entryPath);
  if (entry === undefined) return null;
  const fd = fs.openSync(ASAR, 'r');
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fd, buf, 0, entry.size, index.dataBase + entry.offset);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

const [, , command, ...rest] = process.argv;
const index = open();

if (command === 'list') {
  const pattern = new RegExp(rest[0] ?? '.*');
  for (const e of index.entries.filter((e) => pattern.test(e.path))) {
    console.log(`${e.path}  ${e.size}`);
  }
} else if (command === 'read') {
  const target = rest[0];
  const text = readFile(target, index);
  if (text === null) {
    console.error('未找到 ' + target);
    process.exit(2);
  }
  if (rest[1] !== undefined) {
    fs.writeFileSync(path.resolve(rest[1]), text);
    console.log(`已写出 ${rest[1]}（${text.length} 字符）`);
  } else {
    process.stdout.write(text);
  }
} else {
  console.error('用法：list <regex> | read <path> [outFile]');
  process.exit(1);
}
