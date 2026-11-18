/**
 * 「阅读助手」预设的提示词段贡献。
 *
 * ## 为什么需要这个文件
 *
 * `@deepseek-ai/dsh-system-prompt` 的 config **没有** 文本字段
 * （实测只有 `includeHarnessIdentity / includeRuntimeContext / personaPrefix /
 * personaSuffix / toolOrder`），所以「往系统提示词加一段」只能靠
 * `ctx.systemPrompt.section({ name, order, text })` 从**插件代码**里注册。
 *
 * ## 为什么挂在 agent 作用域，而不是主入口
 *
 * 主入口 `index.ts` 是全局 Host 插件，它注册的段对每个会话都生效；
 * 而「阅读助手纪律」只应出现在选了该预设的 agent 里。
 * 因此预设的 `plugins` 行引用**本包自己**，带 `promptSectionOnly: true` 再挂一次 ——
 * 主入口 apply 在开头看到该标记就转到这里并 return，只贡献提示词段。
 *
 * ## 契约（来自 `dsh-system-prompt/lib/index.js` 实测）
 *
 * ```js
 * section(section) {
 *   if (!Number.isFinite(section.order)) throw new TypeError(...);
 *   return this.layers.effect(this.ctx, (layer) => layer.sections.insert(section.name, section),
 *                             { label: "systemPrompt.section()" });
 * }
 * ```
 *
 * 返回的是**精确的 Cordis effect disposer**，所以它本身就不再需要一个外层 `ctx.effect` 包着 ——
 * 直接把它交给调用方的 `ctx.effect` 即可（重复包裹只会多一层清理，语义相同）。
 *
 * 段按 order 升序拼接：第一方环境类段在 `10000`~`10200`，可选上下文更靠后。
 * 这里取 `9000`，落在「第一方指导之后、环境信息之前」，不与任何第一方段抢位。
 */

/** 本段的顺序值（第一方指导之后、环境信息 10000 之前）。 */
export const PROMPT_SECTION_ORDER = 9000;

/** 本段的稳定名称。 */
export const PROMPT_SECTION_NAME = 'reading-workbench:assistant';

/** 系统提示词服务的最小形状（本模块只用到 section）。 */
interface SystemPromptService {
  section(definition: { name: string; order: number; text: string; interpolate?: boolean }): () => void;
}

/** 可被主入口复用的上下文形状。 */
interface PromptContext {
  logger: { warn(error: unknown): void };
  effect(fn: () => () => void, label?: string): () => void;
  get?(name: string): unknown;
}

/** 提示词段配置。 */
export interface PromptSectionConfig {
  /** 段正文；为空时跳过（只记日志，不抛）。 */
  promptText?: string;
}

/**
 * 在**当前作用域**贡献一段阅读助手提示词。
 *
 * 失败纪律：取不到 `systemPrompt` 或正文为空，都只记日志、不抛错 ——
 * 这里抛出去会让预设激活失败（虽然注册表会兜住，但没必要制造一次失败）。
 *
 * @param ctx - 当前作用域上下文（预设内即 agent 作用域）
 * @param config - 段配置
 */
export function applyPromptSection(ctx: PromptContext, config?: PromptSectionConfig): void {
  const text = config?.promptText ?? '';
  if (text === '') {
    ctx.logger.warn('reading-workbench: 提示词段缺少 promptText，跳过');
    return;
  }

  let systemPrompt: SystemPromptService | undefined;
  try {
    const candidate = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined;
    if (
      candidate !== undefined &&
      candidate !== null &&
      typeof (candidate as SystemPromptService).section === 'function'
    ) {
      systemPrompt = candidate as SystemPromptService;
    }
  } catch (error) {
    ctx.logger.warn(error);
  }
  if (systemPrompt === undefined) {
    ctx.logger.warn('reading-workbench: 宿主未提供 systemPrompt，「阅读助手」将以无附加提示词运行');
    return;
  }

  const service = systemPrompt;
  ctx.effect(
    () =>
      service.section({
        name: PROMPT_SECTION_NAME,
        order: PROMPT_SECTION_ORDER,
        // 原文不做变量插值：正文里若有 `{{...}}` 会被当成变量引用，
        // 而解析失败会让**整个提示词组装**失败（见 README 的严格规则）。
        interpolate: false,
        text,
      }),
    'reading-workbench: prompt section',
  );
}
