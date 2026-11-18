/**
 * Client 半「装配验证」：真跑 ModuleLoader 信封 + 真 apply，检查槽位注册结果。
 *
 * ## 为什么需要这一层
 *
 * `client-bundle-check` 只验证产物**形态**（信封、require 白名单、factory 能求值），
 * 不验证 `apply(ctx)` 真跑起来会注册哪些槽位。槽位名拼错、注册参数写错，
 * 构建期不会报、运行期也没有任何报错 —— 只是**控件静默不出现**。
 * 「插入书摘」当初挂 `conversation.composer.dock` 时就是这么静默失效的。
 *
 * 这个脚本补上那道缺口：用最小 ctx 假体跑 apply，断言：
 * 1. 槽位都被 `slots.inject` 包住（宿主未声明该槽位时优雅缺席）；
 * 2. 注册参数正确（`main` 用 keyed 的 `key`）；
 * 3. **只注册阅读本身需要的两个槽位**（侧边栏入口 + 主面板），
 *    不注册任何会话域槽位 —— 书摘插入与会话内 tab 已被用户否决并移除，
 *    这条反向断言的目的是防止它们「悄悄回潮」；
 * 4. apply 内部即使注册失败也不抛出（不得拖垮 GUI 启动）。
 *
 * 用法：node scripts/client-assembly-check.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
/** 断言。 */
function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`PASS  ${name}${detail === undefined ? '' : `  ${detail}`}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  ${detail}`}`);
  }
}

const dom = new JSDOM('<!doctype html><html lang="zh"><head></head><body></body></html>');
const { window } = dom;

// 浏览器里才有的全局（CJS 产物按浏览器假设写，缺了会在 factory 求值阶段炸）
const globalNames = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'Event',
  'CustomEvent',
  'TextDecoder',
  'TextEncoder',
  'DOMParser',
  'getComputedStyle',
];

/** 收集注册过程（顺序即代码执行顺序）。 */
const log = [];

/** 最小 slots 假体：记录 inject / register 的调用。 */
const slots = {
  inject(name, factory) {
    log.push({ kind: 'inject', name });
    try {
      factory();
    } catch (error) {
      log.push({ kind: 'inject-error', name, message: error.message });
    }
    return () => {};
  },
  register(options, component) {
    log.push({ kind: 'register', name: options.name, options, pageComponent: typeof component });
    return () => {};
  },
};

/** 最小 client ctx 假体。 */
const ctx = {
  effect(fn) {
    try {
      fn();
    } catch (error) {
      log.push({ kind: 'effect-error', message: error.message });
    }
    return () => {};
  },
  slots,
  locale: {
    register(ns) {
      log.push({ kind: 'locale', ns });
      return () => {};
    },
  },
  layout: {},
  get() {
    return undefined;
  },
};

// ── 1) 在 vm 里加载信封 ──
const code = readFileSync(path.join(here, '..', 'lib', 'client.cjs'), 'utf8');
const envelope = { id: undefined, factory: undefined };
const sandbox = {
  window: {
    ...Object.fromEntries(globalNames.map((n) => [n, window[n]])),
    __ModuleLoader__: {
      load(value) {
        envelope.id = value.id;
        envelope.factory = value.factory;
      },
    },
  },
  document: window.document,
  console,
  TextDecoder,
  TextEncoder,
  setTimeout,
  clearTimeout,
  Promise,
};
sandbox.window.window = sandbox.window;
sandbox.window.document = window.document;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.cjs' });

check('产物被 ModuleLoader 收下', typeof envelope.factory === 'function');
check('信封 id 正确', envelope.id === 'dsh-reading-workbench', String(envelope.id));

// ── 2) 真跑 apply ──
const requireShim = (name) => {
  if (name === 'react' || name === 'react/jsx-runtime' || name === 'react-dom' || name === 'react-dom/client') {
    return require(name);
  }
  // 平台 seed 之外一律返回空对象：本检查只关心注册行为，不渲染组件
  return {};
};
const moduleExports = envelope.factory(requireShim);
check('factory 求值不抛错', moduleExports !== undefined);
check('导出 apply 函数', typeof moduleExports?.apply === 'function');

let applyThrew = false;
try {
  moduleExports.apply(ctx);
} catch (error) {
  applyThrew = true;
  console.log(`  apply 抛错：${error.message}`);
}
check('apply 不抛错（外部插件不得拖垮 GUI 启动）', applyThrew === false);

// ── 3) 断言注册结果 ──
const registered = log.filter((entry) => entry.kind === 'register');
const injected = log.filter((entry) => entry.kind === 'inject').map((entry) => entry.name);

check('注册了 locale 词典', log.some((entry) => entry.kind === 'locale' && entry.ns === 'dsh-reading-workbench'));
check('侧边栏入口被 inject 包裹', injected.includes('sidebar.panellist'), injected.join(','));
check('主面板被 inject 包裹', injected.includes('main'));
check('没有任何 inject/effect 阶段报错', !log.some((e) => e.kind === 'inject-error' || e.kind === 'effect-error'));

const main = registered.find((entry) => entry.name === 'main');
check('main 注册存在', main !== undefined);
check('main 用 keyed 的 key（不是 id）', main?.options.key === 'reading' && main.options.id === undefined, JSON.stringify({ key: main?.options.key, id: main?.options.id }));
const mainProps = main?.options.inject?.();
check('main 的 inject 提供 api / t', mainProps?.api !== undefined && typeof mainProps?.t === 'function');

// 只读书：本插件当前**不应**注册任何会话域槽位。
// 曾经挂过 `conversation.composer.dock`（插入书摘）与 `conversation.view`（会话内阅读 tab），
// 两者都因效果不好被用户否决并移除；这里用反向断言把「不要回潮」钉住。
check(
  '不注册会话域槽位（只读书）',
  !injected.includes('conversation.composer.dock') && !injected.includes('conversation.view'),
  injected.join(','),
);
check(
  '注册表里只有 sidebar.panellist 与 main 两个槽位',
  registered.length === 2,
  registered.map((entry) => entry.name).join(','),
);

// 反证：假体本身能区分「注册了」与「没注册」，证明上面的反向断言不是恒真
slots.register({ name: 'conversation.view', id: 'probe', order: 1 }, () => {});
const probeCount = log.filter((e) => e.kind === 'register' && e.name === 'conversation.view').length;
check('反证：手动注册一个会话域槽位能被记录（判据不是空转）', probeCount === 1, `count=${probeCount}`);

console.log(`\n${fail === 0 ? '装配验证全部通过' : '存在失败项'}：${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
