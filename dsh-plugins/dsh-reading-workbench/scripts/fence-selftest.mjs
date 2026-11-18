/**
 * 围栏自测（不依赖 DSH）：直接加载构建产物 lib/index.mjs，用假 ctx 起一个本地
 * HTTP 服务跑全部头组合用例。用于在 DSH 重启前验证产物逻辑。
 * 用法：node scripts/fence-selftest.mjs
 */
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.mjs';

const routes = [];
const ctx = {
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
  logger: { warn: (error) => console.log('[warn]', error instanceof Error ? error.message : error) },
  effect(fn) {
    fn();
    return () => {};
  },
};

// 用临时目录当数据根，避免污染真实书库
apply(ctx, { dshHome: join(tmpdir(), 'rw-fence-selftest') });
console.log(`已注册路由 ${routes.length} 条: ${routes.map((r) => r.path).join(', ')}`);

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const route = routes.find((r) => r.path === path);
  if (!route) {
    res.writeHead(404).end('{}');
    return;
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500).end(JSON.stringify({ error: String(error) }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

/** 单次请求。 */
function probe(name, headers, expect) {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/api/reading-workbench/books', method: 'GET', headers, setHost: false },
      (res) => {
        res.resume();
        res.on('end', () => {
          const pass = res.statusCode === expect;
          console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  -> ${res.statusCode} (期望 ${expect})`);
          resolve(pass);
        });
      },
    );
    req.on('error', (error) => {
      console.log(`FAIL  ${name}  -> ${error.message}`);
      resolve(false);
    });
    req.end();
  });
}

const hostPort = `127.0.0.1:${port}`;
const localhostPort = `localhost:${port}`;
const cases = [
  ['127.0.0.1 同源（浏览器）', { host: hostPort, origin: `http://${hostPort}`, 'sec-fetch-site': 'same-origin' }, 200],
  ['localhost 同源（浏览器）', { host: localhostPort, origin: `http://${localhostPort}`, 'sec-fetch-site': 'same-origin' }, 200],
  ['localhost 同源，无 sec-fetch-site', { host: localhostPort, origin: `http://${localhostPort}` }, 200],
  ['无 Origin（非浏览器客户端）', { host: hostPort }, 200],
  ['IPv6 形态 Host [::1]', { host: `[::1]:${port}`, origin: `http://[::1]:${port}`, 'sec-fetch-site': 'same-origin' }, 200],
  ['Origin 与 Host 不同源', { host: hostPort, origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' }, 403],
  ['Host 头伪造为外网', { host: 'evil.example', origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' }, 403],
  ['明确 cross-site', { host: hostPort, origin: `http://${hostPort}`, 'sec-fetch-site': 'cross-site' }, 403],
];

let allPass = true;
for (const [name, headers, expect] of cases) {
  allPass = (await probe(name, headers, expect)) && allPass;
}
server.close();
console.log(allPass ? '\n全部通过（新产物逻辑正确）' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
