/**
 * 「阅读助手」Agent 预设（M2 收尾）。
 *
 * ## 为什么要由插件注册，而不是写进 profile 的 YAML
 *
 * `@deepseek-ai/dsh-agent-preset-registry` 的官方说法是「新建 preset 是 bundle 补丁」：
 * 手改 `~/.dsh/profiles/<profile>/cordis.patch.yml` 再重启。对「装了插件就想用」是断的。
 * 实测读 `lib/index.js` 后确认注册表对外确实暴露 `agentPresets.register(definition)`：
 *
 * ```js
 * async register(definition) {
 *   if (!definition.id.trim()) throw new Error('Preset id must not be empty');
 *   if (this.definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
 *   ...
 *   record.ready = this.activate(record);   // activate 内部 try/catch，失败只记 broken
 *   await record.ready;
 *   return unregister;
 * }
 * ```
 *
 * 三条实测得出的纪律：
 *
 * 1. **id 不能与 YAML 声明撞**：重复 id 直接抛 `Duplicate agent preset`，
 *    所以用带前缀的 `reading-workbench-assistant`，抛错时降级为「只少一个预设」。
 * 2. **`entryListProblem` 在 activate 的 try 之外抛**（rows 形状非法时），
 *    所以外层必须自己包 try/catch，否则会连累本插件 fiber。
 * 3. **`agentPresets` 是可选服务**：按工作区纪律只能 `ctx.get` + 显式 try/catch，
 *    **绝不写进 `inject`** —— 宿主没注册表时 cordis 会把 fiber 停在 pending，
 *    本插件全部 REST 路由一条都不注册（与 `web` 那次事故同一条教训）。
 *
 * ## 预设里放什么
 *
 * 只放**提示词**，不放工具：本插件三个只读工具由 Host 半全局注册，已对所有会话可见，
 * 在预设里再挂一遍会重复注册同名工具。
 *
 * 提示词怎么进系统提示词：`@deepseek-ai/dsh-system-prompt` 的 config **没有** `append`
 * 之类的文本字段（实测字段只有 `includeHarnessIdentity / includeRuntimeContext /
 * personaPrefix / personaSuffix / toolOrder`），正确做法是挂一个**贡献提示词段**的插件行，
 * 在它的 apply 里调 `ctx.systemPrompt.section({ name, order, text })`。
 * 因此这里挂的是本插件自己导出的入口（`SELF_PACKAGE_NAME`），由 `prompt-section.ts` 提供。
 */

/** 本插件的 npm 包名（预设里引用自身时用）。 */
export const SELF_PACKAGE_NAME = 'dsh-reading-workbench';

/** 预设 id（带插件前缀，避免与用户 YAML 里可能的 `reading-assistant` 撞车）。 */
export const READING_ASSISTANT_PRESET_ID = 'reading-workbench-assistant';

/** 预设展示名。 */
export const READING_ASSISTANT_PRESET_NAME = '阅读助手';

/** 预设说明。 */
export const READING_ASSISTANT_PRESET_DESCRIPTION =
  '围绕书架里正在读的书回答、引用划线、按需取正文节选';

/**
 * 注入给 Agent 的提示词。
 *
 * 每条约束都是为了「不误导模型」，对应一次真实的质量风险：
 * - 工具**只读**：模型不该假装能替用户加划线 / 删书；
 * - 4000 字节选上限 + 用 offset 续取：避免它编造「整章内容」；
 * - 「找不到就说找不到」：书没读到就编，是本插件最容易出的质量问题；
 * - 引用逐字：改写原文会让「精讲」类输出失真。
 */
export const READING_ASSISTANT_PROMPT = [
  '你是阅读助手，服务对象正在 DSH 的「阅读」工作台里读书。',
  '',
  '可用工具（全部只读，不能改书库）：',
  '- `reading_books`：书架列表（书名/作者/格式/阅读进度）。先调用它确认「在读哪本书」。',
  '- `reading_highlights`：划线批注（可带笔记），按时间倒序，可按 bookId 过滤。',
  '- `reading_excerpt`：取正文节选，单次最多 4000 字。',
  '',
  '工作纪律：',
  '1. 用户说「这本书」时，先用 `reading_books` 确认是哪本；有多本且无法判断时直接问，不要猜。',
  '2. 引用原文必须来自工具返回的文本，**逐字**引用并说明大致位置；不要改写成「大意」。',
  '3. 需要更多上下文时，用上一次节选的结束位置作为新的 offset 继续取；',
  '   不要宣称读过全书，也不要编造没取到的段落。',
  '4. 书里没写的内容不要补全。工具没返回、或返回为空，就如实说「书里没找到」。',
  '5. 划线是用户自己做的笔记，引用时保留其原文与笔记，不要替用户改写观点。',
].join('\n');

/** agentPresets 服务的最小形状（本模块只用到 register）。 */
export interface AgentPresetsService {
  register(definition: {
    id: string;
    name?: string;
    description?: string;
    order?: number;
    plugins: Array<Record<string, unknown>>;
  }): Promise<() => void | Promise<void>>;
}

/** 预设定义（entry-list 方言，与 YAML 同形）。 */
export interface ReadingAssistantPreset {
  id: string;
  name: string;
  description: string;
  order: number;
  plugins: Array<Record<string, unknown>>;
}

/**
 * 构造预设定义（纯函数，便于自测断言形状而不需要真宿主）。
 * @returns entry-list 方言的预设定义。
 */
export function buildReadingAssistantPreset(): ReadingAssistantPreset {
  return {
    id: READING_ASSISTANT_PRESET_ID,
    name: READING_ASSISTANT_PRESET_NAME,
    description: READING_ASSISTANT_PRESET_DESCRIPTION,
    // 排在其它预设之后，不抢默认位（默认 preset 由用户的 `default` 配置决定，插件不该改）。
    order: 90,
    plugins: [
      {
        // 本插件自己的提示词段入口：在 agent 作用域里贡献一段系统提示词。
        name: SELF_PACKAGE_NAME,
        config: { promptSectionOnly: true, promptText: READING_ASSISTANT_PROMPT },
      },
    ],
  };
}

/** 注册结果（供日志与自测断言）。 */
export type PresetRegistrationOutcome =
  | { registered: true; id: string; settle(): Promise<void> }
  | { registered: false; reason: string };

/**
 * 把「阅读助手」预设注册进宿主。
 *
 * @param getService - `ctx.get` 包装（可选服务，取不到就返回 undefined）
 * @param warn - 日志出口
 * @returns 注册结果；**任何失败都只降级为「少一个预设」，绝不抛出**
 */
export function registerReadingAssistantPreset(
  getService: (name: string) => unknown,
  warn: (error: unknown) => void,
): PresetRegistrationOutcome {
  let service: AgentPresetsService | undefined;
  try {
    const candidate = getService('agentPresets');
    if (
      candidate !== undefined &&
      candidate !== null &&
      typeof (candidate as AgentPresetsService).register === 'function'
    ) {
      service = candidate as AgentPresetsService;
    }
  } catch (error) {
    warn(error);
    return { registered: false, reason: '读取 agentPresets 服务失败' };
  }
  if (service === undefined) {
    // 宿主没装 preset 注册表：正常配置，不是错误，但要留下可查日志。
    warn('reading-workbench: 宿主未提供 agentPresets，跳过「阅读助手」预设（不影响书架与阅读）');
    return { registered: false, reason: '宿主未提供 agentPresets 服务' };
  }

  const definition = buildReadingAssistantPreset();
  let dispose: (() => void | Promise<void>) | undefined;

  // ⚠️ `service.register(definition)` 是**同步调用**：如果它同步抛（实测生产实现就会，
  // 例如 `Duplicate agent preset: <id>`、id 为空），异常会直接穿过本函数，
  // 在它后面接的 `.then(onRejected)` **根本来不及挂上**。
  // 这是自测抓到的真缺陷 —— 必须先用 try/catch 把同步抛出收进 pending，
  // 再把返回的 promise 接到同一条链上，两条失败路径才能归一。
  let called: Promise<() => void | Promise<void>>;
  try {
    called = service.register(definition);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(error);
    warn(`reading-workbench: 「阅读助手」预设注册被同步拒绝（${message}），其余功能不受影响`);
    return { registered: false, reason: `注册同步抛错：${message}` };
  }

  // register 是 async；apply 必须同步返回（cordis 契约），所以不 await，
  // 把落定过程收敛到 settle() 交给 effect 的 cleanup 等待。
  const pending: Promise<void> = called.then(
    (disposer) => {
      dispose = disposer;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      warn(error);
      warn(`reading-workbench: 「阅读助手」预设注册失败（${message}），其余功能不受影响`);
    },
  );

  return {
    registered: true,
    id: definition.id,
    /** 等待注册落定并注销（由 effect cleanup 调用）。 */
    settle: async (): Promise<void> => {
      await pending;
      if (dispose !== undefined) await dispose();
    },
  };
}
