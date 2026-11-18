/**
 * 浏览器环境的 Node 内建模块桩。
 *
 * 为什么需要：pdfjs-dist 的构建产物里保留了 Node 分支的引用
 * （`require("url").pathToFileURL`、`process.getBuiltinModule("module")`），
 * 这些分支在浏览器里永远不会执行，但只要静态留在 bundle 里，
 * DSH 的 ModuleLoader 就会因为「非 seed 模块 require」而让整个 GUI 启动失败。
 *
 * 这里把它们替换成惰性抛错的桩：真的被调用时立刻暴露问题，
 * 而不是悄悄崩掉宿主。
 */

/** 统一的不可用报错。 */
function unavailable(name: string): never {
  throw new Error(`${name} 在浏览器环境不可用（该分支不应被触发）`);
}

/** `url` 模块桩。 */
export const pathToFileURL = (): never => unavailable('url.pathToFileURL');
export const fileURLToPath = (): never => unavailable('url.fileURLToPath');
export const URL = globalThis.URL;

/** `module` 模块桩。 */
export const createRequire = (): never => unavailable('module.createRequire');

export default { pathToFileURL, fileURLToPath, createRequire, URL };
