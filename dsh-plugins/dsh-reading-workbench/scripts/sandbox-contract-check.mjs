/**
 * 宿主沙箱契约自测：验证 Host 半在真实 cordis + 真实沙箱环境里能 ACTIVE 起来。
 *
 * 背景（真实事故，2026-10-19）：插件 install 成功、lib 产物正确、静态 import 全部
 * 可解析，但 DSH 里 `fiberPhase` 一直是 `failed`、所有 REST 路由 401/404。
 * 根因是 DSH 把 Host 半放进 **vm 沙箱**执行，沙箱里：
 *   - `process` **完全不存在**（不是被 trap 的函数，取值就是 undefined）
 *   - `Buffer` 同样不存在，只有 TextEncoder / TextDecoder
 * 于是 `process.env.DSH_HOME` 在 apply 顶层直接抛 ReferenceError，
 * 整条 Host 半变成 failed —— 而这个错误在宿主那边只进子进程 stderr，不外露。
 *
 * 本套件做两件事：
 * 1. **正向**：把产物按宿主方式（函数体 + 沙箱）求值，在真实 cordis 里 apply，
 *    断言 fiber ACTIVE、路由与 Agent 工具都注册到位；
 * 2. **反证**：把两处修复还原成旧写法，断言必然 FAILED 且异常是
 *    `ReferenceError: process is not defined` —— 证明修复是必要的，不是巧合。
 *
 * 依赖宿主运行时（从 DSH 安装目录解析 cordis），找不到时跳过并明确报告。
 * 用法：node scripts/sandbox-contract-check.mjs [--dsh-root <路径>]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import * as vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(here, '..');
const LIB = join(PLUGIN_DIR, 'lib');
const MATERIALIZED = join(PLUGIN_DIR, 'node_modules');

/**
 * Host 半沙箱里可用的 Node 内置（诊断用：直接给真实模块，模拟宿主注入）。
 *
 * 真实性依据：真实宿主用 Node 自己的 ESM loader 解析产物里的静态 import，
 * 因此**任何 `node:` 内置都能解析**（`agents.md` §4.0 第 4 条：静态 import 在 apply 之前
 * 由宿主解析，是允许用法）。这里逐条列出只是因为本套件把 import 改写成 `__dep(spec)` 调用，
 * 需要一个显式的模块表；**新增插件的 node: 依赖时记得同步这里**，否则会误报
 * 「依赖未注入」——那是夹具缺项，不是宿主限制。
 */
const BUILTINS = {
  'node:path': await import('node:path'),
  'node:os': await import('node:os'),
  'node:fs/promises': await import('node:fs/promises'),
  'node:crypto': await import('node:crypto'),
  // 网页书源的内置抓取通道（web-fetch-fallback.ts）用到的
  'node:https': await import('node:https'),
};

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

/** 解析宿主 cordis 的位置：优先参数，其次 DSH 安装目录，最后 profile。 */
function resolveCordis() {
  const candidates = [];
  const rootFlagIndex = process.argv.indexOf('--dsh-root');
  if (rootFlagIndex >= 0 && process.argv[rootFlagIndex + 1] !== undefined) {
    candidates.push(join(process.argv[rootFlagIndex + 1], 'node_modules/@deepseek-ai/cordis/lib/index.js'));
  }
  // 常见安装位置：DSH 检出目录的 node_modules
  for (const base of [
    'D:/work/nvm/v22.19.0/node_modules/@deepseek-ai/dsh',
    join(process.env.USERPROFILE ?? '', '.dsh/profiles'),
  ]) {
    if (base === '') continue;
    candidates.push(join(base, 'node_modules/@deepseek-ai/cordis/lib/index.js'));
    candidates.push(join(base, 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'));
  }
  // 兜底：用本插件 devDependency 里的 cordis（版本可能与宿主不同，只做求值验证）
  try {
    const req = createRequire(join(PLUGIN_DIR, 'package.json'));
    candidates.push(req.resolve('@deepseek-ai/cordis'));
  } catch {
    // 没有 devDependency 就跳过
  }
  return candidates.find((path) => existsSync(path));
}

/**
 * 把 ESM 源转成沙箱可执行的函数体：import 改成 `__dep(spec)`，export 收集成返回对象。
 * @param source - 原始 ESM 源码。
 * @returns { code, exportsList }
 */
function toBody(source) {
  const exportsList = [];
  const code = source
    .replace(/^import\s+\{([^}]*)\}\s+from\s+"([^"]+)";?\s*$/gm, (_, names, from) => {
      const parts = names.split(',').map((s) => s.trim()).filter(Boolean);
      const decls = [];
      const alias = [];
      for (const part of parts) {
        const [orig, renamed] = part.split(/\s+as\s+/);
        decls.push(orig.trim());
        if (renamed !== undefined) alias.push(`${renamed.trim()} = ${orig.trim()}`);
      }
      const head = `const { ${decls.join(', ')} } = __dep("${from}");`;
      return alias.length === 0 ? head : `${head}\nconst ${alias.join(', ')};`;
    })
    .replace(/^export\s*\{([^}]*)\};?\s*$/gm, (_, body) => {
      for (const part of body.split(',')) {
        const [local, alias] = part.trim().split(/\s+as\s+/);
        if (local !== undefined && local !== '') exportsList.push(`${alias ?? local}: ${local}`);
      }
      return '';
    })
    .replace(/^export\s+(?:const|let|var)\s+/gm, '')
    .replace(/^export\s+function\s+/gm, 'function ')
    .replace(/^export\s+class\s+/gm, 'class ')
    .replace(/^export\s+default\s+/gm, 'const __default = ')
    .replace(/\/\/# sourceMappingURL=.*$/m, '');
  return { code, exportsList };
}

/** 取某文件里所有顶层 import 的模块 spec。 */
function importSpecs(source) {
  return [...source.matchAll(/^import\s+\{[^}]*\}\s+from\s+"([^"]+)";?\s*$/gm)].map((match) => match[1]);
}

/**
 * 组装沙箱可执行体。
 * @param mutate - true 时把两处沙箱不兼容写法还原（反证用）。
 * @returns { body, epubSpec }
 */
function buildBody(mutate) {
  const fflateSrc = readFileSync(join(MATERIALIZED, 'fflate/esm/browser.js'), 'utf8');
  const mainSrc = readFileSync(join(LIB, 'index.mjs'), 'utf8');
  const epubSpec = importSpecs(mainSrc).find((spec) => spec.startsWith('./epub-'));
  if (epubSpec === undefined) throw new Error('产物里找不到 epub chunk 的 import');
  const epubSrc = readFileSync(join(LIB, epubSpec), 'utf8');

  const index = toBody(mainSrc);
  let indexCode = index.code;
  if (mutate) {
    indexCode = indexCode.replace(
      'config?.dshHome ?? resolveDshHome(ctx)',
      'config?.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh")',
    );
    indexCode = indexCode.replace(
      "'content-length': utf8Length(payload),",
      "'content-length': Buffer.byteLength(payload),",
    );
  }

  const fflate = toBody(fflateSrc);
  const epub = toBody(epubSrc);
  const body = `
const __EPUB_SPEC = ${JSON.stringify(epubSpec)};
const __MODULES = {
  fflate: () => { ${fflate.code}\n return { ${fflate.exportsList.join(', ')} }; },
  [__EPUB_SPEC]: () => {
    const __dep = __makeDep(${JSON.stringify(importSpecs(epubSrc))});
    ${epub.code}
    return { ${epub.exportsList.join(', ')} };
  },
};
const __CACHE = {};
function __makeDep(specs) {
  return function dep(spec) {
    const key = spec === './epub-BmB-3Kpi.mjs' ? __EPUB_SPEC : spec;
    if (specs.includes(spec) && __MODULES[key] !== undefined) {
      if (__CACHE[key] === undefined) __CACHE[key] = __MODULES[key]();
      return __CACHE[key];
    }
    if (__BUILTINS__[spec]) return __BUILTINS__[spec];
    throw new Error('依赖未注入: ' + spec);
  };
}
const __dep = __makeDep(${JSON.stringify(importSpecs(mainSrc))});
${indexCode}
return { ${index.exportsList.join(', ')} };
`;
  return { body, epubSpec };
}

const cordisPath = resolveCordis();
if (cordisPath === undefined) {
  console.log('SKIP  找不到宿主 cordis 运行时，跳过沙箱契约验证（可用 --dsh-root 指定 DSH 安装目录）');
  process.exit(0);
}
const { Context } = await import(pathToFileURL(cordisPath).href);
console.log(`宿主 cordis：${cordisPath}\n`);

/**
 * 宿主把 sandbox 强制的 ctx 白名单动词（抄自 dsh-cordis-host-runner 的 CTX_VERBS）。
 * 实现里用到 ctx 的任何其他属性都会被门禁拒绝，所以必须拿这份清单核对。
 */
const CTX_VERBS = new Set([
  'effect', 'on', 'once', 'provide',
  'timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce',
]);

/**
 * 真实 cordis 里跑插件，并用宿主同样的白名单 Proxy 包装 ctx（契约复刻的第 2 层）。
 *
 * 为什么要复刻：宿主给 apply 的不是真的 ctx，而是一个 Proxy ——
 * 只放行 CTX_VERBS、`tools`、`get`，以及 inject 里声明过的服务；
 * 其余一律抛 "sandbox ctx does not expose ..."，且这是**运行期**拒绝，
 * 本地直接传真 ctx 是测不出来的。
 * @param label - 用例名。
 * @param mutate - 是否还原旧写法（process / Buffer）。
 * @param options - 额外变体开关。
 * @param options.dropToolsInject - true 时把 inject 里的 'tools' 去掉（反证用）。
 * @returns { state, routes, tools, error, guardErrors }
 */
async function runOnce(label, mutate, options = {}) {
  const { body } = buildBody(mutate);
  const sandbox = vm.createContext({ console, __BUILTINS__: BUILTINS, TextEncoder, TextDecoder });
  let plugin;
  try {
    plugin = vm.runInContext(`(() => { ${body} })()`, sandbox, { filename: `sandbox-${label}.js` });
  } catch (error) {
    return { state: null, routes: 0, tools: [], error: `${error.name}: ${error.message}`, guardErrors: [] };
  }
  const declaredInject = options.dropToolsInject === true
    ? (Array.isArray(plugin.inject) ? plugin.inject : Object.keys(plugin.inject ?? {}))
      .filter((name) => name !== 'tools')
    : plugin.inject;
  const root = new Context();
  let routes = 0;
  const tools = [];
  const guardErrors = [];
  root.provide('webServer', {
    register() {
      routes += 1;
      return () => {};
    },
  });
  root.provide('tools', {
    register(tool) {
      tools.push(tool?.name);
      return () => {};
    },
  });
  const quiet = () => {};
  root.provide('logger', { warn: quiet, error: quiet, info: quiet, debug: quiet });

  // 复刻宿主 sandboxContext：包一层白名单 Proxy。
  //
  // 第二次事故（2026-10-19 线上 failed）根因：inject 里漏了 'tools'。
  // cordis 的 Context Proxy 对**未 inject 的服务**语义是：
  //   'tools' in ctx      -> false
  //   读 ctx.tools        -> 抛 cannot get property "tools" without inject
  // 而 `ctx.tools === undefined` 这个"判空"本身就会抛 —— 防御写法因此完全失效，
  // effect 回调里一读就整条 fiber FAILED。所以必须在 inject 里声明。
  // （`logger` 是 cordis 内置，不需要 inject。）
  const declared = new Set(
    Array.isArray(declaredInject) ? declaredInject : Object.keys(declaredInject ?? {}),
  );
  const fakeCtx = (real) => new Proxy({}, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'tools') {
        if (!declared.has('tools')) throw new Error('cannot get property "tools" without inject');
        return real.tools ?? { register: () => () => {} };
      }
      if (prop === 'get') return (name) => real.get(name);
      if (CTX_VERBS.has(prop)) {
        return (...args) => {
          const method = real[prop];
          return typeof method === 'function' ? Reflect.apply(method, real, args) : undefined;
        };
      }
      if (prop === 'logger') return real.logger;
      if (declared.has(prop)) return real[prop];
      const message = `sandbox ctx does not expose "${prop}"`;
      guardErrors.push(message);
      throw new Error(message);
    },
    set(_target, prop) {
      throw new Error(`sandbox ctx is read-only; cannot assign "${String(prop)}"`);
    },
    // 与 cordis 一致：未 inject 的服务 `in` 为 false
    has(_target, prop) {
      if (prop === 'get' || prop === 'logger') return true;
      if (typeof prop !== 'string') return false;
      return CTX_VERBS.has(prop) || declared.has(prop);
    },
  });

  const fiber = root.plugin({
    name: plugin.name,
    inject: declaredInject,
    apply(ctx, config) {
      return plugin.apply(fakeCtx(ctx), config);
    },
  });
  let error;
  try {
    await fiber.await();
  } catch (reason) {
    error = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  }
  return { state: fiber.state, routes, tools, error, guardErrors };
}

// ---------- 断言 ----------

const fixed = await runOnce('fixed', false);
check('修复后 Host 半 fiber 为 ACTIVE', fixed.state === 2, `state=${String(fixed.state)}`);
check('修复后 REST 路由注册成功', fixed.routes > 0, `routes=${fixed.routes}`);
check('修复后 3 个 Agent 工具注册成功', fixed.tools.length === 3, `tools=${JSON.stringify(fixed.tools)}`);
check('修复后 apply 不抛异常', fixed.error === undefined, fixed.error);
check('修复后没有触发宿主 ctx 门禁', fixed.guardErrors.length === 0, fixed.guardErrors.join(' / '));

const broken = await runOnce('broken', true);
check('反证：还原旧写法必然 FAILED', broken.state === 3, `state=${String(broken.state)}`);
check(
  '反证：失败原因正是 process is not defined',
  typeof broken.error === 'string' && broken.error.includes('process is not defined'),
  broken.error,
);
check('反证：还原旧写法时零路由注册', broken.routes === 0, `routes=${broken.routes}`);

// 变体：inject 里故意漏掉 'tools'。
// cordis 对未 inject 的服务：`'tools' in ctx` 为 false、读 ctx.tools 会抛
// `cannot get property "tools" without inject`。新代码在 apply 里用显式 try/catch
// 兜住了这个读取，所以正确行为是：**Host 半照样 ACTIVE、书架 14 条路由照常，
// 只是 3 个 Agent 工具缺席**。这正是"外部插件不得拖垮宿主"的失败纪律。
const noToolsInject = await runOnce('no-tools-inject', false, { dropToolsInject: true });
check(
  '漏掉 tools 时 Host 半仍然 ACTIVE（失败纪律：不拖垮宿主）',
  noToolsInject.state === 2,
  `state=${String(noToolsInject.state)}`,
);
check(
  '漏掉 tools 时书架路由照常注册',
  noToolsInject.routes > 0,
  `routes=${noToolsInject.routes}`,
);
check(
  '漏掉 tools 时 3 个 Agent 工具缺席',
  noToolsInject.tools.length === 0,
  `tools=${JSON.stringify(noToolsInject.tools)}`,
);

// 产物级静态断言：沙箱不可用符号不得出现在**代码**里（注释允许提及）
const indexSrc = readFileSync(join(LIB, 'index.mjs'), 'utf8');
/** 去掉块注释与行注释，只留可执行代码。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const codeOnly = stripComments(indexSrc);
check('产物代码里没有 process.', !/\bprocess\./.test(codeOnly), '沙箱里 process 未定义');
check('产物代码里没有 Buffer.', !/\bBuffer\./.test(codeOnly), '沙箱里 Buffer 未定义');
check(
  '产物代码里没有计时器与「全局」fetch',
  // 负向后顾排除属性访问：`ctx.web.fetch(...)` 是本插件对 cordis web 服务的**契约方法调用**
  // （这正是宿主要求的做法），不属于被 trap 的全局 `fetch(...)`。
  !/(?<![.\w$])(setTimeout|setInterval|setImmediate|fetch)\s*\(/.test(codeOnly),
  '宿主对这些做了 trap，调用即抛（web.fetch 这类契约方法调用不算）',
);

// 第三次同族事故的教训（2026-10-19 网页书源）：**不要把可选服务写进 inject**。
// cordis 对「inject 声明了、但当前没有任何插件提供」的服务，会把 fiber 停在 pending（state=0），
// 结果是 14 条路由一条都不注册 —— 比「少一个功能」严重得多。
// 本插件的 `web` 服务因此改用 `ctx.get('web')` 取；这条断言把该决定钉死。
check(
  'web 服务不写进 inject（改用 ctx.get，避免 fiber 停在 pending）',
  !/export\s*(?:const|let)\s+inject\s*=\s*\[[^\]]*['"]web['"]/.test(codeOnly),
);

// 网页书源的两条抓取通道：
// 1. 宿主 ctx.web（可选，靠 ctx.get 取）；
// 2. 插件内置 node:https 抓取器（宿主 provider 未固定时的回退，见 web-fetch-fallback.ts）。
// 沙箱的 NODE_API_REDIRECTS 只 trap `fetch` 这类函数值全局，**静态 import "node:https"
// 由宿主在 apply 之前解析**，属于允许用法（agents.md §4.0 第 4 条）。
// 这条断言保证它没被误写成会被 trap 的 `require(...)`。
check(
  '内置抓取通道用静态 import "node:https"（而非被 trap 的 require）',
  /from\s*["']node:https["']/.test(indexSrc),
);
check(
  '产物代码里没有 node:https 的 require 写法',
  !/require\s*\(\s*["']node:https["']\s*\)/.test(codeOnly),
);

console.log(`\n${allPass ? '宿主沙箱契约验证全部通过' : '存在失败用例'}`);
process.exitCode = allPass ? 0 : 1;
