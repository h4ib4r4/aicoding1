// 验证「原生关窗」这条路：发送 WM_CLOSE（等同于点右上角 X），
// 确认应用能被关掉，且关窗时会先把待落盘的改动写完。
//
// 关键点：不能用 JS 的 window.close()——那要走 plugin:window|close，是另一个权限；
// 真实用户点 X 走的是原生关闭。这里用 taskkill（不带 /F）就是发 WM_CLOSE。
const { spawn, execSync, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const RELEASE = 'G:\\Edge_download\\aicoding1\\src-tauri\\target\\release';
const PORT = 9333;
const DATA = path.join(process.env.APPDATA, 'com.yijing.goreview');
const LOG = path.join(DATA, 'yijing.log');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function killAll(hard = true) {
  for (const name of ['yijing.exe', 'katago.exe']) {
    try { execSync(`taskkill /IM ${name}${hard ? ' /F' : ''}`, { stdio: 'ignore' }); } catch {}
  }
}
function alive() {
  try {
    return execSync('tasklist /FI "IMAGENAME eq yijing.exe" /NH', { encoding: 'utf8' }).includes('yijing.exe');
  } catch { return false; }
}
function logSince(mark) {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, 'utf8').split('\n').filter(line => {
    const m = line.match(/^\[(\d+)\]/);
    return m && Number(m[1]) >= mark;
  });
}

async function findTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('about:'));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  return null;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
    };
    socket.onerror = reject;
    socket.onopen = () => resolve({
      evaluate(expression, timeout = 20000) {
        const current = ++id;
        socket.send(JSON.stringify({ id: current, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
        return new Promise((res, rej) => {
          waiting.set(current, message => {
            if (message.error) return rej(new Error(JSON.stringify(message.error)));
            if (message.result?.exceptionDetails) return rej(new Error(message.result.exceptionDetails.text));
            res(message.result?.result?.value);
          });
          setTimeout(() => { if (waiting.has(current)) { waiting.delete(current); rej(new Error('超时')); } }, timeout);
        });
      },
      close() { try { socket.close(); } catch {} },
    });
  });
}

function digests() {
  const script = `
import json, sqlite3
c = sqlite3.connect(r'${path.join(DATA, 'yijing.sqlite')}')
print(json.dumps([list(r) for r in c.execute('SELECT game_key, digest FROM games ORDER BY position')]))
`;
  const out = execFileSync('python', ['-c', script], { encoding: 'utf8' });
  return out.trim().split('\n').pop();
}

(async () => {
  killAll();
  await sleep(1500);
  const mark = Math.floor(Date.now() / 1000) - 1;

  // ---- 场景 1：没有待落盘的改动，点 X 应该直接关掉 ----
  const app = spawn(path.join(RELEASE, 'yijing.exe'), [], { cwd: RELEASE, stdio: 'ignore' });
  const target = await findTarget();
  if (!target) { log('✗ 找不到可调试页面'); killAll(); process.exit(1); }
  const client = await connect(target.webSocketDebuggerUrl);
  for (let i = 0; i < 40; i++) {
    if (await client.evaluate('document.querySelectorAll(".game-card").length') > 0) break;
    await sleep(500);
  }
  log('界面就绪，现在发送 WM_CLOSE（等价于点右上角 X）…');
  try { execSync('taskkill /IM yijing.exe', { stdio: 'ignore' }); } catch {}
  let exited = false;
  for (let i = 0; i < 20; i++) { await sleep(500); if (!alive()) { exited = true; break; } }
  log(exited ? '✓ 场景 1：无待写改动时，点 X 能正常关掉应用' : '✗ 场景 1：窗口关不掉，进程还在');
  if (!exited) killAll();
  client.close();
  await sleep(500);

  // ---- 场景 2：防抖窗口内点 X，待落盘的改动不能丢 ----
  killAll();
  await sleep(1500);
  const mark2 = Math.floor(Date.now() / 1000) - 1;
  spawn(path.join(RELEASE, 'yijing.exe'), [], { cwd: RELEASE, stdio: 'ignore' });
  const target2 = await findTarget();
  if (!target2) { log('✗ 找不到可调试页面'); killAll(); process.exit(1); }
  const client2 = await connect(target2.webSocketDebuggerUrl);
  for (let i = 0; i < 40; i++) {
    if (await client2.evaluate('document.querySelectorAll(".game-card").length') > 0) break;
    await sleep(500);
  }

  const digestsBefore = digests();
  // 每 100ms 点一次收藏：每次都把 250ms 的合并窗口顶掉，于是库在这段时间里一次都不该被写，
  // 「关窗时确实有未落盘改动」这个前提就成立了，免得测出个侥幸通过。
  await client2.evaluate(`window.__churn = setInterval(() => document.getElementById('favoriteButton').click(), 100); true`);
  await sleep(600);
  const digestsChurning = digests();
  log(digestsChurning === digestsBefore
    ? '✓ 合并窗口一直被顶掉，这期间确实没有写库（说明确实存在待落盘改动）'
    : '✗ 合并期间就写库了，测试前提不成立');

  log('现在发送 WM_CLOSE…');
  try { execSync('taskkill /IM yijing.exe', { stdio: 'ignore' }); } catch {}
  let exited2 = false;
  for (let i = 0; i < 20; i++) { await sleep(500); if (!alive()) { exited2 = true; break; } }
  log(exited2 ? '✓ 场景 2：有待写改动时，点 X 仍能关掉应用' : '✗ 场景 2：窗口关不掉，进程还在');
  if (!exited2) killAll();
  client2.close();

  const digestsAfter = digests();
  const wrote = digestsAfter !== digestsBefore;
  const rowsKept = JSON.parse(digestsAfter).length === JSON.parse(digestsBefore).length;
  log(wrote ? '✓ 关窗前后库内容变了：最后那批改动被写进去了（若没写，这里应当和关窗前完全一致）'
            : '✗ 关窗把最后一批改动吞了');
  log(rowsKept ? '✓ 行数不变，没有写出重复行' : '✗ 行数变了');

  const lines2 = logSince(mark2);
  const intercepted = lines2.some(l => l.includes('收到关窗请求'));
  const denied = lines2.some(l => l.includes('not allowed by ACL'));
  log(intercepted ? '✓ 关窗请求被拦下并先写了盘' : '✗ 关窗请求没有被拦');
  log(denied ? '✗ 仍存在权限被拒的错误' : '✓ 没有权限被拒的错误');
  log('--- 场景 2 日志 ---');
  for (const line of lines2) log('   ', line);
  process.exit(exited && exited2 && intercepted && wrote && rowsKept && !denied ? 0 : 1);
})().catch(error => { log('脚本异常:', error.message); killAll(); process.exit(1); });
