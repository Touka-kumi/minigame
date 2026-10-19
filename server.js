import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ValidationError } from './lib/algorithm.js';
import { WalletStore, normalizeUid } from './lib/store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function setSecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  setSecurityHeaders(res);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, limit = 16 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }

  if (chunks.length === 0) throw new HttpError(400, '请求体不能为空');
  const text = Buffer.concat(chunks).toString('utf8');

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, '请求体必须是有效 JSON 对象');
  }
}

function getRequestUrl(req) {
  try {
    return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    throw new HttpError(400, '请求地址无效');
  }
}

async function handleApi(req, res, url, store) {
  const { pathname } = url;

  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      service: 'snow-bet-lab',
      time: Date.now(),
    });
    return true;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    const uid = normalizeUid(url.searchParams.get('uid'));
    const state = await store.getState(uid);
    sendJson(res, 200, { ok: true, state });
    return true;
  }

  if (pathname === '/api/history' && req.method === 'GET') {
    const uid = normalizeUid(url.searchParams.get('uid'));
    const history = await store.getHistory(uid, url.searchParams.get('limit'));
    sendJson(res, 200, { ok: true, ...history });
    return true;
  }

  if (pathname === '/api/recharge' && req.method === 'POST') {
    const uid = normalizeUid(url.searchParams.get('uid'));
    const body = await readJsonBody(req);
    const result = await store.recharge(uid, body.amount);
    sendJson(res, 200, {
      ok: true,
      credited: result.credited,
      balance: result.balance,
      state: result.state,
    });
    return true;
  }

  if (pathname === '/api/bet' && req.method === 'POST') {
    const uid = normalizeUid(url.searchParams.get('uid'));
    const body = await readJsonBody(req);
    const result = await store.placeBet(uid, {
      type: typeof body.type === 'string' ? body.type : '',
      amount: body.amount,
      position: body.position,
      digit: body.digit,
    });
    sendJson(res, 200, {
      ok: true,
      bet: result.bet,
      state: result.state,
    });
    return true;
  }

  if (pathname.startsWith('/api/')) {
    throw new HttpError(404, '接口不存在');
  }

  return false;
}

async function serveStatic(req, res, url, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, '仅支持 GET / HEAD');
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, '路径编码无效');
  }

  if (decodedPath.includes('\0')) throw new HttpError(400, '路径无效');
  const relativePath = decodedPath === '/' ? '/index.html' : decodedPath;
  const filePath = path.resolve(publicDir, `.${relativePath}`);
  const rootWithSeparator = `${path.resolve(publicDir)}${path.sep}`;

  if (filePath !== path.resolve(publicDir) && !filePath.startsWith(rootWithSeparator)) {
    throw new HttpError(403, '禁止访问');
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new HttpError(404, '页面不存在');
  }

  if (!fileStat.isFile()) throw new HttpError(404, '页面不存在');

  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES.get(extension) || 'application/octet-stream';

  setSecurityHeaders(res);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': fileStat.size,
    'Cache-Control': 'no-cache',
    'Last-Modified': fileStat.mtime.toUTCString(),
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  createReadStream(filePath)
    .on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.destroy();
    })
    .pipe(res);
}

export async function createAppServer({
  dataFile = path.join(__dirname, 'data', 'wallet.json'),
  publicDir = path.join(__dirname, 'public'),
  now,
} = {}) {
  const store = await new WalletStore({ dataFile, ...(now ? { now } : {}) }).init();

  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(async () => {
        const url = getRequestUrl(req);
        const handled = await handleApi(req, res, url, store);
        if (!handled) await serveStatic(req, res, url, publicDir);
      })
      .catch((error) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }

        const statusCode =
          error instanceof ValidationError || error instanceof HttpError
            ? error.statusCode || 400
            : 500;
        if (statusCode >= 500) {
          console.error('[snow-bet] 请求处理失败:', error);
        }
        sendJson(res, statusCode, {
          ok: false,
          error: statusCode >= 500 ? '服务器开小差了，请稍后再试' : error.message,
        });
      });
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });

  let tickInFlight = Promise.resolve();
  const ticker = setInterval(() => {
    tickInFlight = store.tick().catch((error) => {
      console.error('[snow-bet] 周期结算失败:', error);
    });
  }, 500);
  ticker.unref?.();

  const stopTicker = async () => {
    clearInterval(ticker);
    await tickInFlight.catch(() => {});
  };

  server.on('close', () => clearInterval(ticker));

  return { server, store, stopTicker };
}

function getLanUrls(port) {
  const urls = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const info of interfaces || []) {
      if (info.family === 'IPv4' && !info.internal) {
        urls.push(`http://${info.address}:${port}`);
      }
    }
  }
  return urls;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const dataFile = process.env.DATA_FILE
    ? path.resolve(process.env.DATA_FILE)
    : path.join(__dirname, 'data', 'wallet.json');

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT 必须是 1–65535 之间的整数');
    process.exit(1);
  }

  try {
    const { server, stopTicker } = await createAppServer({ dataFile });
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`端口 ${port} 已被占用，请设置其他 PORT 后重试。`);
      } else {
        console.error('服务启动失败:', error);
      }
      process.exit(1);
    });
    server.listen(port, host, () => {
      console.log('');
      console.log('  ❄  雪境 · 周期算法测试已启动');
      console.log(`  本机访问  http://localhost:${port}`);
      for (const url of getLanUrls(port)) {
        console.log(`  局域网    ${url}`);
      }
      console.log(`  数据文件  ${dataFile}`);
      console.log('  按 Ctrl+C 停止服务');
      console.log('');
    });

    const shutdown = (signal) => {
      console.log(`\n[snow-bet] 收到 ${signal}，正在关闭...`);
      stopTicker()
        .catch(() => {})
        .finally(() => {
          server.close(() => process.exit(0));
        });
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('启动失败:', error);
    process.exit(1);
  }
}
