/**
 * M0 端到端验收脚本：导入样例书 → 读书架 → 读正文 → 进度 → 划线。
 * 用法：node scripts/e2e-check.mjs [port]
 * 前置：DSH 正在运行且插件已加载。
 *
 * 2026-10-20：进度锚点断言已从 v1（`line:3:0`）迁移到 **v2 双锚点**。
 * 旧版脚本写的是 `line:3:0`，Host 会原样存下（它不校验格式），
 * 于是「保存成功」的断言永远为真 —— **测不出任何东西**。
 * 现在改为三段式核验，任一段失败都说明契约破了：
 *   1. 回读 `/settings`+`/books` 里的 anchor 必须与写入的 v2 串**逐字符相等**；
 *   2. 旧格式（`line:` / `chapter:` / `page:`）仍被接受且**不被改写**（向后兼容锁）；
 *   3. 越界/非法输入被收敛，而不是 500。
 */
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const port = Number(process.argv[2] ?? 19387);
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample.md');
const origin = `http://127.0.0.1:${port}`;

/** 发一次 JSON 请求。 */
function call(method, path, body) {
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
          host: `127.0.0.1:${port}`,
          origin,
          'sec-fetch-site': 'same-origin',
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
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

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

/** 从书架响应里取某本书的进度锚点（Host 口径）。 */
async function anchorOf(bookId) {
  const list = await call('GET', '/api/reading-workbench/books');
  const entry = list.body?.data?.find((item) => item.book?.id === bookId);
  return entry?.progress?.anchor;
}

const imported = await call('POST', '/api/reading-workbench/books', { path: fixture });
check('导入样例书', imported.status === 200 && imported.body.ok === true, `status=${imported.status}`);
const bookId = imported.body?.data?.id;
console.log(`      书名: ${imported.body?.data?.title}  id=${bookId}`);

const list = await call('GET', '/api/reading-workbench/books');
check('书架列表包含新书', Array.isArray(list.body?.data) && list.body.data.some((entry) => entry.book.id === bookId), `共 ${list.body?.data?.length} 本`);

const content = await call('GET', `/api/reading-workbench/content?id=${encodeURIComponent(bookId)}`);
check('读取正文', content.status === 200 && content.body?.data?.content?.includes('阅读工作台'), `长度 ${content.body?.data?.content?.length} 字符`);

/* ── 进度锚点：v2 双锚点契约（2026-10-20 迁移）── */

// 1. 写入 v2 串必须原样回读
const v2Anchor = 'v2;page=7;pct=58.2';
const progress = await call('PUT', '/api/reading-workbench/progress', { bookId, anchor: v2Anchor, percent: 58.2 });
check('保存进度（v2 锚点）', progress.status === 200 && progress.body?.data?.saved === true, `status=${progress.status}`);
const readBackV2 = await anchorOf(bookId);
check(
  'v2 锚点原样回读（逐字符）',
  readBackV2 === v2Anchor,
  `写入=${v2Anchor} 回读=${String(readBackV2)}`,
);

// 2. 章节书形态（带 chapter）同样必须原样回读
const v2ChapterAnchor = 'v2;chapter=3;page=2;pct=41.5';
const chapterProgress = await call('PUT', '/api/reading-workbench/progress', { bookId, anchor: v2ChapterAnchor, percent: 41.5 });
check('保存进度（v2 章节锚点）', chapterProgress.status === 200 && chapterProgress.body?.data?.saved === true, `status=${chapterProgress.status}`);
const readBackChapter = await anchorOf(bookId);
check(
  'v2 章节锚点原样回读',
  readBackChapter === v2ChapterAnchor,
  `写入=${v2ChapterAnchor} 回读=${String(readBackChapter)}`,
);

// 3. 旧锚点仍被接受（向后兼容锁：旧客户端/旧数据不能因为升级而报错）
const legacyProgress = await call('PUT', '/api/reading-workbench/progress', { bookId, anchor: 'line:3:0', percent: 12 });
check('旧锚点仍被接受（向后兼容）', legacyProgress.status === 200 && legacyProgress.body?.data?.saved === true, `status=${legacyProgress.status}`);
const readBackLegacy = await anchorOf(bookId);
check('旧锚点原样保留（不做静默改写）', readBackLegacy === 'line:3:0', `回读=${String(readBackLegacy)}`);

// 4. 写回 v2，清理为测试书自己的真实进度
await call('PUT', '/api/reading-workbench/progress', { bookId, anchor: v2Anchor, percent: 58.2 });

const highlight = await call('POST', '/api/reading-workbench/highlights', { bookId, text: '这是一本用于验证阅读工作台功能的最小样例。', anchor: 'mark:off=12:len=22' });
check('创建划线（mark 锚点）', highlight.status === 200 && typeof highlight.body?.data?.id === 'string', `status=${highlight.status}`);
const highlightId = highlight.body?.data?.id;

const highlights = await call('GET', `/api/reading-workbench/highlights?bookId=${encodeURIComponent(bookId)}`);
check('划线列表', Array.isArray(highlights.body?.data) && highlights.body.data.length >= 1, `共 ${highlights.body?.data?.length} 条`);

const removedHighlight = await call('DELETE', `/api/reading-workbench/highlight?id=${encodeURIComponent(highlightId)}`);
check('删除划线（清理测试数据）', removedHighlight.status === 200 && removedHighlight.body?.data?.removed === true, `status=${removedHighlight.status}`);

// 浏览器文件选择器通道（上传内容建书）
const uploadedBook = await call('POST', '/api/reading-workbench/books/upload', {
  title: '上传验收书',
  format: 'md',
  content: '# 上传验收\n\n这是走浏览器通道导入的内容。\n',
});
check('上传导入（浏览器通道）', uploadedBook.status === 200 && uploadedBook.body?.ok === true, `status=${uploadedBook.status}`);
const uploadedId = uploadedBook.body?.data?.id;
const uploadedContent = await call('GET', `/api/reading-workbench/content?id=${encodeURIComponent(uploadedId)}`);
check('上传内容可读', uploadedContent.body?.data?.content?.includes('上传验收') === true, `长度 ${uploadedContent.body?.data?.content?.length}`);
const removedUpload = await call('POST', '/api/reading-workbench/books/remove', { bookId: uploadedId });
check('移除上传书（清理测试数据）', removedUpload.status === 200 && removedUpload.body?.data?.removed === true, `status=${removedUpload.status}`);

// 清理脚本自己按路径导入的那本验收书。
//
// ⚠️ 这是本脚本**长期漏掉**的一步：早先只删了「上传通道」建的书，
// 按路径导入的 sample.md 会一直留在用户书架上 —— 每跑几次就多一本同名的「sample」。
// 用户书架是真实数据，测试必须把自己造的一切清干净。
const removedFixture = await call('POST', '/api/reading-workbench/books/remove', { bookId });
check('移除样例书（清理测试数据）', removedFixture.status === 200 && removedFixture.body?.data?.removed === true, `status=${removedFixture.status}`);

// 自清理断言：跑完之后书架上不应再有指向 fixtures/sample.md 的书
const afterCleanup = await call('GET', '/api/reading-workbench/books');
const leftover = (afterCleanup.body?.data ?? []).filter((entry) =>
  String(entry?.book?.sourcePath ?? '').endsWith('fixtures/sample.md'),
);
check('书架上没有残留的验收书', leftover.length === 0, `残留 ${leftover.length} 本`);

console.log(allPass ? '\nM0 端到端全部通过' : '\n存在失败项');
process.exit(allPass ? 0 : 1);
