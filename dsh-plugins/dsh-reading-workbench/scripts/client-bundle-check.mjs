/**
 * Client 半产物验收：把 lib/client.cjs 当真浏览器包跑一遍。
 *
 * 存在的理由：DSH 的 client 模块表只认平台 seed 模块，产物里残留任何第三方
 * require 都会让整个 web boot 失败（GUI 起不来，不只是本插件缺席）。构建配置
 * 一旦漂移就会复发，所以交付前用真产物而不是源码来把关。
 *
 * 用法：node scripts/client-bundle-check.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '..', 'lib', 'client.cjs');
const require = createRequire(import.meta.url);

/** DSH web 包的平台 seed 模块：产物只允许 require 这些。 */
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

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

const source = readFileSync(bundlePath, 'utf8');

// 1) 信封形态：DSH 靠 window.__ModuleLoader__.load 收下这个包。
const PLUGIN_ID = 'dsh-reading-workbench';
check('产物是 __ModuleLoader__.load 信封', source.includes('window.__ModuleLoader__.load('));
check(`信封 id 为 ${PLUGIN_ID}`, source.includes(`id: "${PLUGIN_ID}"`));

// 2) 外部依赖白名单：只允许 seed 模块，第三方包一律视为构建漂移。
const requested = [...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
const offenders = [...new Set(requested)].filter((id) => !SEED_MODULES.has(id));
check(
  'require 全部命中平台 seed 模块',
  offenders.length === 0,
  offenders.length === 0 ? `${[...new Set(requested)].join(', ')}` : `越界: ${offenders.join(', ')}`,
);

// 3) 真跑一遍 factory：jsdom 先就位，DOMPurify 才能在求值期拿到 window/document。
const dom = new JSDOM('<!doctype html><html lang="zh"><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

let factory;
const loader = {
  load(entry) {
    factory = entry.factory;
  },
};
new Function('window', source)({ __ModuleLoader__: loader });
check('信封被 __ModuleLoader__ 收下并拿到 factory', typeof factory === 'function');

let moduleExports;
let evalError;
try {
  moduleExports = factory((spec) => require(spec));
} catch (error) {
  evalError = error;
}
check('factory 求值不抛错', evalError === undefined, evalError?.message);
check('导出 apply 函数', typeof moduleExports?.apply === 'function');
check('导出 inject 服务清单', Array.isArray(moduleExports?.inject), JSON.stringify(moduleExports?.inject));

console.log(allPass ? '\nClient 产物验收通过' : '\nClient 产物验收失败');
process.exit(allPass ? 0 : 1);
