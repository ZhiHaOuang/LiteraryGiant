import { defineConfig } from 'tsdown';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
/** Node 内建模块桩：pdfjs 的 Node 分支引用它们，浏览器里不能真去 require。 */
const nodeStub = join(here, 'src/client/node-stub.ts');

/**
 * 双入口构建：
 * - lib/index.js  Host 半：ESM，平台 node，@deepseek-ai/* 与 node 内建保持外部。
 * - lib/client.js Client 半：CJS 产物，外包 window.__ModuleLoader__.load({ id, factory(require) })
 *   信封（对齐 skill-explorer 发布产物形态），react / react/jsx-runtime 经 factory 的
 *   require 参数在运行时注入。
 *
 *   DSH 的 client 模块表只认平台 seed 模块（react、react/jsx-runtime、react-dom、
 *   @deepseek-ai/cordis、dsh-client-store / ui-slots / ui-primitives / ui-dockkit），
 *   第三方包一律不在表内。因此除 seed 之外的依赖必须打进 bundle：残留 require("第三方包")
 *   会让整个 web boot 失败、GUI 起不来，而不只是本插件不可用。
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    deps: { neverBundle: [/^node:/, /^@deepseek-ai\//] },
    clean: true,
    sourcemap: true,
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    deps: {
      neverBundle: ['react', 'react/jsx-runtime'],
      alwaysBundle: [/^dompurify/, /^marked/, /^pdfjs-dist/],
    },
    banner: [
      'window.__ModuleLoader__.load({',
      '  id: "dsh-reading-workbench",',
      '  factory: (require) => {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
    ].join('\n'),
    footer: ['    return module.exports;', '  }', '});'].join('\n'),
    clean: false,
    sourcemap: true,
  },
]);
