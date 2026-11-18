/**
 * 「阅读助手」Agent 预设自测（不依赖宿主，纯函数 + 假服务）。
 *
 * 覆盖四件事，每件都配反证断言，确保测试不会「空转全绿」：
 * 1. **预设定义形状**符合 entry-list 方言（rows 必须有 name、id 非空）；
 * 2. **注册成功路径**：调用 register 一次、拿到 disposer、注销时会真的调用它；
 * 3. **降级路径**（三种）：无服务 / 服务非法 / register 抛错 —— 一律不回抛；
 * 4. **提示词段**：section 收到正确 name/order/interpolate，且 disposer 被交给 ctx.effect。
 *
 * 用法：node scripts/agent-preset-selftest.mjs
 */
import {
  applyPromptSection,
  buildReadingAssistantPreset,
  registerReadingAssistantPreset,
  PROMPT_SECTION_NAME,
  PROMPT_SECTION_ORDER,
} from '../lib/index.mjs';

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

/* ───── 1. 预设定义形状 ───── */

const preset = buildReadingAssistantPreset();
check('预设 id 非空且带插件前缀', typeof preset.id === 'string' && preset.id.startsWith('reading-workbench-'), preset.id);
check('预设有两个展示字段', typeof preset.name === 'string' && preset.name !== '' && typeof preset.description === 'string' && preset.description !== '');
check('预设 order 是有限数字', Number.isFinite(preset.order), String(preset.order));
check('预设 plugins 是非空数组', Array.isArray(preset.plugins) && preset.plugins.length > 0, `${preset.plugins.length} 行`);

// entry-list 方言的硬要求：每行必须是带 name 的对象（宿主的 entryListProblem 就是这么判的）
const rowsValid = preset.plugins.every(
  (row) => typeof row === 'object' && row !== null && !Array.isArray(row) && typeof row.name === 'string' && row.name !== '',
);
check('每行都是带 name 的插件行（entry-list 方言）', rowsValid);
check('插件行指向本包', preset.plugins[0]?.name === 'dsh-reading-workbench', String(preset.plugins[0]?.name));

const rowConfig = preset.plugins[0]?.config ?? {};
check('插件行带 promptSectionOnly 标记', rowConfig.promptSectionOnly === true, String(rowConfig.promptSectionOnly));
check('插件行带非空 promptText', typeof rowConfig.promptText === 'string' && rowConfig.promptText.length > 100, `${String(rowConfig.promptText).length} 字符`);
// 提示词必须写明「只读」与「不要编造」——这是该预设存在的理由
check('提示词写明工具只读', String(rowConfig.promptText).includes('只读'));
check('提示词写明不得编造', /不要补全|没找到/.test(String(rowConfig.promptText)));

// 反证：故意构造非法行，确认判据能报出来（证明上面的 rowsValid 不是恒真）
const badRows = [{ nodename: 'x' }, { name: '' }, [{ name: 'x' }]];
const badCheck = (rows) =>
  rows.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row) && typeof row.name === 'string' && row.name !== '');
check('反证：非法行必须被判非法', badRows.every((row) => badCheck([row]) === false));

/* ───── 2. 注册成功路径 ───── */

let registerCalls = 0;
let disposeCalls = 0;
let receivedDefinition;
const okService = {
  register(definition) {
    registerCalls += 1;
    receivedDefinition = definition;
    return Promise.resolve(() => {
      disposeCalls += 1;
    });
  },
};
const warnings = [];
const okOutcome = registerReadingAssistantPreset(
  (name) => (name === 'agentPresets' ? okService : undefined),
  (error) => warnings.push(error),
);
check('注册成功返回 registered=true', okOutcome.registered === true, JSON.stringify(okOutcome));
check('register 只被调用一次', registerCalls === 1, `calls=${registerCalls}`);
check('传给宿主的定义 id 与自测一致', receivedDefinition?.id === preset.id, String(receivedDefinition?.id));
check('成功路径不产生任何警告', warnings.length === 0, `warnings=${warnings.length}`);

if (okOutcome.registered) {
  await okOutcome.settle();
  check('settle 后调用了宿主的 disposer', disposeCalls === 1, `disposeCalls=${disposeCalls}`);
}

/* ───── 3. 三种降级路径 ───── */

// 3a. 宿主没有该服务
const noServiceWarn = [];
const noService = registerReadingAssistantPreset(() => undefined, (e) => noServiceWarn.push(e));
check('无 agentPresets：降级为未注册', noService.registered === false, JSON.stringify(noService));
check('无 agentPresets：留下可查日志', noServiceWarn.length >= 1, `warnings=${noServiceWarn.length}`);

// 3b. 服务存在但没有 register 方法（假装别的同名服务）
const badService = registerReadingAssistantPreset(() => ({ somethingElse: true }), () => {});
check('服务形状非法：降级为未注册', badService.registered === false);

// 3c. register 同步抛（实测生产实现就会：Duplicate agent preset / id 为空）
// 这条是自测抓到的**真缺陷**：首版把 .then 挂在 register() 的返回值上，
// 而 register() 是同步调用、同步抛时 .then 根本来不及挂 → 异常直接穿出本函数。
const syncThrowWarn = [];
let syncThrowOutcome;
let syncThrewOut = false;
try {
  syncThrowOutcome = registerReadingAssistantPreset(
    () => ({
      register() {
        throw new Error('Duplicate agent preset: reading-workbench-assistant');
      },
    }),
    (e) => syncThrowWarn.push(e),
  );
} catch {
  syncThrewOut = true;
}
check('register 同步抛：异常不外泄', syncThrewOut === false);
check('register 同步抛：降级为未注册', syncThrowOutcome?.registered === false, JSON.stringify(syncThrowOutcome));
check('register 同步抛：原因里带原文', String(syncThrowOutcome?.reason ?? '').includes('Duplicate agent preset'));
check('register 同步抛：留下可查日志', syncThrowWarn.length >= 1, `warnings=${syncThrowWarn.length}`);

// 3d. register 返回 rejected promise（异步失败）
const asyncWarn = [];
const asyncFail = registerReadingAssistantPreset(
  () => ({ register: () => Promise.reject(new Error('activate failed')) }),
  (e) => asyncWarn.push(e),
);
check('register 异步 reject：不向外抛', asyncFail.registered === true);
if (asyncFail.registered) {
  let threw = false;
  try {
    await asyncFail.settle();
  } catch {
    threw = true;
  }
  check('register 异步 reject：settle 不抛出', threw === false);
  check('register 异步 reject：留下可查日志', asyncWarn.length >= 1, `warnings=${asyncWarn.length}`);
}

// 3e. ctx.get 本身抛错
const getThrows = registerReadingAssistantPreset(
  () => {
    throw new Error('cannot get property "agentPresets" without inject');
  },
  () => {},
);
check('ctx.get 抛错：降级为未注册', getThrows.registered === false);

/* ───── 4. 提示词段 ───── */
// 直接调产物导出的 applyPromptSection，确认参数正确（真正的端到端在真实例验收里）。

const sections = [];
const effects = [];
let disposed = 0;
applyPromptSection(
  {
    logger: { warn() {} },
    // 真实 cordis 的 effect 会**立即执行**回调并接管其返回的 disposer；
    // 早先这里只把 fn 存进数组不执行，导致 section() 从未被调用、四项断言误红。
    effect(fn) {
      effects.push(fn);
      const cleanup = fn();
      return typeof cleanup === 'function' ? cleanup : () => {};
    },
    get: (name) => (name === 'systemPrompt' ? { section: (s) => (sections.push(s), () => { disposed += 1; }) } : undefined),
  },
  { promptText: '测试提示词' },
);
check('提示词段被注册一次', sections.length === 1, `sections=${sections.length}`);
check('段的 name 正确', sections[0]?.name === PROMPT_SECTION_NAME, String(sections[0]?.name));
check('段的 order 正确', sections[0]?.order === PROMPT_SECTION_ORDER, String(sections[0]?.order));
check('段关闭变量插值（否则 {{…}} 会让组装失败）', sections[0]?.interpolate === false);
check('段的 disposer 交给了 ctx.effect', effects.length === 1, `effects=${effects.length}`);
check('段的 disposer 未被提前调用（交给 cordis 管理生命周期）', disposed === 0, `disposed=${disposed}`);

// 空正文：跳过且不抛
let emptyThrew = false;
let emptyWarn = 0;
try {
  applyPromptSection({ logger: { warn() { emptyWarn += 1; } }, effect: () => () => {}, get: () => undefined }, { promptText: '' });
} catch {
  emptyThrew = true;
}
check('空正文不抛错', emptyThrew === false);
check('空正文留下日志', emptyWarn >= 1, `warnings=${emptyWarn}`);

// 无 systemPrompt 服务：跳过且不抛
let noSpThrew = false;
try {
  applyPromptSection({ logger: { warn() {} }, effect: () => () => {}, get: () => undefined }, { promptText: 'x' });
} catch {
  noSpThrew = true;
}
check('无 systemPrompt 不抛错', noSpThrew === false);

console.log(`\n${fail === 0 ? '全部通过' : '存在失败项'}：${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
