const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { KataGoManager } = require('./katago');

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const katago = new KataGoManager();
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => { body += chunk; if (body.length > 2_000_000) reject(new Error('请求过大')); });
    request.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('JSON 格式无效')); } });
    request.on('error', reject);
  });
}

http.createServer(async (request, response) => {
  const requestPath = decodeURIComponent((request.url || '/').split('?')[0]);
  if (requestPath === '/api/katago/status') {
    sendJson(response, 200, katago.status());
    return;
  }
  if (requestPath === '/api/analyze' && request.method === 'POST') {
    try {
      const input = await readJson(request);
      if (!Array.isArray(input.moves) || !Array.isArray(input.analyzeTurns) || !input.analyzeTurns.length) throw new Error('缺少棋谱或分析手数');
      const results = await katago.analyze({ moves: input.moves, analyzeTurns: input.analyzeTurns, maxVisits: Math.min(500, Math.max(1, Number(input.maxVisits) || 64)) });
      sendJson(response, 200, { results });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const filePath = path.resolve(root, relativePath);

  if (!filePath.startsWith(root + path.sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' });
    response.end(data);
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`弈境 Demo：http://127.0.0.1:${port}`);
});

process.on('SIGINT', () => { katago.close(); process.exit(0); });
