/**
 * 网页书源**真实站点**端到端验收（默认不跑，需显式加 `--live`）。
 *
 * 与 `web-source-selftest.mjs` 的分工：
 * - selftest 离线跑（真实样本 + 假抓取），进 `pnpm check`；
 * - 本脚本**真的访问站点**，验证只在真实网络下才暴露的问题：
 *   目录页被 10 万字符上限截断后，能否靠正文页的「下一章」链把目录补齐。
 *
 * 为什么这条路值得单独验：抓取通道（`ctx.web.fetch`）只是把 HTML 拿回来，
 * 而「截断 → 懒扩展」是设计里最反常的一环 —— 若它在真实站点上接不上，
 * 用户会得到一本只有前 900 章（目录截断点之前）的书，且没有任何报错。
 *
 * 礼貌抓取：每章之间 sleep 1.5s（站点实测建议 ≥1s），全程只发 4~5 次请求。
 *
 * 用法：node scripts/web-source-live-check.mjs --live
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aliceswAdapter } from '../src/web-source.ts';
import { fetchWebChapters, importWebBook, readWebStatus } from '../src/web-import.ts';
import { readEpubManifest } from '../src/store.ts';

if (!process.argv.includes('--live')) {
  console.log('跳过：本脚本会真实访问站点，需显式传 --live 才执行。');
  process.exit(0);
}

/** 抓取后端（`dsh-web-fetch-http`）默认的单次解码字符上限。 */
const PROVIDER_MAX_BODY_CHARS = 100000;
/** 请求间隔：站点实测建议 ≥1s，这里取 1.5s。 */
const GAP_MS = 1500;

let allPass = true;
let total = 0;
function check(name, condition, detail) {
  total += 1;
  allPass = allPass && Boolean(condition);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 模拟 `ctx.web.fetch` + `http` provider：按字符上限截断并上报 truncated。 */
let requests = 0;
async function liveFetch(url) {
  requests += 1;
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'deepseek-harness/reading-workbench live-check',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
  });
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}：${url}`);
  }
  const truncated = text.length > PROVIDER_MAX_BODY_CHARS;
  return { html: truncated ? text.slice(0, PROVIDER_MAX_BODY_CHARS) : text, truncated };
}

const entryUrl = 'https://www.alicesw.tw/other/chapters/id/35434.html';
const sandboxDir = await mkdtemp(join(tmpdir(), 'dsh-web-live-'));
const paths = { dir: sandboxDir, file: join(sandboxDir, 'data.json'), libraryDir: join(sandboxDir, 'library') };

try {
  console.log(`入口：${entryUrl}`);
  console.log('（本脚本会真实访问站点，全程约 5 次请求、每章间隔 1.5s）\n');

  // ---- 1. 建书（含首章） ----
  const entryPage = await liveFetch(entryUrl);
  check('目录页被抓取后端截断（印证 135,879 字符 > 100,000 上限）', entryPage.truncated === true, `${entryPage.html.length} 字符`);

  const imported = await importWebBook(paths, liveFetch, entryUrl);
  check('建书成功', imported.book.id.length > 0);
  check('书名来自站点', imported.book.title.trim() !== '', imported.book.title);
  check('目录解析到章节（截断后仍有一批）', imported.total > 500, `total=${imported.total}`);
  check('首章已抓取', imported.fetched === 1, `fetched=${imported.fetched}`);
  check('截断有明确 warning', imported.warnings.some((text) => text.includes('截断')), imported.warnings.join(' / '));

  const manifest = await readEpubManifest(paths, imported.book);
  check('manifest 章节 index 与下标一致', manifest.chapters.every((chapter, index) => chapter.index === index));

  // 首章落盘内容可读（阅读链路走的就是这个文件）
  const firstChapterPath = join(paths.libraryDir, imported.book.id, manifest.chapters[0].href);
  const firstChapterHtml = await readFile(firstChapterPath, 'utf8');
  const firstParagraphs = [...firstChapterHtml.matchAll(/<p>([\s\S]*?)<\/p>/g)];
  check('首章落盘为正文字数足够的 <p> 段落', firstParagraphs.length >= 5, `${firstParagraphs.length} 段`);
  check('首章不含原站脚本/样式', !/<script|<style|on\w+=/i.test(firstChapterHtml));

  // ---- 2. 目录懒扩展：截断点之后的章节能否顺链补上 ----
  const lastKnown = manifest.chapters[manifest.chapters.length - 1];
  console.log(`\n目录已知最后一章：第 ${lastKnown.index + 1} 章《${lastKnown.title}》`);
  await sleep(GAP_MS);
  const lastUrl = (await (async () => {
    // 目录里只有 href，源 URL 在 web.json 的 urls 里
    const { readWebState } = await import('../src/store.ts');
    const state = await readWebState(paths, imported.book);
    return state.urls[state.urls.length - 1];
  })());
  const body = await aliceswAdapter.fetchChapter(liveFetch, {
    index: lastKnown.index,
    title: lastKnown.title,
    url: lastUrl,
  });
  check('截断点最后一章正文可解析', body.paragraphs.length > 0, `${body.paragraphs.length} 段`);
  check('该章给出了「下一章」链接（懒扩展的锚点）', typeof body.nextUrl === 'string' && body.nextUrl.length > 0, body.nextUrl);

  const { appendWebChapters, readWebState } = await import('../src/store.ts');
  const beforeTotal = (await readEpubManifest(paths, imported.book)).chapters.length;
  const afterTotal = await appendWebChapters(paths, imported.book, [
    { index: beforeTotal, title: '第 N+1 节', url: body.nextUrl },
  ]);
  check('懒扩展把截断点之后的章节追加进目录', afterTotal === beforeTotal + 1, `${beforeTotal} → ${afterTotal}`);
  const stateAfter = await readWebState(paths, imported.book);
  check('web.json 的 total 与 urls 同步', stateAfter.total === afterTotal && stateAfter.urls.length === afterTotal);

  // 抓这一新章：验证它真的能抓下来（不是死链）
  await sleep(GAP_MS);
  const fetched = await fetchWebChapters(paths, liveFetch, imported.book.id, 1);
  const status = await readWebStatus(paths, imported.book.id);
  check('追加的章节能被正常抓取', status.fetched >= 2, `fetched=${status.fetched}`);
  check('抓取过程无错误', fetched.errors.length === 0, JSON.stringify(fetched.errors).slice(0, 200));

  // ---- 3. 目录重复扩展防护 ----
  const beforeDup = (await readEpubManifest(paths, imported.book)).chapters.length;
  await appendWebChapters(paths, imported.book, [{ index: beforeDup, title: '重复', url: body.nextUrl }]);
  const afterDup = (await readEpubManifest(paths, imported.book)).chapters.length;
  check('同一 URL 不会被重复追加（防章节链回环）', afterDup === beforeDup, `${beforeDup} → ${afterDup}`);

  console.log(`\n共发出 ${requests} 次 HTTP 请求`);
} finally {
  await rm(sandboxDir, { recursive: true, force: true });
}

console.log(`\n=== 真实站点验收：${total} 项，${allPass ? '全部通过' : '存在失败'} ===`);
if (!allPass) process.exitCode = 1;
