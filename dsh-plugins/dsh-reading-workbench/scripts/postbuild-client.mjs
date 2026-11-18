/**
 * Client 产物后处理：把越界的 require 改写成惰性抛错的本地桩。
 *
 * 背景：pdfjs-dist 的产物里保留了 Node 分支引用
 * （`require("url").pathToFileURL(...)`、`require("module").createRequire(...)`），
 * 这些分支在浏览器里永远不会执行，但 DSH 的 ModuleLoader 只认平台 seed 模块，
 * 残留任何第三方/内建 require 都会让**整个 web boot 失败**（不只是本插件缺席）。
 *
 * 为什么不在打包器里做：tsdown/rolldown 的 alias 会把 `module`/`url` 这类名字
 * 一起卷进解析期，导致构建直接失败；改产物是最小且可验证的做法。
 *
 * 用法：node scripts/postbuild-client.mjs（由 npm run build 串在 tsdown 之后）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '..', 'lib', 'client.cjs');

/** 允许出现在产物里的平台 seed 模块。 */
const SEED_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]);

/** 惰性桩：被调用时才抛错，避免把宿主带崩。 */
const STUB = `new Proxy(function () {
      throw new Error("node builtin unavailable in the browser bundle");
    }, { get: (_t, key) => { if (key === "default") return {}; return () => { throw new Error("node builtin unavailable in the browser bundle"); }; } })`;

let source = readFileSync(bundlePath, 'utf8');
const offenders = [...new Set([...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]))]
  .filter((id) => !SEED_MODULES.has(id));

for (const id of offenders) {
  // 只替换 require 调用本身，保留后续属性访问的形态（pathToFileURL 等仍可解析到桩上）
  source = source.replaceAll(`require("${id}")`, `(${STUB})`);
}

writeFileSync(bundlePath, source, 'utf8');
console.log(
  offenders.length === 0
    ? 'Client 产物后处理：无越界 require'
    : `Client 产物后处理：已桩化 ${offenders.length} 个越界模块 -> ${offenders.join(', ')}`,
);
