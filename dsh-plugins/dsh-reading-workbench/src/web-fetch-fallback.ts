/**
 * 内置受限 HTTPS 抓取器 —— 宿主 `ctx.web` 不可用时的回退通道。
 *
 * ## 为什么需要它
 *
 * `ctx.web.fetch` 的正常工作依赖**部署方把抓取提供方固定下来**。而 dsh-web 默认会同时注册
 * 两个抓取提供方（本地 `http` 与远端 `deepseek-fetch-api`），一旦 `fetchProvider` 没被固定，
 * 每次调用都会抛 `WEB_PROVIDER_AMBIGUOUS` —— 结果是「插件功能全废，但错误看起来像站点问题」。
 * 实测踩到过一次：用户 profile 里没有任何 `fetchProvider` 配置，插件只能报错。
 *
 * 因此插件自带一条**最小可用**的抓取通道：不依赖任何 provider 配置，也不需要 API 凭据。
 *
 * ## 为什么它是安全的（而不是"绕过宿主安全策略"）
 *
 * 宿主 `http` provider 的安全策略是「任意公网 URL」（它有 SSRF 防护、连接固定等）。
 * 内置抓取器反过来，把范围**收窄到用户本来就要访问的那几个站点**：
 * - 只允许 `https:`；
 * - 只允许适配器声明的域名白名单（默认 `alicesw.tw` / `alicesw.com`）；
 * - 只跟随**同源**重定向，最多 3 跳；
 * - 响应体上限 8 MB、超时 30 s；
 * - 不发送 `Accept-Encoding`（避免解压逻辑）、不回传任何 cookie、不发凭据；
 * - `User-Agent` 明确标识为 harness 而非浏览器伪装。
 *
 * 换句话说：它抓不出「书源适配器支持范围」之外的任何东西。
 *
 * ## 沙箱约束
 *
 * Host 半在 vm 沙箱里，`fetch` 是 trap（调用即抛），但**静态 `import "node:https"` 由宿主
 * 在 apply 之前解析**，属于允许的用法（`agents.md` §4.0 第 4 条）。
 * 沙箱契约套件里有一条断言钉住这一点。
 */
import { request as httpsRequest } from 'node:https';

/** 默认域名白名单：与 `alicesw` 适配器的判定保持一致。 */
const DEFAULT_ALLOWED_HOST = /(^|\.)alicesw\.(tw|com)$/i;

/** 默认响应体上限（8 MB）：足够放下目录页（实测 169 KB）与单章（约 40 KB）。 */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** 默认单次请求超时。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 默认同源重定向上限。 */
const DEFAULT_MAX_REDIRECTS = 3;

/** 一次请求的原始结果。 */
interface RawResponse {
  status: number;
  body: string;
  location?: string;
}

/** 抓取失败的错误（带 code，便于上层区分「配置问题」与「站点问题」）。 */
export class BuiltinFetchError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'BuiltinFetchError';
    this.code = code;
  }
}

/** 内置抓取器的可选项。 */
export interface BuiltinFetchOptions {
  /** 允许的域名（默认只允许 alicesw）。 */
  allowedHost?: RegExp;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

/** 发一次请求并读满响应体（不跟随重定向，由调用方处理）。 */
function requestOnce(url: URL, maxBytes: number, timeoutMs: number): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === '' ? 443 : Number(url.port),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          // 不发送 Accept-Encoding：站点默认会 gzip，而沙箱里没有 zlib 使用先例，
          // 明确声明只要明文最省事，也不会因为解压失败把内容读坏。
          'user-agent': 'deepseek-harness/reading-workbench (+web-source)',
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        const encoding = res.headers['content-encoding'];
        if (encoding !== undefined && encoding !== 'identity') {
          // 我们显式不发送 Accept-Encoding，正常服务器会回明文；
          // 若它仍然压缩，说明我们的假设不成立 —— 报错，绝不把压缩字节当文本读成乱码。
          res.resume();
          reject(
            new BuiltinFetchError(
              `目标返回了压缩内容（content-encoding: ${encoding}），内置抓取器不支持解压：${url.toString()}`,
              'BUILTIN_FETCH_UNSUPPORTED_ENCODING',
            ),
          );
          return;
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        res.on('data', (chunk: Uint8Array) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new BuiltinFetchError(`响应体超过上限 ${maxBytes} 字节：${url.toString()}`, 'BUILTIN_FETCH_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          // 站点声明 UTF-8（实测 utf-8 严格解码全部成功）。用**严格**模式：
          // 解码失败即报错，绝不把 U+FFFD 静默混进正文（本工作区踩过 GBK 乱码固化的事故）。
          let text: string;
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(concat(chunks));
          } catch {
            reject(
              new BuiltinFetchError(
                `页面不是合法的 UTF-8（编码可能已变更）：${url.toString()}`,
                'BUILTIN_FETCH_BAD_ENCODING',
              ),
            );
            return;
          }
          resolve(location === undefined ? { status, body: text } : { status, body: text, location });
        });
        res.on('error', (error: Error) => {
          reject(new BuiltinFetchError(`读取响应失败：${error.message}`, 'BUILTIN_FETCH_READ_FAILED'));
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new BuiltinFetchError(`请求超时（${timeoutMs}ms）：${url.toString()}`, 'BUILTIN_FETCH_TIMEOUT'));
    });
    req.on('error', (error: Error) => {
      reject(new BuiltinFetchError(`请求失败：${error.message}`, 'BUILTIN_FETCH_FAILED'));
    });
    req.end();
  });
}

/** 合并字节块（沙箱里没有 Buffer，用 Uint8Array 手工拼）。 */
function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * 内置抓取：校验协议与域名 → 发请求 → 跟随同源重定向 → 返回 HTML。
 *
 * @param url - 目标 URL。
 * @param options - 覆盖默认限制。
 * @returns 页面 HTML（不返回 truncated：内置通道不受 provider 的字符上限约束）。
 */
export async function builtinFetchHtml(url: string, options: BuiltinFetchOptions = {}): Promise<string> {
  const allowedHost = options.allowedHost ?? DEFAULT_ALLOWED_HOST;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new BuiltinFetchError(`URL 不合法：${url}`, 'BUILTIN_FETCH_INVALID_URL');
  }

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (current.protocol !== 'https:') {
      throw new BuiltinFetchError(`只允许 https 地址：${current.toString()}`, 'BUILTIN_FETCH_BLOCKED_SCHEME');
    }
    if (!allowedHost.test(current.hostname)) {
      throw new BuiltinFetchError(
        `内置抓取只允许书源适配器声明支持的域名（当前：${current.hostname}）`,
        'BUILTIN_FETCH_BLOCKED_HOST',
      );
    }
    const response = await requestOnce(current, maxBytes, timeoutMs);
    if (response.status >= 300 && response.status < 400 && response.location !== undefined) {
      const next = new URL(response.location, current);
      // 只跟随同源跳转：跨站跳转会让"域名白名单"形同虚设
      if (next.origin !== current.origin) {
        throw new BuiltinFetchError(
          `跨站跳转被拒绝（${current.origin} → ${next.origin}）`,
          'BUILTIN_FETCH_REDIRECT_BLOCKED',
        );
      }
      current = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new BuiltinFetchError(`目标返回 HTTP ${response.status}：${current.toString()}`, 'BUILTIN_FETCH_HTTP_ERROR');
    }
    return response.body;
  }
  throw new BuiltinFetchError(`重定向次数超过上限（${maxRedirects}）`, 'BUILTIN_FETCH_REDIRECT_BLOCKED');
}
