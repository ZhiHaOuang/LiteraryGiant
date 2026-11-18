/**
 * Host 侧上传导入链路自测（不依赖 DSH）：加载 lib 产物起临时服务，
 * 验证 upload → 书架 → 正文 → 移除，以及围栏对非 loopback 的拒绝。
 * 用临时 dshHome，不碰真实书库。
 * 用法：node scripts/host-upload-selftest.mjs
 */
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.mjs';

const dshHome = await mkdtemp(join(tmpdir(), 'rw-upload-selftest-'));
const routes = [];
const ctx = {
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
  logger: { warn: (error) => console.log('[warn]', error instanceof Error ? error.message : error) },
  effect(fn) {
    fn();
    return () => {};
  },
};

apply(ctx, { dshHome });
console.log(`已注册路由 ${routes.length} 条`);

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const route = routes.find((r) => r.path === path);
  if (!route) {
    res.writeHead(404).end('{}');
    return;
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500).end(JSON.stringify({ error: String(error) }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;

/** 发一次 JSON 请求。 */
function call(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        setHost: false,
        headers: {
          host,
          origin,
          'sec-fetch-site': 'same-origin',
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** 发一次原始字节请求（octet-stream，文本类二进制上传通道用）。 */
function callBytes(path, bytes) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        setHost: false,
        headers: {
          host,
          origin,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/octet-stream',
          'content-length': bytes.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.write(Buffer.from(bytes));
    req.end();
  });
}

let allPass = true;

/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

// 1) 上传导入（浏览器文件选择器路径）
const markdown = '# 上传测试\n\n这是通过 upload 导入的内容。\n\n- 甲\n- 乙\n';
const uploaded = await call('POST', '/api/reading-workbench/books/upload', {
  title: '上传测试书',
  format: 'md',
  content: markdown,
});
check('上传导入成功', uploaded.status === 200 && uploaded.body?.ok === true, `status=${uploaded.status}`);
check('返回书名正确', uploaded.body?.data?.title === '上传测试书', `title=${uploaded.body?.data?.title}`);
const bookId = uploaded.body?.data?.id;

// 2) 书架包含新书
const list = await call('GET', '/api/reading-workbench/books');
check('书架包含上传的书', Array.isArray(list.body?.data) && list.body.data.some((e) => e.book.id === bookId), `共 ${list.body?.data?.length} 本`);

// 3) 正文与上传内容一致（中文与换行都要对）
const content = await call('GET', `/api/reading-workbench/content?id=${encodeURIComponent(bookId)}`);
check('正文与上传内容一致', content.body?.data?.content === markdown, `长度 ${content.body?.data?.content?.length}`);

// 4) 空内容要被拒绝
const empty = await call('POST', '/api/reading-workbench/books/upload', { title: '空书', format: 'md', content: '   ' });
check('拒绝空内容', empty.status === 400 && empty.body?.ok === false, `status=${empty.status}`);

// 5) 非 loopback Origin 仍被围栏拒绝
const forbidden = await call('POST', '/api/reading-workbench/books/upload', { title: 'x', format: 'md', content: 'x' }, { origin: 'http://evil.example' });
check('外站 Origin 被拒（403）', forbidden.status === 403, `status=${forbidden.status}`);

// 6) 移除书目
const removed = await call('POST', '/api/reading-workbench/books/remove', { bookId });
check('移除书目', removed.status === 200 && removed.body?.data?.removed === true, `status=${removed.status}`);
const afterRemove = await call('GET', '/api/reading-workbench/books');
check('移除后列表为空', Array.isArray(afterRemove.body?.data) && afterRemove.body.data.length === 0, `共 ${afterRemove.body?.data?.length} 本`);

// 7) 阅读设置（UI v2）：默认值 → 写入 → 落盘 → 非法值收敛 → 还原
const settings0 = await call('GET', '/api/reading-workbench/settings');
check('设置默认 columns 为 auto', settings0.body?.data?.reader?.columns === 'auto', `columns=${settings0.body?.data?.reader?.columns}`);
check('设置默认字号为 17', settings0.body?.data?.reader?.fontSize === 17, `fontSize=${settings0.body?.data?.reader?.fontSize}`);
const wrote = await call('PUT', '/api/reading-workbench/settings', { reader: { columns: 2, fontSize: 21, lineHeight: 2.1 } });
check('写入双页与字号', wrote.body?.data?.reader?.columns === 2 && wrote.body?.data?.reader?.fontSize === 21, JSON.stringify(wrote.body?.data?.reader));
const rereadSettings = await call('GET', '/api/reading-workbench/settings');
check('设置落盘（重新读取一致）', rereadSettings.body?.data?.reader?.lineHeight === 2.1, `lineHeight=${rereadSettings.body?.data?.reader?.lineHeight}`);
// 越界值收敛：字号上限 28、行高上限 2.6、columns 非法回落 auto
const wild = await call('PUT', '/api/reading-workbench/settings', { reader: { fontSize: 999, lineHeight: 99, columns: 7 } });
check('字号越界收敛到 28', wild.body?.data?.reader?.fontSize === 28, `fontSize=${wild.body?.data?.reader?.fontSize}`);
check('行高越界收敛到 2.6', Math.abs(wild.body?.data?.reader?.lineHeight - 2.6) < 0.001, `lineHeight=${wild.body?.data?.reader?.lineHeight}`);
check('columns 非法回落 auto', wild.body?.data?.reader?.columns === 'auto', `columns=${wild.body?.data?.reader?.columns}`);
// 部分更新：只给 columns 时其它字段保持
await call('PUT', '/api/reading-workbench/settings', { reader: { fontSize: 15, columns: 1 } });
const partial = await call('PUT', '/api/reading-workbench/settings', { reader: { columns: 2 } });
check('部分更新保留其它字段', partial.body?.data?.reader?.fontSize === 15 && partial.body?.data?.reader?.columns === 2, JSON.stringify(partial.body?.data?.reader));
// lastOpenedBookId 往返
const withLast = await call('PUT', '/api/reading-workbench/settings', { lastOpenedBookId: 'some-book-id' });
check('记录最近打开的书', withLast.body?.data?.lastOpenedBookId === 'some-book-id', `lastOpenedBookId=${withLast.body?.data?.lastOpenedBookId}`);
const cleared = await call('PUT', '/api/reading-workbench/settings', { lastOpenedBookId: '' });
check('空串清除最近打开', cleared.body?.data?.lastOpenedBookId === undefined, `lastOpenedBookId=${cleared.body?.data?.lastOpenedBookId}`);

// 8) 封面：没有封面的书返回 404（客户端据此渲染生成式封面）
const noCover = await call('GET', `/api/reading-workbench/cover?id=${encodeURIComponent(bookId)}`);
check('已移除的书 /cover 404', noCover.status === 404, `status=${noCover.status}`);
const coverBad = await call('GET', '/api/reading-workbench/cover');
check('缺 id 参数 400', coverBad.status === 400, `status=${coverBad.status}`);

// 9) 书目列表带 hasCover 字段（UI 判定不区分 undefined）
const textBook = await call('POST', '/api/reading-workbench/books/upload', { title: '带封面字段', format: 'md', content: '# x' });
check('文本类导入 hasCover=false', textBook.body?.data?.hasCover === false, `hasCover=${textBook.body?.data?.hasCover}`);
const listAgain = await call('GET', '/api/reading-workbench/books');
check('书架条目的 book.hasCover 非 undefined', (listAgain.body?.data ?? []).every((e) => e.book.hasCover !== undefined), `共 ${listAgain.body?.data?.length} 本`);
await call('POST', '/api/reading-workbench/books/remove', { bookId: textBook.body?.data?.id });

// 10) 文本类二进制上传（P0 修复）：GBK/GB2312 老文件必须按原始字节判定编码。
//     下面是「　　【蓝天航空公司的淫荡空姐】」的 GBK 字节（取自真实事故文件头部）。
const GBK_BYTES = [
  0xa1, 0xa1, 0xa1, 0xa1, 0xa1, 0xbe, 0xc0, 0xb6, 0xcc, 0xec, 0xba, 0xbd, 0xbf, 0xd5,
  0xb9, 0xab, 0xcb, 0xbe, 0xb5, 0xc4, 0xd2, 0xf9, 0xb5, 0xb4, 0xbf, 0xd5, 0xbd, 0xe3,
  0xa1, 0xbf,
];
const GBK_TEXT = '　　【蓝天航空公司的淫荡空姐】';
const gbkBook = await callBytes(
  `/api/reading-workbench/books/upload-binary?title=${encodeURIComponent('GBK 老书')}&format=txt`,
  GBK_BYTES,
);
check(
  'GBK 文件经二进制通道导入成功',
  gbkBook.status === 200 && gbkBook.body?.ok === true,
  `status=${gbkBook.status} error=${gbkBook.body?.error}`,
);
const gbkId = gbkBook.body?.data?.id;
const gbkContent = await call('GET', `/api/reading-workbench/content?id=${encodeURIComponent(gbkId)}`);
check(
  'GBK 正文解码正确（无替换符）',
  gbkContent.body?.data?.content === GBK_TEXT,
  JSON.stringify(gbkContent.body?.data?.content),
);
await call('POST', '/api/reading-workbench/books/remove', { bookId: gbkId });

// 11) 无法识别的编码：显式报错，不许静默入库
const badBook = await callBytes(
  `/api/reading-workbench/books/upload-binary?title=${encodeURIComponent('坏编码')}&format=txt`,
  [0xff, 0xff, 0xff, 0xff],
);
check('无法识别的编码被拒（400）', badBook.status === 400 && badBook.body?.ok === false, `status=${badBook.status}`);

// 12) 旧 JSON 通道仍然安全：带大量替换符的内容必须被拒（老客户端缓存未刷新时的兜底）
const damagedUpload = await call('POST', '/api/reading-workbench/books/upload', {
  title: '损坏书',
  format: 'txt',
  content: '正文' + '\uFFFD'.repeat(50),
});
check(
  '含替换符的 JSON 上传被拒（400）',
  damagedUpload.status === 400 && damagedUpload.body?.ok === false,
  `status=${damagedUpload.status}`,
);

server.close();
await rm(dshHome, { recursive: true, force: true });
console.log(allPass ? '\n上传链路自测全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
