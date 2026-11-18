/**
 * 书内 CSS 作用域化（纯函数，便于单测）。
 *
 * ## 为什么需要它
 *
 * EPUB 的排版层次只写在书内 CSS 里。calibre 这类转换工具产出的中文书，
 * 正文标题常常是 `<p class="calibre_1"><span class="calibre5"><span class="bold">…</span></span></p>`，
 * 一个 `<h1>` 都没有（2026-10-19 实测书库 23 本 epub，0 本每章都带语义标题）。
 * 于是样式表一丢，标题与正文就完全相同 —— 用户看到的「文字全都是一样的」。
 *
 * ## 两条硬约束
 *
 * 1. **必须作用域化**：书内选择器（`.calibre_1`、`p`、`body`）是全局的，
 *    原样注入会污染整个 DSH GUI（改掉设置面板、侧边栏的样式）。
 *    这里给每条选择器加 `${scope} ` 前缀，把影响面锁进正文容器。
 * 2. **必须过滤属性**：书内 CSS 里有固定宽高（`.calibre_9{height:587px;width:939px}`）、
 *    `position` / `float` / `display:none` / `column-*` / `break-*` 之类，
 *    套到阅读器的 CSS 多栏分页器上会直接把排版量坏（翻页错位、内容被藏）。
 *
 * ## 刻意丢弃的属性（每条都有原因，不要随手加回来）
 *
 * - `line-height` / `font-size` 的绝对单位：字号与行距是阅读器设置的承诺，
 *   书内 CSS 一旦用固定值覆盖，"改字号没反应"就会变成一个查不出的 bug。
 *   `font-size` 只接受相对单位（`em` / `%` / 关键字），它能表达"标题比正文大"却不锁定绝对值。
 * - `color` / `background-color`：书内写死的黑字白底在暗色主题下直接不可读。
 * - `position` / `width` / `height` / `float` / `overflow` / `column-*` / `break-*` / `display:none`：
 *   布局类属性，与 CSS 多栏分页冲突；`break-inside: avoid` 会让长段落跨不了屏。
 * - `@font-face` / `@import` / `@keyframes` / `@page` / `@media print`：字体不该被书绑定，
 *   导入不递归（被引用的表会被 Host 单独收集），动画与打印规则与阅读器无关。
 */

/** 作用域化选项。 */
export interface ScopeCssOptions {
  /** 作用域根选择器（如 `.dsh-reading-flow`）。 */
  scope: string;
  /**
   * 是否丢弃 `font-family`。
   * 用户选了具体字体时必须为 true：书内规则特异性更高，会盖掉用户选择，
   * 表现为「设置里换了字体但正文纹丝不动」。
   */
  dropFontFamily: boolean;
}

/**
 * 正文容器选择器。
 * 必须与 `FlowReader` 内层容器的 class 一致，否则书内规则挂到无匹配元素上、静默失效。
 */
export const BOOK_CSS_SCOPE = '.dsh-reading-flow';

/** 允许进入正文的**非族**属性（完整属性名，小写）。 */
const ALLOWED_PROPERTIES = new Set([
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-indent',
  'text-transform',
  'text-decoration',
  'text-decoration-line',
  'text-decoration-style',
  'vertical-align',
  'white-space',
  'word-break',
  'overflow-wrap',
  'hyphens',
  'list-style-type',
  'list-style-position',
  'display',
]);

/** 允许的属性族（`margin-top` 这类按前缀放行）。 */
const ALLOWED_PREFIXES = ['margin', 'padding'];

/** `font-size` 允许的单位（相对单位；绝对单位会锁死用户的字号设置）。 */
const RELATIVE_FONT_SIZE = /^\s*(?:\d*\.?\d+(?:em|rem|%|ex|ch)|larger|smaller|inherit)\s*(?:!important)?\s*$/i;

/** `display` 允许的取值（排除 none / flex / grid 这类会藏内容或改变布局的值）。 */
const ALLOWED_DISPLAY = /^(?:block|inline|inline-block|inherit)$/i;

/** 字符串/注释感知的扫描：跳过一段字面量，返回其后的下标。 */
function skipLiteral(text: string, start: number): number {
  const ch = text[start];
  if (ch === '"' || ch === "'") {
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i] === ch) return i + 1;
      i += 1;
    }
    return i;
  }
  if (ch === '/' && text[start + 1] === '*') {
    const end = text.indexOf('*/', start + 2);
    return end === -1 ? text.length : end + 2;
  }
  return start;
}

/** 去掉注释（字符串内的 `/*` 不动）。 */
export function stripCssComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    const next = skipLiteral(css, i);
    if (next !== i) {
      out += css.slice(i, next);
      i = next;
      continue;
    }
    out += css[i];
    i += 1;
  }
  return out;
}

/** 一条原始规则：`prelude` 是选择器或 at-rule 头；`body` 为 undefined 表示语句（`@import …;`）。 */
export interface RawCssRule {
  prelude: string;
  body?: string;
}

/**
 * 把 CSS 文本切成顶层规则。
 * 支持嵌套（`@media { … }` 里的规则），嵌套层次靠花括号配对还原。
 */
export function splitCssRules(css: string): RawCssRule[] {
  const rules: RawCssRule[] = [];
  let i = 0;
  const text = stripCssComments(css);
  while (i < text.length) {
    // 跳空白
    while (i < text.length && /\s/.test(text[i] ?? '')) i += 1;
    if (i >= text.length) break;
    // 读 prelude 到 { 或 ;
    let prelude = '';
    let terminator: '{' | ';' | '' = '';
    while (i < text.length) {
      const next = skipLiteral(text, i);
      if (next !== i) {
        prelude += text.slice(i, next);
        i = next;
        continue;
      }
      const ch = text[i];
      if (ch === '{' || ch === ';') {
        terminator = ch;
        i += 1;
        break;
      }
      prelude += ch;
      i += 1;
    }
    const head = prelude.trim();
    if (terminator === ';' || terminator === '') {
      if (head !== '') rules.push({ prelude: head });
      continue;
    }
    // 读 body：花括号配对（字符串/注释已跳过）
    let depth = 1;
    let body = '';
    while (i < text.length && depth > 0) {
      const next = skipLiteral(text, i);
      if (next !== i) {
        body += text.slice(i, next);
        i = next;
        continue;
      }
      const ch = text[i];
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
      body += ch;
      i += 1;
    }
    if (head !== '') rules.push({ prelude: head, body });
  }
  return rules;
}

/** 按分隔符切分，但忽略括号/方括号/字符串里的分隔符（选择器与声明的切分共用）。 */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const next = skipLiteral(text, i);
    if (next !== i) {
      current += text.slice(i, next);
      i = next;
      continue;
    }
    const ch = text[i];
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** 文档根类选择器：`html` / `body` / `:root`（可带类/伪类），它们在渲染 DOM 里不存在。 */
const ROOT_SELECTOR = /^(?:html|body|:root)(?:[.#][\w-]+|:[\w-]+(?:\([^)]*\))?)*$/i;

/**
 * 作用域化单条选择器。
 * @returns 作用域化后的选择器；`undefined` 表示这条选择器应当整条丢弃。
 */
export function scopeSelector(selector: string, scope: string): string | undefined {
  const sel = selector.trim();
  if (sel === '') return undefined;
  // CRC / `from` 之类不该出现在这里；防御性丢弃
  if (/^(?:from|to|\d+%)$/i.test(sel)) return undefined;

  // 整条就是 html/body/:root（可带类）：目标元素在渲染 DOM 中不存在，
  // 硬挂到作用域根上会把 body 的字体/边距语义错套到正文容器，直接丢弃。
  if (ROOT_SELECTOR.test(sel)) return undefined;

  // `body p` / `html body .x` 这类：剥掉根段，再按后代作用域化
  const tokens = splitSelectorTokens(sel);
  let start = 0;
  while (start < tokens.length && ROOT_SELECTOR.test(tokens[start] ?? '')) start += 1;
  if (start >= tokens.length) return undefined;
  const rest = tokens.slice(start).join(' ');
  if (rest === '') return undefined;

  // 复合/后代都加前缀：`.scope .a > .b`
  return `${scope} ${rest}`;
}

/**
 * 按「组合符」切分选择器（后代、子代、兄弟），组合符本身作为独立 token 保留。
 * 例：`body > p.x + span` → ['body', '>', 'p.x', '+', 'span']
 */
function splitSelectorTokens(selector: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let i = 0;
  const flush = (): void => {
    if (current.trim() !== '') tokens.push(current.trim());
    current = '';
  };
  while (i < selector.length) {
    const next = skipLiteral(selector, i);
    if (next !== i) {
      current += selector.slice(i, next);
      i = next;
      continue;
    }
    const ch = selector[i] ?? '';
    if (ch === '>' || ch === '+' || ch === '~') {
      flush();
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      // 后代组合符：只 flush 当前 token，不把空格本身收进 token 列表 ——
      // 列表补 `join(' ')` 时会自然重建出「后代」语义（见 scopeSelector）。
      let j = i;
      while (j < selector.length && /\s/.test(selector[j] ?? '')) j += 1;
      flush();
      i = j;
      continue;
    }
    current += ch;
    i += 1;
  }
  flush();
  return tokens.filter((token) => token !== '');
}

/** 属性是否放行。 */
function isAllowedProperty(prop: string): boolean {
  if (ALLOWED_PROPERTIES.has(prop)) return true;
  return ALLOWED_PREFIXES.some((prefix) => prop === prefix || prop.startsWith(prefix + '-'));
}

/**
 * 过滤一条声明。
 * @returns 可保留的声明原文；`undefined` 表示丢弃。
 */
export function filterDeclaration(declaration: string, options: ScopeCssOptions): string | undefined {
  const colon = declaration.indexOf(':');
  if (colon <= 0) return undefined;
  const prop = declaration.slice(0, colon).trim().toLowerCase();
  const value = declaration.slice(colon + 1).trim();
  if (value === '' || !isAllowedProperty(prop)) return undefined;

  // 族级特例
  if (prop === 'font-family') return options.dropFontFamily ? undefined : declaration.trim();
  if (prop === 'font-size') {
    // 绝对单位（px/pt/cm…）会锁死用户字号设置，只放行相对单位
    return RELATIVE_FONT_SIZE.test(value) ? declaration.trim() : undefined;
  }
  if (prop === 'display') {
    return ALLOWED_DISPLAY.test(value.replace(/\s*!important\s*$/i, '')) ? declaration.trim() : undefined;
  }
  // 值里带 url() 的一律丢弃：本白名单内属性不应引用外部资源，
  // 出现即说明书内 CSS 有非常规写法，保守起见不引入。
  if (/url\s*\(/i.test(value)) return undefined;
  return declaration.trim();
}

/** 书内样式留在正文里的 CSS 变量/字体声明数量上限（防止异常表把产物撑爆）。 */
const MAX_OUTPUT_CHARS = 512 * 1024;

/**
 * 把书内 CSS 转成「只影响正文容器」的安全样式表。
 *
 * @param css - 书内样式表原文（多份已由 Host 合并）。
 * @param options - 作用域与字体策略。
 * @returns 作用域化后的 CSS 文本；空串表示**没有可用规则**，调用方应走统一美化。
 */
export function scopeBookCss(css: string, options: ScopeCssOptions): string {
  const processRules = (source: string): string[] => {
    const result: string[] = [];
    for (const rule of splitCssRules(source)) {
      const prelude = rule.prelude.trim();
      if (prelude.startsWith('@')) {
        if (rule.body === undefined) continue; // @import / @charset / @namespace
        const atName = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
        // 只递归「包裹型」at-rule；@font-face / @keyframes / @page 一律丢弃
        if (atName !== 'media' && atName !== 'supports' && atName !== 'layer') continue;
        // 打印样式在屏幕上无意义（且常含固定尺寸）
        if (atName === 'media' && /\bprint\b/i.test(prelude) && !/\b(?:screen|all)\b/i.test(prelude)) continue;
        const inner = processRules(rule.body);
        if (inner.length === 0) continue;
        result.push(`${prelude} {\n${inner.join('\n')}\n}`);
        continue;
      }
      if (rule.body === undefined) continue;
      const declarations = splitTopLevel(rule.body, ';')
        .map((declaration) => filterDeclaration(declaration, options))
        .filter((declaration): declaration is string => declaration !== undefined);
      if (declarations.length === 0) continue;
      const selectors = splitTopLevel(prelude, ',')
        .map((selector) => scopeSelector(selector, options.scope))
        .filter((selector): selector is string => selector !== undefined);
      if (selectors.length === 0) continue;
      result.push(`${selectors.join(', ')} { ${declarations.join('; ')}; }`);
    }
    return result;
  };

  const blocks = processRules(css);
  const text = blocks.join('\n');
  // 上限保护：异常大的表（或写出成吨规则）截到上限，宁可少几条也不让 DOM 里塞进巨型样式
  return text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) : text;
}
