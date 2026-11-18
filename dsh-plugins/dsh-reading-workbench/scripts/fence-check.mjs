/**
 * 围栏回归脚本：用真实的 HTTP 头组合打 /api/reading-workbench/books，打印状态码。
 * 用法：node scripts/fence-check.mjs [port]
 * 期望：本机 loopback 访问全部 200；跨站/伪造 Host 全部 403。
 */
import { request } from 'node:http';

const port = Number(process.argv[2] ?? 19387);

/** 单次请求，返回状态码。 */
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
      console.log(`FAIL  ${name}  -> 请求错误: ${error.message}`);
      resolve(false);
    });
    req.end();
  });
}

const sameOrigin = {
  host: '127.0.0.1:19387',
  origin: 'http://127.0.0.1:19387',
  'sec-fetch-site': 'same-origin',
};
const localhostOrigin = {
  host: 'localhost:19387',
  origin: 'http://localhost:19387',
  'sec-fetch-site': 'same-origin',
};

const cases = [
  ['127.0.0.1 同源（浏览器）', sameOrigin, 200],
  ['localhost 同源（浏览器，本次故障场景）', localhostOrigin, 200],
  ['localhost 同源，无 sec-fetch-site', { host: 'localhost:19387', origin: 'http://localhost:19387' }, 200],
  ['无 Origin（非浏览器客户端）', { host: '127.0.0.1:19387' }, 200],
  ['Origin 与 Host 不同源', { ...sameOrigin, origin: 'http://evil.example' }, 403],
  ['Host 头伪造为外网', { host: 'evil.example', origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' }, 403],
  ['明确 cross-site', { ...sameOrigin, 'sec-fetch-site': 'cross-site' }, 403],
];

let allPass = true;
for (const [name, headers, expect] of cases) {
  const pass = await probe(name, headers, expect);
  allPass = allPass && pass;
}
console.log(allPass ? '\n全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
