/**
 * reading-workbench — Host 半入口。
 * 职责：注册 /api/reading-workbench/* 路由族（书架 / 进度 / 划线的 REST 面）
 * 与 Agent 工具（书目检索 / 划线查询 / 正文节选）。
 * 浏览器半（./client）渲染阅读工作台面板。
 */
import { resolveStorePaths } from './store.ts';
import { makeRoutes } from './http.ts';
import { registerReadingTools } from './tools.ts';
import { registerReadingAssistantPreset } from './agent-preset.ts';
import { applyPromptSection } from './prompt-section.ts';
import type { FetchHtml, FetchedPage } from './web-source.ts';
import { builtinFetchHtml } from './web-fetch-fallback.ts';

// ── 供自测导入的内部符号（tsdown 会把内联模块私有化，自测只能从入口拿）──
// 这些不是插件对外契约的一部分：宿主只认 name / inject / apply。
export {
  buildReadingAssistantPreset,
  registerReadingAssistantPreset,
  READING_ASSISTANT_PRESET_ID,
  READING_ASSISTANT_PROMPT,
} from './agent-preset.ts';
export { applyPromptSection, PROMPT_SECTION_ORDER, PROMPT_SECTION_NAME } from './prompt-section.ts';

/** 稳定 cordis 插件名。 */
export const name = 'reading-workbench';

/** 路由挂载需要的服务（fiber inject 等待，运行时就绪后才 apply）。 */
//
// 为什么 **不** 把 'web' 写进 inject：
// cordis 对「inject 里声明了、但当前没有任何插件提供」的服务，会把 fiber 停在
// **pending**（state=0），等提供者出现 —— 结果是本插件的 14 条 REST 路由一条都不注册，
// 用户看到的是「整个阅读工作台 404」，而不是「少一个网页书源功能」。
// 实测：沙箱契约自测环境未装配 `dsh-web` 时，`inject: ['webServer','tools','web']`
// 直接让 fiber state=0、routes=0。
// 因此 `web` 改用 `ctx.get('web')` 取（宿主 sandboxContext 显式放行 `get`，且不校验 inject），
// 取不到就只少网页书源 —— 与 `tools` 的降级纪律一致。
export const inject = ['webServer', 'tools'];

/**
 * `ctx.web` 服务的最小形状（本插件只用到 `fetch`）。
 *
 * 真实契约见 `@deepseek-ai/dsh-web`：`fetch(request, signal?)` 返回
 * `{ url, statusCode, body: { kind: 'html' | 'text', content }, truncated }`，
 * 非 2xx 是**结果**而不是异常。
 */
interface WebService {
  fetch(
    request: { url: string },
    signal?: unknown,
  ): Promise<{
    url?: string;
    statusCode?: number;
    body?: { kind?: string; content?: string };
    truncated?: boolean;
  }>;
}

/**
 * 挂载路由族与 Agent 工具。
 *
 * 失败纪律：apply 在 DSH 的 vm 沙箱里执行，任何顶层抛错都会让整条 Host 半
 * 变成 failed（所有 REST 路由 404）。沙箱里**没有 `process`、没有 `Buffer`**，
 * 所以数据目录只从配置 / ctx 服务里取，绝不读 `process.env`。
 * @param ctx - Host 插件上下文（服务：webServer、tools；可选 via ctx.get：web）。
 * @param config - 插件配置（可覆盖 dshHome / 数据目录 / 抓取通道）。
 */
export function apply(ctx: {
  webServer: { register(route: unknown): () => void };
  tools: { register(definition: unknown): () => void };
  logger: { warn(error: unknown): void };
  effect(fn: () => () => void, label?: string): () => void;
  get?(name: string): unknown;
}, config?: {
  dshHome?: string;
  enabled?: boolean;
  webFetchMode?: 'auto' | 'host' | 'builtin';
  /**
   * 只贡献「阅读助手」提示词段、不注册路由与工具。
   * 由「阅读助手」预设的 plugins 行设置（见 agent-preset.ts）；
   * 正常安装时恒为 false，行为与此前完全一致。
   */
  promptSectionOnly?: boolean;
  /** 提示词段正文（仅 promptSectionOnly 时有意义）。 */
  promptText?: string;
}): void {
  if (config?.enabled === false) return;

  // 预设内的「提示词段」分支：同一份产物被预设以 agent 作用域再次挂载时走到这里。
  // 必须**先于**一切路由/工具/存储代码返回，否则会被重复注册一遍。
  if (config?.promptSectionOnly === true) {
    applyPromptSection(ctx, { promptText: config.promptText });
    return;
  }

  const paths = resolveStorePaths(config?.dshHome ?? resolveDshHome(ctx));

  // 网页抓取通道。
  //
  // 两条通道，按 `webFetchMode` 选择：
  // - `host`   ：宿主 `ctx.web.fetch`（带 SSRF 防护、地址固定等完整策略）；
  // - `builtin`：插件内置受限 HTTPS 抓取器（https + 域名白名单 + 同源跳转，
  //              见 web-fetch-fallback.ts），不依赖任何 provider 配置；
  // - `auto`（默认）：优先宿主；宿主通道不可用时**自动落到内置**。
  //
  // 为什么 auto 要回退而不是直接报错：dsh-web 默认同时注册 `http` 与 `deepseek-fetch-api`
  // 两个抓取提供方，`fetchProvider` 一旦未固定，每次调用都抛 WEB_PROVIDER_AMBIGUOUS ——
  // 那会让「网页书源」整个功能不可用，而错误看起来还像站点问题（实测踩到过）。
  // 回退后功能可用，同时把真实原因写进宿主日志，不掩盖问题。
  //
  // 与 ctx.tools 同一套纪律：读取放在 effect 之外、显式 try/catch；
  // `web` 不能写进 inject（服务缺失会让 fiber 停在 pending、全部路由消失）。
  const webFetchMode = config?.webFetchMode ?? 'auto';
  let webService: WebService | undefined;
  try {
    const candidate = typeof ctx.get === 'function' ? (ctx.get('web') as WebService | undefined) : undefined;
    if (candidate !== undefined && candidate !== null && typeof candidate.fetch === 'function') {
      webService = candidate;
    }
  } catch (error) {
    ctx.logger.warn(error);
    ctx.logger.warn('reading-workbench: 读取 ctx.web 失败');
  }
  if (webFetchMode === 'host' && webService === undefined) {
    ctx.logger.warn('reading-workbench: webFetchMode=host 但 ctx.web 不可用，网页书源将不可用');
  }

  /** 是否已放弃宿主通道（auto 回退后置位，避免每次请求都白跑一次失败调用）。 */
  let hostAbandoned = webService === undefined || webFetchMode === 'builtin';

  /** 从宿主通道取一页。 */
  const viaHost = async (url: string): Promise<FetchedPage> => {
    const service = webService;
    if (service === undefined) throw new Error('宿主抓取通道不可用');
    const result = await service.fetch({ url });
    const status = result.statusCode ?? 0;
    const body = result.body;
    if (status !== 0 && (status < 200 || status >= 300)) {
      throw new Error(`抓取失败：目标返回 HTTP ${status}（${url}）`);
    }
    if (body === undefined || typeof body.content !== 'string') {
      throw new Error(`抓取失败：返回体为空（${url}）`);
    }
    if (body.kind !== 'html') {
      // 远端抓取后端（deepseek-fetch-api）只返回 Markdown，CSS 选择器方案会失效。
      // 这是**通道选择**问题而不是站点问题 ⇒ 交给上层决定是否回退到内置抓取。
      const error = new Error('宿主抓取后端返回的是纯文本而非 HTML');
      (error as Error & { code?: string }).code = 'HOST_FETCH_NOT_HTML';
      throw error;
    }
    return { html: body.content, truncated: result.truncated === true };
  };

  /** 这个宿主通道错误是否意味着「这条通道不能用了」。 */
  const isChannelFailure = (error: unknown): boolean => {
    const code = (error as { code?: unknown } | null)?.code;
    return (
      code === 'HOST_FETCH_NOT_HTML' ||
      code === 'WEB_PROVIDER_AMBIGUOUS' ||
      code === 'WEB_PROVIDER_UNAVAILABLE' ||
      code === 'WEB_PROVIDER_CONFIGURED_MISSING' ||
      code === 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' ||
      code === 'WEB_PROVIDER_CREDENTIAL_MISSING'
    );
  };

  let fetchHtml: FetchHtml | undefined;
  if (webFetchMode === 'builtin' || webService !== undefined) {
    fetchHtml = async (url: string): Promise<FetchedPage> => {
      if (!hostAbandoned) {
        try {
          return await viaHost(url);
        } catch (error) {
          if (webFetchMode === 'host' || !isChannelFailure(error)) throw error;
          hostAbandoned = true;
          const code = (error as { code?: string }).code ?? '未知原因';
          ctx.logger.warn(
            `reading-workbench: 宿主抓取通道不可用（${code}），已自动切换到插件内置抓取通道。` +
              '若想用宿主通道，请在 profile 的 cordis.patch.yml 里为 dsh-web 设置 fetchProvider: http。',
          );
        }
      }
      // 内置通道不受 provider 的字符上限约束，目录页能一次抓全，因此恒为 truncated: false。
      return { html: await builtinFetchHtml(url), truncated: false };
    };
  }

  /**
   * 补充通道：插件内置抓取器（不受 provider 的 100,000 字符上限约束）。
   *
   * 只在「目录页被抓取后端截断」时用来重抓一次完整目录 —— 否则用户会得到一本
   * 「947 章」的伪完整书（真实 1221 章）。章节抓取仍走上面选定的主通道。
   */
  const supplementFetchHtml: FetchHtml = async (url: string): Promise<FetchedPage> => ({
    html: await builtinFetchHtml(url),
    truncated: false,
  });

  const routes = makeRoutes({
    paths,
    logger: { warn: (error) => ctx.logger.warn(error) },
    fetchHtml,
    supplementFetchHtml,
  });
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'reading-workbench: routes');

  // Agent 工具（M2）。
  //
  // 关键约束（两次线上 failed 换来的）：
  // 1. `inject` 必须声明 `tools`。宿主 sandboxContext 的 Proxy 在 `has` 里故意把
  //    `tools` 报成永远存在，读它却要求 inject 声明过 —— 于是 `if (ctx.tools === undefined)`
  //    这类判空写法永远走不到，直接抛 `cannot get property "tools" without inject`。
  // 2. `ctx.tools` 的读取必须放在**显式 try/catch** 里，且不能放在 effect 回调里：
  //    effect 回调抛错会被 cordis 记成整条 fiber FAILED，try/catch 挡不住。
  //    先取出服务引用，取不到就只少三个工具，书架与阅读不受影响。
  let tools: { register(definition: unknown): () => void } | undefined;
  try {
    tools = ctx.tools;
  } catch (error) {
    ctx.logger.warn(error);
    ctx.logger.warn('reading-workbench: ctx.tools 不可用，跳过 Agent 工具注册（不影响书架与阅读）');
  }
  if (tools !== undefined) {
    const toolsService = tools;
    ctx.effect(
      () => registerReadingTools({ tools: toolsService }, paths),
      'reading-workbench: agent tools',
    );
  }

  // 「阅读助手」Agent 预设（M2 收尾）。
  //
  // 与 tools / web 同一套可选服务纪律：`ctx.get('agentPresets')` 取，读不到就只少一个预设。
  // **绝不能**写进 `inject` —— 宿主没装 preset 注册表时 cordis 会把 fiber 停在 pending，
  // 本插件全部 REST 路由一条都不注册（`web` 那次事故的同一条教训）。
  //
  // 预设里的插件行引用的是**本包**（dsh-reading-workbench），通过 config 走
  // `prompt-section.ts` 的 `promptSectionOnly` 分支；主入口 apply 看到该 config 会在开头
  // 直接 return，不会重复注册路由与工具（见 apply 开头的守卫）。
  {
    const getService = (name: string): unknown =>
      typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    const warn = (error: unknown): void => {
      ctx.logger.warn(error);
    };
    try {
      const outcome = registerReadingAssistantPreset(getService, warn);
      if (outcome.registered) {
        ctx.effect(
          () => {
            return () => {
              // 清理是异步的（register 返回 Promise），但 effect cleanup 必须同步返回：
              // 这里发起注销并在失败时只记日志，不抛出（抛在 cleanup 里同样会把 fiber 记成 FAILED）。
              void outcome.settle().catch(warn);
            };
          },
          'reading-workbench: agent preset',
        );
      }
    } catch (error) {
      // entryListProblem 等发生在 activate 的 try 之外，外层必须自己兜住。
      ctx.logger.warn(error);
      ctx.logger.warn('reading-workbench: 「阅读助手」预设挂载异常，其余功能不受影响');
    }
  }
}

/**
 * 解析 DSH 数据根目录。
 *
 * 只用 `ctx.get`（宿主沙箱的 Proxy 对 `get` 不做 inject 校验，可直接用）。
 * 不产生 cordis 告警，也不需要把 sandbox/storage/workspace 塞进 inject。
 * 拿不到就返回 undefined，由 store 回落 `~/.dsh`。全程不碰 `process`。
 * @param ctx - Host 插件上下文。
 * @returns DSH 数据根目录绝对路径。
 */
function resolveDshHome(ctx: { get?(name: string): unknown }): string | undefined {
  if (typeof ctx.get !== 'function') return undefined;
  for (const serviceName of ['sandbox', 'storage', 'workspace']) {
    let service: unknown;
    try {
      service = ctx.get(serviceName);
    } catch {
      continue;
    }
    if (service === null || typeof service !== 'object') continue;
    const candidate = service as { dshHome?: unknown; dataDir?: unknown; homeDir?: unknown };
    const value = candidate.dshHome ?? candidate.dataDir ?? candidate.homeDir;
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}
