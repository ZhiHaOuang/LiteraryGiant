/**
 * Agent 工具 schema 合规自测：按宿主 registry 的校验规则复刻关键断言。
 *
 * 背景（两次真实事故）：
 * 1. `tools.register` 只收**单个**工具 —— 传数组导致插件 fiberPhase: failed、全部路由 404；
 * 2. `output.schema` 必须以 **object 为根**（宿主 assertObjectJsonSchema）——
 *    数组根在注册时抛 JsonSchemaError，同样 fiber 失败。
 *
 * 这两条在本地「自实现的 defineTool」看来都合法，只有宿主 registry 才校验，
 * 因此用复刻规则在本地点持续拦截（注册桩对数组抛错 + 本文件校验 object 根）。
 *
 * 用法：node scripts/tools-schema-check.mjs
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStorePaths } from '../src/store.ts';
import { registerReadingTools } from '../src/tools.ts';

const paths = resolveStorePaths(await mkdtemp(join(tmpdir(), 'rw-tools-schema-')));
const registered = [];

// 注册桩与真实宿主同签名：数组直接抛（回归断言 #1）
registerReadingTools({
  tools: {
    register(definition) {
      if (Array.isArray(definition)) {
        throw new TypeError('tools.register 只接受单个工具定义（ToolDefinition），不接受数组');
      }
      registered.push(definition);
      return () => {};
    },
  },
}, paths);

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

check('三个工具逐个注册（不传数组）', registered.length === 3, registered.map((tool) => tool.name).join(', '));

// 宿主 checkSchemaNode 允许的关键字（type/oneOf/结构关键字 + 注释类注解）
const ALLOWED = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
]);

/** 按宿主规则递归校验一个 schema 节点。 */
function walk(node, path, violations) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    violations.push(`${path} 不是 schema 对象`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED.has(key)) violations.push(`${path}.${key} 不是受支持的关键字`);
  }
  if (node.type === undefined && node.oneOf === undefined) violations.push(`${path} 缺 type/oneOf`);
  if (node.properties !== undefined) {
    for (const [key, value] of Object.entries(node.properties)) walk(value, `${path}.properties.${key}`, violations);
  }
  if (node.items !== undefined) walk(node.items, `${path}.items`, violations);
  if (node.oneOf !== undefined) {
    for (const [index, value] of node.oneOf.entries()) walk(value, `${path}.oneOf[${index}]`, violations);
  }
}

for (const tool of registered) {
  const violations = [];
  walk(tool.parameters, 'parameters', violations);
  walk(tool.output.schema, 'output.schema', violations);
  // 宿主 assertObjectJsonSchema：structured output 必须 object 根（回归断言 #2）
  if (tool.output.schema.type !== 'object') violations.push('output.schema 根必须是 object（宿主 assertObjectJsonSchema）');
  // 宿主 assertSupportedJsonSchema：required 只能出现在 object 上、且必须是字符串数组
  // （回归断言 #3：曾把 required: true 写进属性节点，注册时抛 JsonSchemaError、fiber failed）
  walkRequired(tool.output.schema, 'output.schema', violations);
  walkRequired(tool.parameters, 'parameters', violations);
  check(
    `${tool.name} schema 合规（object 根 + 关键字白名单 + required 标准形态）`,
    violations.length === 0,
    violations.length === 0 ? undefined : violations.join('；'),
  );
  // render 必须是纯函数且产出 text 块
  const sample = tool.output.render({}, tool.name === 'reading_books' ? { books: [] } : tool.name === 'reading_highlights' ? { total: 0, items: [] } : { bookTitle: 'x', totalLength: 0, offset: 0, excerpt: '', hasMore: false });
  check(
    `${tool.name} render 可调用并产出文本块`,
    Array.isArray(sample) && sample.length === 1 && sample[0].type === 'text',
    JSON.stringify(sample).slice(0, 60),
  );
}

/** 宿主规则：required 只能出现在 object 节点、且必须是字符串数组。 */
function walkRequired(node, path, violations) {
  if (typeof node !== 'object' || node === null) return;
  if (Object.hasOwn(node, 'required')) {
    const value = node.required;
    if (node.type !== 'object') violations.push(`${path}.required 不允许出现在 type="${node.type}" 上`);
    else if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      violations.push(`${path}.required 必须是字符串数组，实得 ${JSON.stringify(value)}`);
    }
  }
  if (node.properties !== undefined) {
    for (const [key, value] of Object.entries(node.properties)) walkRequired(value, `${path}.properties.${key}`, violations);
  }
  if (node.items !== undefined) walkRequired(node.items, `${path}.items`, violations);
  if (node.oneOf !== undefined) {
    for (const [index, value] of node.oneOf.entries()) walkRequired(value, `${path}.oneOf[${index}]`, violations);
  }
}

console.log(allPass ? '\n工具 schema 合规全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
