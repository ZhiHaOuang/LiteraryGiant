/**
 * Browser-half entry for the reading-workbench plugin — runs inside the dsh web GUI.
 *
 * Registers the locale dictionaries and mounts the workbench as a native
 * center-column page: a row in the shell's sidebar panel list and a keyed
 * `main` page, both through the official slot seats. Failure policy:
 * registration problems are logged, never thrown — the web shell fails the
 * whole boot when a plugin apply throws, and an external plugin must not take
 * the GUI down.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
// 类型增强：把 ctx.locale / ctx.slots 与槽位类型挂进 Context / SlotMap
// （type-only，不产生运行时依赖；增强声明在两包的 /client 子入口，根入口是 Host 侧类型）。
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
// 词典命名空间：向 LocaleNamespaceMap 注册本插件自有 NS（skill-explorer 同款写法）。
import type { WorkbenchKey } from './locales.ts';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 阅读工作台界面文案。 */
    'dsh-reading-workbench': WorkbenchKey;
  }
}
import { WorkbenchApi } from './api.ts';
import { en, zh } from './locales.ts';
import { STYLE_ID, STYLES } from './styles.ts';
import { WorkbenchPage } from './panel/WorkbenchPage.tsx';

/** Locale namespace this plugin owns. */
const NS = 'dsh-reading-workbench';

/** 面板 id：sidebar 行与 main 页共用。 */
const PANEL_ID = 'reading';

/** 侧边栏排序（放在会话之后，不抢首位）。 */
const PANEL_ORDER = 50;

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale', 'layout'];

/** 图标（16px 线性书形）。 */
function WorkbenchIcon({ size }: { size?: number }) {
  return (
    <svg
      data-dsh-panel-entry={PANEL_ID}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3.2C6.6 2 4.5 2 3 2v10.5c1.5 0 3.6 0 5 1.3 1.4-1.3 3.5-1.3 5-1.3V2c-1.5 0-3.6 0-5 1.2z" />
      <path d="M8 3.2v10.6" />
    </svg>
  );
}

/** 主面板页包装（带语义锚点）。 */
function WorkbenchPanelPage(props: { api: WorkbenchApi; t: (key: WorkbenchKey) => string }) {
  return (
    <div className="dsh-reading-page" data-dsh-reading-view="">
      <WorkbenchPage api={props.api} t={props.t} />
    </div>
  );
}

/**
 * Mount the workbench surfaces.
 * @param ctx - client root context (services: slots, locale, layout).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en });
    } catch (error) {
      console.error('reading-workbench: locale register failed', error);
      return () => {};
    }
  }, 'reading-workbench: dictionaries');

  // 词典按当前语言取（document-language pick，与 skill-explorer 同法）。
  const dictionary = (): Record<WorkbenchKey, string> => {
    const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh';
    return (lang ?? 'zh').toLowerCase().startsWith('zh') ? zh : en;
  };
  const t = (key: WorkbenchKey): string => dictionary()[key] ?? key;

  const api = new WorkbenchApi();
  const slots = ctx.slots;
  const disposers: Array<() => void> = [];

  // 两个 seat 都由 shell 插件声明（本包不与其建立运行时硬依赖），
  // 用 ctx.slots.inject 包裹：owner 未声明时面板缺席而不是启动失败。
  disposers.push(
    slots.inject('sidebar.panellist', () =>
      slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => t('entry.label') },
        WorkbenchIcon,
      ),
    ),
  );
  disposers.push(
    slots.inject('main', () =>
      slots.register(
        {
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ api, t }),
        },
        WorkbenchPanelPage,
      ),
    ),
  );

  // 插件样式：全部走主题 token，选择器加 dsh-reading- 前缀（样式文本在 ./styles.ts）。
  ctx.effect(() => {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLES;
    document.head.append(style);
    return () => {
      style.remove();
    };
  }, 'reading-workbench: styles');

  ctx.effect(() => {
    return () => {
      for (const dispose of disposers.splice(0)) dispose();
    };
  }, 'reading-workbench: slots');
}
