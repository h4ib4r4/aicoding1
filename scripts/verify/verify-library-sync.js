// 端到端验证：真实点击界面按钮，确认改动确实落进 SQLite，且关窗前不会被吞掉。
// 需要构建时带 --remote-debugging-port=9333。
const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const RELEASE = 'G:\\Edge_download\\aicoding1\\src-tauri\\target\\release';
const PORT = 9333;
const DATA = path.join(process.env.APPDATA, 'com.yijing.goreview');
const DB = path.join(DATA, 'yijing.sqlite');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function killAll() {
  for (const name of ['yijing.exe', 'katago.exe']) {
    try { execSync(`taskkill /IM ${name} /F`, { stdio: 'ignore' }); } catch {}
  }
}

function launch() {
  killAll();
  return spawn(path.join(RELEASE, 'yijing.exe'), [], { cwd: RELEASE, stdio: 'ignore' });
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

// 极简 CDP 客户端：只用到 Runtime.evaluate
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && waiting.has(message.id)) {
        waiting.get(message.id)(message);
        waiting.delete(message.id);
      }
    };
    socket.onerror = error => reject(error);
    socket.onopen = () => resolve({
      evaluate(expression, timeout = 20000) {
        const current = ++id;
        socket.send(JSON.stringify({ id: current, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
        return new Promise((res, rej) => {
          waiting.set(current, message => {
            if (message.error) return rej(new Error(JSON.stringify(message.error)));
            const result = message.result?.result;
            if (message.result?.exceptionDetails) return rej(new Error(message.result.exceptionDetails.text));
            res(result?.value);
          });
          setTimeout(() => { if (waiting.has(current)) { waiting.delete(current); rej(new Error('evaluate 超时')); } }, timeout);
        });
      },
      close() { try { socket.close(); } catch {} },
    });
  });
}

function db() {
  const { execFileSync } = require('node:child_process');
  // 用 Python 读库：Windows 上没有 sqlite3 命令行
  const script = `
import json, sqlite3
c = sqlite3.connect(r'${DB}')
rows = list(c.execute('SELECT game_key, digest, payload FROM games ORDER BY position'))
print(json.dumps([{'key': k, 'digest': d, 'fav': json.loads(p).get('favorite', False)} for k, d, p in rows]))
`;
  const out = execFileSync('python', ['-c', script], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

function metaSettings() {
  const { execFileSync } = require('node:child_process');
  const script = `
import json, sqlite3
c = sqlite3.connect(r'${DB}')
row = c.execute("SELECT value FROM meta WHERE key='settings'").fetchone()
print(row[0] if row else 'null')
`;
  return execFileSync('python', ['-c', script], { encoding: 'utf8' }).trim();
}

(async () => {
  // 恢复成「老版本刚升级上来」的状态：有 library.json、没有新库
  const snapshot = 'G:\\Edge_download\\aicoding1\\.workbuddy\\tmp\\library.json.snapshot';
  for (const name of fs.readdirSync(DATA)) {
    if (name.startsWith('library.json') || name === 'yijing.sqlite' || name.startsWith('yijing.sqlite-')) {
      fs.rmSync(path.join(DATA, name), { force: true });
    }
  }
  fs.copyFileSync(snapshot, path.join(DATA, 'library.json'));
  log('已重置为「待迁移」状态');

  const app = launch();
  const target = await findTarget();
  if (!target) { log('✗ 没找到可调试的页面，渲染层可能又出问题了'); killAll(); process.exit(1); }
  log('已连上页面:', target.url);

  const client = await connect(target.webSocketDebuggerUrl);
  // 等前端把棋谱库读完并完成迁移
  for (let i = 0; i < 40; i++) {
    const ready = await client.evaluate('document.querySelectorAll(".game-card").length');
    if (ready > 0) { log('界面已列出', ready, '局棋谱'); break; }
    await sleep(500);
  }

  const before = db();
  log('迁移后库中行数:', before.length, '| 收藏标记:', before.filter(g => g.fav).length);

  // ---- 测试 1：点击收藏，等防抖过去，确认只有一行被改写 ----
  const clicked = await client.evaluate(`(() => {
    const button = document.getElementById('favoriteButton');
    const title = document.getElementById('gameTitle').textContent;
    button.click();
    return { title, active: button.classList.contains('active'), favText: button.textContent };
  })()`);
  log('已点击收藏:', JSON.stringify(clicked));
  await sleep(1500);

  const afterFav = db();
  const changedRows = afterFav.filter((g, i) => g.digest !== before[i].digest).length;
  log('等防抖后：行数', afterFav.length, '| 内容变动行数', changedRows, '| 收藏标记', afterFav.filter(g => g.fav).length);
  log(afterFav.length === before.length ? '✓ 没有产生重复行' : '✗ 行数变了，主键可能对不上');
  log(changedRows === 1 ? '✓ 只改写了变过的那一行' : `✗ 改写了 ${changedRows} 行，不是增量`);

  // ---- 测试 2：改设置（走 settings 分支） ----
  const settingsBefore = metaSettings();
  await client.evaluate(`document.getElementById('settingsModal').classList.remove('hidden');
    const box = document.getElementById('showNumbersInput'); box.checked = !box.checked;
    document.getElementById('settingsForm').dispatchEvent(new Event('submit', { cancelable: true }));`);
  await sleep(1500);
  const settingsAfter = metaSettings();
  log(settingsBefore !== settingsAfter ? '✓ 设置改动已落进 meta 表' : '✗ 设置没有落盘');

  // ---- 测试 3：改完立刻关窗：防抖窗口内关闭不能丢改动，窗口也必须真的关掉 ----
  const beforeClose = db();
  const favBefore = beforeClose.filter(g => g.fav).length;
  await client.evaluate(`(() => {
    document.getElementById('favoriteButton').click();          // 又切了一次收藏，进入 250ms 防抖
    window.__TAURI__.window.getCurrentWindow().close();          // 立刻关窗（与点右上角 X 同一条路径）
    return true;
  })()`).catch(() => {});
  log('已在防抖窗口内触发关窗');

  // 窗口关没关，看进程是否自己退出——这比看界面更可靠
  let alive = true;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      const out = execSync('tasklist /FI "IMAGENAME eq yijing.exe" /NH', { encoding: 'utf8' });
      alive = out.includes('yijing.exe');
    } catch { alive = false; }
    if (!alive) break;
  }
  log(alive ? '✗ 窗口没关掉，进程还在（关窗被 ACL 挡了？）' : '✓ 窗口已关闭，进程自行退出');
  killAll();
  client.close();

  const afterClose = db();
  const favAfter = afterClose.filter(g => g.fav).length;
  log('关窗后：收藏标记', favAfter, '（关窗前', favBefore, '）');
  log(favAfter !== favBefore ? '✓ 关窗前的改动被抢救下来了' : '✗ 关窗把最后一下改动吞了');
  log('最终行数:', afterClose.length);

  const logFile = path.join(DATA, 'yijing.log');
  if (fs.existsSync(logFile)) {
    log('--- 本次日志（同步相关） ---');
    for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
      if (line.includes('同步') || line.includes('迁移') || line.includes('落盘')) log('   ', line);
    }
  }
  process.exit(0);
})().catch(error => { log('脚本异常:', error.message); killAll(); process.exit(1); });
