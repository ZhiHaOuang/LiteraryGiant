/**
 * Agent 工具（M2）：把书架/划线/正文接进 DSH 会话。
 *
 * 注册契约来自对 `@deepseek-ai/dsh-tools@0.1.0-rc.6` 的 `defineTool` 的实测还原：
 * `ctx.tools.register(tool)` 收到的对象形态是
 * `{ name, description, parameters(JSON Schema 对象根), output: { schema, render }, execute }`。
 *
 * 为什么不直接 import `defineTool`：dsh-tools 0.1.0-rc.6 的 ESM 依赖
 * `@deepseek-ai/dsh-llm` 的 `CallId` 导出，而本机运行时的 dsh-llm 0.2.0-rc.2
 * 已改名为 `ToolCallId` —— 版本族错位会让插件在启动时直接炸掉宿主。
 * defineTool 本体只是「schema 编译 + 参数校验包装」的纯数据变换，
 * 这里按同形态自实现，并保留参数校验（非法参数抛 ToolArgsError 同名错误）。
 *
 * 设计取舍：
 * - 工具**只读**：不提供写入/删除入口（划线由人类在 GUI 里做），避免 Agent 污染书库；
 * - 正文按字符区间取片段并限制单次长度，防止整本书灌进上下文；
 * - 全部实现直接读 store.ts 的数据（Host 半同进程），无 HTTP 自调用。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bookDir, loadData, readEpubManifest, type StorePaths } from './store.ts';
import type { Book } from './shared/types.ts';

/** 单次取正文的字符上限（约一小节，够引用上下文又不撑爆会话）。 */
const EXCERPT_LIMIT = 4000;

/** 工具参数校验失败（与 dsh-tools 的 ToolArgsError 同名，宿主按同一路径处理）。 */
class ToolArgsError extends Error {
  constructor(violations: string[]) {
    super(`工具参数不合法：${violations.join('；')}`);
    this.name = 'ToolArgsError';
  }
}

/** 参数属性 spec（required 省略即可选；对齐 dsh-tools 的 ParameterPropertySpec）。 */
type ParamSpec = {
  type: 'string' | 'number' | 'integer' | 'boolean';
  required?: true;
  description?: string;
};

/** 工具定义（我们侧的书写形态，与 dsh-tools 的 DefineToolOptions 同构）。 */
interface ToolOptions {
  name: string;
  description: string;
  parameters: Record<string, ParamSpec>;
  output: {
    schema: unknown;
    render(args: Record<string, unknown>, value: unknown): Array<{ type: 'text'; text: string }>;
  };
  execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>;
}

/**
 * 把参数 spec 编译成 JSON Schema（对齐 parameterSchemaSpecToJsonSchema 的产物形态）。
 *
 * ⚠️ 宿主 `assertSupportedJsonSchema` 的规则（曾在此翻车导致插件 fiber failed）：
 * - `required` **只能**出现在 object 节点上、且必须是字符串数组（标准 JSON Schema）；
 *   属性节点内部的 `required: true` 会报 "unsupported on type \"string\""；
 * - 输出 schema 同理：属性节点的 `required` 关键字一律非法。
 * 因此书写工具时用 `required?: true` 的 spec 标记必填，
 * 由本函数把它编译到父级 object 的 `required: [...]`；输出 schema 也必须按标准写。
 */

/** 把标准 JSON Schema 输出树里的「属性级 required」剥掉、收敛到父级 object 的 required 数组。
 *  兼容历史上按 spec 风格书写的输出 schema，让宿主校验能通过。 */
function normalizeJsonSchema(node: unknown, path: string, violations: string[]): Record<string, unknown> {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    violations.push(`${path} 不是 schema 对象`);
    return {};
  }
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const childRequired: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (key === 'required') {
      // 属性节点上的 required: true → 收敛到父级；object 上的数组 → 原样保留
      if (typeof value === 'boolean') continue;
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        out.required = value;
        continue;
      }
      violations.push(`${path}.required 必须是字符串数组或省略`);
      continue;
    }
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        const child = childValue as Record<string, unknown>;
        // 子属性声明了 required: true → 记入父级 required 数组，并从子属性里剥掉
        if (child.required === true) required.push(childKey);
        const clone = { ...child };
        delete clone.required; // 必须真删除：undefined 值仍会被宿主视为非法关键字
        const cleaned = normalizeJsonSchema(clone, `${path}.properties.${childKey}`, violations);
        delete cleaned.required;
        properties[childKey] = cleaned;
      }
      out.properties = properties;
      if (required.length > 0) out.required = required;
      continue;
    }
    if (key === 'items' && typeof value === 'object' && value !== null) {
      out.items = normalizeJsonSchema(value, `${path}.items`, violations);
      continue;
    }
    if (key === 'oneOf' && Array.isArray(value)) {
      out.oneOf = value.map((child, index) => normalizeJsonSchema(child, `${path}.oneOf[${index}]`, violations));
      continue;
    }
    out[key] = value;
  }
  void childRequired;
  return out;
}

/** 把参数 spec 编译成 JSON Schema（对齐 parameterSchemaSpecToJsonSchema 的产物形态）。 */
function parametersToJsonSchema(parameters: Record<string, ParamSpec>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(parameters)) {
    const node: Record<string, unknown> = { type: spec.type };
    if (spec.description !== undefined) node.description = spec.description;
    properties[key] = node;
    if (spec.required === true) required.push(key);
  }
  const schema: Record<string, unknown> = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** 参数校验（覆盖本插件工具实际用到的类型；缺失/类型错/空串都算违规）。 */
function validateArgs(parameters: Record<string, ParamSpec>, args: Record<string, unknown>): string[] {
  const violations: string[] = [];
  for (const [key, spec] of Object.entries(parameters)) {
    const value = args[key];
    if (value === undefined) {
      if (spec.required === true) violations.push(`缺少必填参数 ${key}`);
      continue;
    }
    const typeOk =
      spec.type === 'string' ? typeof value === 'string'
      : spec.type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
      : spec.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === 'boolean';
    if (!typeOk) violations.push(`参数 ${key} 应为 ${spec.type}，实得 ${typeof value}`);
    else if (spec.type === 'string' && spec.required === true && (value as string).trim() === '') {
      violations.push(`参数 ${key} 不能为空`);
    }
  }
  return violations;
}

/** 按 dsh-tools 的 defineTool 形态包装工具定义（schema 编译 + 参数校验 + 宿主规则归一化）。 */
function defineTool(options: ToolOptions): Record<string, unknown> {
  // 输出 schema 可能按 spec 风格书写（属性级 required: true），先按宿主规则归一化；
  // 归一化发现的违规直接抛出（注册前就失败，好过运行时 fiber failed）。
  const violations: string[] = [];
  const normalizedOutput = normalizeJsonSchema(options.output.schema, 'output.schema', violations);
  if (normalizedOutput.type !== 'object') violations.push('output.schema 根必须是 object（宿主 assertObjectJsonSchema）');
  if (violations.length > 0) {
    throw new Error(`工具 ${options.name} 的 output.schema 不合宿主规则：${violations.join('；')}`);
  }
  const parameters = parametersToJsonSchema(options.parameters);
  const validate = (args: Record<string, unknown>): string[] => validateArgs(options.parameters, args);
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: normalizedOutput,
      render(args: Record<string, unknown>, value: unknown) {
        return options.output.render(args, value);
      },
    },
    async execute(args: Record<string, unknown>, exec: unknown) {
      const argsViolations = validate(args);
      if (argsViolations.length > 0) throw new ToolArgsError(argsViolations);
      return options.execute(args, exec);
    },
  };
}

/** 读取单元正文（文本类读副本文件；章节书读解压出的整本 HTML 或逐章拼接）。 */
async function readUnitText(paths: StorePaths, book: Book): Promise<string> {
  if (book.format === 'epub' || book.format === 'mobi') {
    // 章节书的正文在 library/<id>/book.html（mobi 导入时生成）
    const copy = join(paths.libraryDir, book.id, 'book.html');
    try {
      return await readFile(copy, 'utf8');
    } catch {
      // epub 没有整本 HTML：逐章拼接
      const manifest = await readEpubManifest(paths, book);
      const dir = bookDir(paths, book);
      const parts: string[] = [];
      for (const chapter of manifest?.chapters ?? []) {
        try {
          parts.push(await readFile(join(dir, chapter.href), 'utf8'));
        } catch {
          // 单章缺失跳过（书可能只解压了一部分）
        }
      }
      return parts.join('\n\n');
    }
  }
  // 文本类：副本优先，缺失回落原文件
  const copy = join(paths.libraryDir, book.id + '.' + book.format);
  try {
    return await readFile(copy, 'utf8');
  } catch {
    return await readFile(book.sourcePath, 'utf8');
  }
}

/** 把章节 HTML 转成会话可读的纯文本（轻量剥离，不引第三方解析器）。 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<img\b[^>]*>/gi, ' [图片] ')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 注册全部阅读工具；返回 disposer（交由 ctx.effect 纳管）。
 *  ctx 形态取结构最小集（tools），避免把整个 Context 类型钉死。 */
export function registerReadingTools(
  ctx: { tools: { register(definition: unknown): () => void } },
  paths: StorePaths,
): () => void {
  const listBooks = defineTool({
    name: 'reading_books',
    description: '列出阅读工作台书架上的全部书籍（书名、作者、格式、阅读进度）。需要为用户找书或确认书名时使用。',
    parameters: {},
    output: {
      // 宿主 assertObjectJsonSchema 强制 structured output 以 object 为根（数组要包进对象字段）；
      // assertSupportedJsonSchema 要求 required 只能出现在 object 上且为字符串数组——
      // 属性节点内的 required: true 一律非法（曾致插件 fiber failed、全路由 404）。
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['books'],
        properties: {
          books: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'title', 'format'],
              properties: {
                id: { type: 'string', description: '书籍 id（取正文/划线时用）' },
                title: { type: 'string' },
                author: { type: 'string' },
                format: { type: 'string', description: 'md | txt | html | epub | mobi | pdf' },
                percent: { type: 'number', description: '阅读进度 0-100（未读过则缺省）' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const books = (value as { books: Array<{ title: string; author?: string; format: string; percent?: number }> }).books;
        if (books.length === 0) return [{ type: 'text', text: '书架空空如也。' }];
        return [{
          type: 'text',
          text: books
            .map((b) => `《${b.title}》${b.author ?? ''}（${b.format}${b.percent !== undefined ? `，读到 ${Math.round(b.percent)}%` : ''}）`)
            .join('\n'),
        }];
      },
    },
    async execute() {
      const data = await loadData(paths);
      return {
        books: data.books.map((book) => {
          const progress = data.progress[book.id];
          return {
            id: book.id,
            title: book.title,
            // 宿主 snapshotJsonValue 会把含 undefined 的对象判成「非无损 JSON」，
            // 并让整次工具调用失败。书架里确实存在无作者的书（2026-10-19 实测 2 本），
            // 所以缺作者时必须**省略键**，不能写成 author: undefined。
            ...(book.author === undefined ? {} : { author: book.author }),
            format: book.format,
            ...(progress === undefined ? {} : { percent: progress.percent }),
          };
        }),
      };
    },
  });

  const listHighlights = defineTool({
    name: 'reading_highlights',
    description: '查询阅读工作台里的划线批注。可按书过滤；不传 bookId 时返回全部书的划线。',
    parameters: {
      bookId: {
        type: 'string',
        description: '书籍 id（用 reading_books 查到）；缺省查全部',
      },
      limit: {
        type: 'integer',
        description: '最多返回条数（默认 50，按创建时间倒序）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['total', 'items'],
        properties: {
          total: { type: 'integer', description: '符合条件的划线总数' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['bookTitle', 'text', 'createdAt'],
              properties: {
                bookTitle: { type: 'string' },
                text: { type: 'string', description: '划线原文' },
                note: { type: 'string', description: '用户笔记' },
                createdAt: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const result = value as { total: number; items: Array<{ bookTitle: string; text: string; note?: string }> };
        if (result.total === 0) return [{ type: 'text', text: '没有划线记录。' }];
        const lines = result.items.map(
          (item) => `《${item.bookTitle}》${item.note !== undefined ? `\n  笔记：${item.note}` : ''}\n  「${item.text}」`,
        );
        const more = result.total > result.items.length ? `\n（另有 ${result.total - result.items.length} 条未显示，可用 limit 调整）` : '';
        return [{ type: 'text', text: lines.join('\n\n') + more }];
      },
    },
    async execute(args) {
      const data = await loadData(paths);
      const bookId = args.bookId as string | undefined;
      const matched = data.highlights
        .filter((mark) => bookId === undefined || mark.bookId === bookId)
        .sort((a, b) => b.createdAt - a.createdAt);
      const rawLimit = args.limit as number | undefined;
      const limit = rawLimit === undefined || !Number.isFinite(rawLimit) ? 50 : Math.max(1, Math.trunc(rawLimit));
      const titleOf = (id: string): string => data.books.find((book) => book.id === id)?.title ?? '（已移除的书）';
      return {
        total: matched.length,
        items: matched.slice(0, limit).map((mark) => ({
          bookTitle: titleOf(mark.bookId),
          text: mark.text,
          ...(mark.note === undefined ? {} : { note: mark.note }),
          createdAt: mark.createdAt,
        })),
      };
    },
  });

  const readBook = defineTool({
    name: 'reading_excerpt',
    description: '读取书架中某本书正文的指定字符区间（节选），用于引用原文或结合上下文回答。整本书太长，请配合 offset/length 分段取。',
    parameters: {
      bookId: { type: 'string', required: true, description: '书籍 id（用 reading_books 查到）' },
      offset: { type: 'integer', description: '起始字符偏移（0 起，默认 0）' },
      length: { type: 'integer', description: `取多少字符（默认 ${EXCERPT_LIMIT}，上限 ${EXCERPT_LIMIT}）` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['bookTitle', 'totalLength', 'offset', 'excerpt', 'hasMore'],
        properties: {
          bookTitle: { type: 'string' },
          totalLength: { type: 'integer', description: '全书字符总数' },
          offset: { type: 'integer' },
          excerpt: { type: 'string', description: '正文片段（章节书为纯文本，图片标记为 [图片]）' },
          hasMore: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const result = value as { bookTitle: string; offset: number; excerpt: string; totalLength: number; hasMore: boolean };
        return [{
          type: 'text',
          text: `《${result.bookTitle}》第 ${result.offset}–${result.offset + result.excerpt.length} 字（共 ${result.totalLength} 字${result.hasMore ? '，未完' : '，已到末尾'}）\n\n${result.excerpt}`,
        }];
      },
    },
    async execute(args) {
      const data = await loadData(paths);
      const bookId = args.bookId as string;
      const book = data.books.find((entry) => entry.id === bookId);
      if (book === undefined) throw new Error(`书架中没有 id 为 ${bookId} 的书（用 reading_books 查询）`);
      const rawLength = args.length as number | undefined;
      const length = rawLength === undefined || !Number.isFinite(rawLength) ? EXCERPT_LIMIT : Math.min(EXCERPT_LIMIT, Math.max(1, Math.trunc(rawLength)));
      const rawOffset = args.offset as number | undefined;
      const offset = rawOffset === undefined || !Number.isFinite(rawOffset) ? 0 : Math.max(0, Math.trunc(rawOffset));

      const raw = await readUnitText(paths, book);
      // HTML 一律剥离成纯文本（图片占位），md/txt 保持原样
      const text = book.format === 'md' || book.format === 'txt' ? raw : htmlToPlainText(raw);

      const slice = text.slice(offset, offset + length);
      return {
        bookTitle: book.title,
        totalLength: text.length,
        offset,
        excerpt: slice,
        hasMore: offset + slice.length < text.length,
      };
    },
  });

  // 契约：register(definition) 只收**单个**工具（dsh-tools 的 ToolDefinition 签名）。
  // 首版传数组导致宿主启动阶段抛错、插件 fiberPhase: failed、全部路由 404。
  const disposers = [listBooks, listHighlights, readBook].map((tool) => ctx.tools.register(tool));
  return () => {
    for (const dispose of disposers) dispose();
  };
}
