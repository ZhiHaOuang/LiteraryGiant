/**
 * 书内排版端到端验收（不依赖 DSH 重启）：node scripts/styles-instance-check.mjs
 *
 * 用**构建产物** `lib/index.mjs` + 假 ctx 起一个本地 HTTP 服务，走真实链路：
 *
 *   真实书库 ──GET /styles──> Host 收集合并 ──scopeBookCss──> 注入用的 CSS 文本
 *
 * 断言的是「最终注入的 CSS 能不能把标题从普通段落里区分出来」，这是用户
 * 「文字全都一样」的直接解药。任何一环断掉（路径拼接、路由、作用域化、属性过滤）
 * 这条断言都会失败。
 *
 * 需要真实书库（`~/.dsh/reading-workbench`）；找不到时明确 SKIP，不伪装通过。
 */
import { createServer, request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { apply } from '../lib/index.mjs';

const { scopeBookCss } = await import('../src/client/book-css.ts');

let allPass = true;
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

// ── 找一个真实 epub 书 id（优先 data.json 里最近打开的那本） ──
const home = join(homedir(), '.dsh');
const dataFile = join(home, 'reading-workbench', 'data.json');
if (!existsSync(dataFile)) {
  console.log(`SKIP  未找到真实书库 ${dataFile}`);
  process.exit(0);
}
const data = JSON.parse(readFileSync(dataFile, 'utf8'));
const lastId = data?.settings?.lastOpenedBookId;
const epubBook = (data.books ?? []).find((b) => b.id === lastId && b.format === 'epub')
  ?? (data.books ?? []).find((b) => b.format === 'epub');
if (epubBook === undefined) {
  console.log('SKIP  书库里没有 epub 书');
  process.exit(0);
}
check('自检：找到了待验证的 epub 书', epubBook.format === 'epub', `${epubBook.title?.slice(0, 18) ?? epubBook.id}`);

// ── 起本地服务（假 ctx，真实产物） ──
const routes = [];
const ctx = {
  webServer: { register(route) { routes.push(route); return () => {}; } },
  logger: { warn: (e) => console.log('[warn]', e instanceof Error ? e.message : e) },
  effect(fn) { fn(); return () => {}; },
};
apply(ctx, { dshHome: home });
check('Host 半注册了 /styles 路由', routes.some((r) => r.path.endsWith('/styles')), `共 ${routes.length} 条路由`);

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const route = routes.find((r) => r.path === path);
  if (route === undefined) {
    res.writeHead(404).end('{}');
    return;
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500).end(JSON.stringify({ error: String(error) }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

/** GET 并解析包络。 */
function get(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}` }, setHost: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(new Error(`非 JSON 响应（${res.statusCode}）：${body.slice(0, 120)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

try {
  const response = await get(`/api/reading-workbench/styles?id=${encodeURIComponent(epubBook.id)}`);
  check('/styles 返回 200', response.status === 200, `status=${response.status}`);
  const payload = response.body?.data ?? {};
  check('css 非空（书内样式被真的读出来了）', typeof payload.css === 'string' && payload.css.length > 0, `长度 ${payload.css?.length ?? 0}`);
  check('files 是相对书根的路径（不是绝对路径）', Array.isArray(payload.files) && payload.files.length > 0 && payload.files.every((f) => !/^[A-Za-z]:[\\/]/.test(f) && !f.startsWith('/')), (payload.files ?? []).join(', '));
  check('没有「读取失败」类告警', Array.isArray(payload.warnings) && !payload.warnings.some((w) => w.includes('读取失败')), (payload.warnings ?? []).join(' | ') || '无');

  // ── 作用域化：这是最终真正注入 DOM 的 CSS ──
  const scoped = scopeBookCss(payload.css ?? '', { scope: '.dsh-reading-flow', dropFontFamily: false });
  check('作用域化产物非空', scoped.length > 100, `长度 ${scoped.length}`);
  check('每条选择器都落在正文容器内', scoped
    .split('}')
    .filter((block) => block.includes('{'))
    .every((block) => block.split('{')[0].split(',').every((sel) => sel.trim() === '' || sel.includes('.dsh-reading-flow') || sel.trim().startsWith('@'))));
  check('标题加粗规则进入产物（.bold 类）', /font-weight:\s*bold/.test(scoped));
  check('正文首行缩进进入产物（text-indent）', /text-indent:\s*2em/.test(scoped));
  check('没有布局类属性泄漏（width/height/position）', !/(?:^|[;{]\s*)(?:width|height|position)\s*:/.test(scoped));

  // ── 关键「用户可感知」判据：用产物 CSS 渲染一章，标题与正文必须算出不同样式 ──
  // 这里不做真实浏览器渲染（那是 ui-render-check 的事），只验证「标题所用的 class 有规则覆盖」。
  const chapterFile = join(home, 'reading-workbench', 'library', epubBook.id, 'manifest.json');
  if (existsSync(chapterFile)) {
    const manifest = JSON.parse(readFileSync(chapterFile, 'utf8'));
    // 作用域化产物里选择器可能带标签前缀（`.dsh-reading-flow span.kaiti`），
    // 只认 `.dsh-reading-flow .class` 会漏掉全部规则 —— 这里标签名可选
    const scopedClasses = [...scoped.matchAll(/\.dsh-reading-flow\s+(?:[a-z][\w-]*)?\.([\w-]+)/gi)].map((m) => m[1]);
    /**
     * 挑第一个「class 确实被产物 CSS 覆盖」的章节。
     *
     * 封面/书名页常常只有 body 级 class（书内 CSS 没有对应规则），拿它做样本会得到空集；
     * `skip` 章（纯标题页）内容已并入下一章，也跳过。两者都只在「有覆盖」的章节上判定，
     * 找不到时才退回第一个带 class 的章节（保持原判据的失败可见性）。
     */
    let html;
    let fallbackHtml;
    const classNamesOf = (text) => {
      const names = new Set();
      for (const match of text.matchAll(/class="([^"]*)"/g)) {
        for (const name of match[1].split(/\s+/)) if (name !== '') names.add(name);
      }
      return names;
    };
    for (const chapter of manifest.chapters ?? []) {
      if (chapter.skip === true) continue;
      const candidate = join(home, 'reading-workbench', 'library', epubBook.id, chapter.href);
      if (!existsSync(candidate)) continue;
      const text = readFileSync(candidate, 'utf8');
      if (!/class="[^"]+"/.test(text)) continue;
      if (fallbackHtml === undefined) fallbackHtml = text;
      const names = classNamesOf(text);
      if ([...names].some((name) => scopedClasses.includes(name))) {
        html = text;
        break;
      }
    }
    if (html === undefined) html = fallbackHtml;
    if (html !== undefined) {
      const classes = classNamesOf(html);
      const covered = [...classes].filter((name) => scopedClasses.includes(name));
      check(
        '章节里的样式类确实被产物覆盖（不是空转）',
        classes.size > 0 && covered.length > 0,
        `覆盖 ${covered.length}/${classes.size} 个 class：${covered.slice(0, 8).join(', ')}`,
      );
    } else {
      check('章节里的样式类确实被产物覆盖（不是空转）', false, '没有找到带 class 的章节文件');
    }
  }
} finally {
  server.close();
}

console.log(allPass ? '\n书内排版端到端验收全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
