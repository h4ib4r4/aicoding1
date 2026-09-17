// 用 CDP 驱动无头 Chrome，做前端交互冒烟测试并收集控制台错误
const { spawn } = require('node:child_process');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const OUT = 'G:\\Edge_download\\aicoding1\\.workbuddy\\shots\\';
const fs = require('node:fs');

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.CDP_PROFILE || 'C:\\Windows\\Temp\\cdp-profile'}`,
  '--window-size=1680,1080', 'about:blank'
], { windowsHide: true, stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('无法连接 Chrome 调试端口');
}

(async () => {
  const target = await targets();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const waiters = new Map();
  const consoleErrors = [];
  const exceptions = [];

  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      consoleErrors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
    }
    if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry.level)) {
      consoleErrors.push(`[${msg.params.entry.source}] ${msg.params.entry.text}`);
    }
  });

  await new Promise(resolve => ws.addEventListener('open', resolve));
  const send = (method, params = {}) => new Promise(resolve => { const mid = ++id; waiters.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  console.log('--- 打开页面 ---');
  await send('Page.navigate', { url: 'http://127.0.0.1:4173/' });
  await sleep(12000);

  const shoot = async name => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT + name, Buffer.from(res.result.data, 'base64'));
    console.log('截图:', name);
  };
  const evaluate = async expression => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return res.result?.result?.value;
  };

  console.log('--- 页面状态 ---');
  console.log(await evaluate(`JSON.stringify({
    games: document.querySelectorAll('.game-card').length,
    moves: document.getElementById('moveTotal').textContent,
    black: document.getElementById('blackWin').textContent,
    lead: document.getElementById('scoreLead').textContent,
    candidates: document.querySelectorAll('.candidate').length,
    engine: document.getElementById('engineStatus').textContent,
    ruleChip: document.getElementById('ruleChip').classList.contains('hidden') ? '(隐藏)' : document.getElementById('ruleChip').textContent,
    ruleChipTitle: document.getElementById('ruleChip').title,
    taxNote: document.getElementById('taxNote').classList.contains('hidden') ? '(隐藏)' : document.getElementById('taxNote').textContent,
    chartRuleNote: document.getElementById('chartRuleNote').textContent,
    storedRuleset: (() => { try { const g = JSON.parse(localStorage.getItem('yijing.games') || '[]')[0]; return g ? (g.ruleset || '(无)') : '(空)'; } catch { return '(读取失败)'; } })()
  }, null, 0)`), );

  console.log('--- 分析请求实测（第 40 手）---');
  console.log(await evaluate(`(async () => {
    const rules = window.YijingCore.resolveRules(currentGame);
    const response = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moves: currentGame.moves, initialStones: currentGame.setup || [], analyzeTurns: [40], maxVisits: 120, rules: rules.rules, komi: rules.komi })
    });
    const body = await response.json();
    const info = body.results[0].rootInfo;
    return '规则=' + rules.name + ' 贴目=' + rules.komi + ' 还棋头=' + rules.groupTax
      + ' | 黑棋胜率 ' + (info.winrate * 100).toFixed(1) + '%  目差 ' + info.scoreLead.toFixed(1);
  })()`));

  await shoot('rules-applied.png');

  console.log('--- 交互：连点下一手 5 次 ---');
  for (let i = 0; i < 5; i++) { await evaluate(`document.getElementById('nextButton').click()`); await sleep(900); }
  console.log(await evaluate(`JSON.stringify({ move: document.getElementById('moveNumber').textContent, black: document.getElementById('blackWin').textContent, lead: document.getElementById('scoreLead').textContent })`));
  await shoot('after-moves.png');

  console.log('--- 交互：切到目差图 + 网格视图 + 收藏 ---');
  await evaluate(`document.querySelector('.chart-tabs button[data-chart="score"]').click()`);
  await evaluate(`document.getElementById('favoriteButton').click()`);
  await evaluate(`document.getElementById('gridViewButton').click()`);
  await sleep(1500);
  console.log(await evaluate(`JSON.stringify({ title: document.getElementById('chartTitle').textContent, grid: document.getElementById('gameList').className, fav: document.getElementById('favoriteButton').textContent })`));
  await shoot('chart-score-grid.png');

  console.log('--- 交互：跳到最后一手 ---');
  await evaluate(`document.getElementById('lastButton').click()`);
  await sleep(1200);
  console.log(await evaluate(`JSON.stringify({ move: document.getElementById('moveNumber').textContent, total: document.getElementById('moveTotal').textContent })`));
  await shoot('last-move.png');

  console.log('--- 控制台异常 ---');
  console.log('exceptions:', exceptions.length ? exceptions : '无');
  console.log('console errors/warnings:', consoleErrors.length ? consoleErrors : '无');

  chrome.kill();
  process.exit(0);
})().catch(err => { console.error('失败:', err.message); chrome.kill(); process.exit(1); });
