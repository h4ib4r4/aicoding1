// 验证键盘快捷键 + 整局分析后的真实走势渲染
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9347;
const OUT = 'G:\\Edge_download\\aicoding1\\.workbuddy\\shots\\';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=C:\\Windows\\Temp\\cdp-full',
  '--hide-scrollbars', '--window-size=1460,940', 'about:blank'
], { windowsHide: true, stdio: 'ignore' });

(async () => {
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {}
    if (!page) await sleep(500);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const waiters = new Map();
  const problems = [];
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') problems.push('异常: ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') problems.push('控制台: ' + msg.params.args.map(a => a.value ?? a.description).join(' '));
  });
  await new Promise(resolve => ws.addEventListener('open', resolve));
  const send = (method, params = {}) => new Promise(resolve => { const mid = ++id; waiters.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const shot = async name => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 20 });
    await sleep(50);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 704, y: 26 });
    await sleep(260);
    const res = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT + name, Buffer.from(res.result.data, 'base64'));
    console.log('  截图 ->', name);
  };
  const key = async (k, code, vk, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    await sleep(700);
  };
  const state = () => evaluate(`JSON.stringify({ open: ['library','analysis','timeline'].filter(n => document.querySelector('[data-dock="'+n+'"]').classList.contains('active')), focus: document.body.classList.contains('focus'), infoHidden: document.body.classList.contains('info-hidden'), boardPx: Math.round(document.querySelector('#goban').getBoundingClientRect().width), focused: document.activeElement.id || document.activeElement.tagName })`);

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:4173/' });
  await sleep(8000);

  console.log('=== 快捷键 ===');
  console.log('初始      ', await state());
  await key('l', 'KeyL', 76); console.log('按 L      ', await state());
  await key('Escape', 'Escape', 27); console.log('按 Esc    ', await state());
  await key('t', 'KeyT', 84); console.log('按 T      ', await state());
  await key('t', 'KeyT', 84); console.log('再按 T    ', await state());
  await key('a', 'KeyA', 65); console.log('按 A      ', await state());
  await key('a', 'KeyA', 65);
  await key('f', 'KeyF', 70); console.log('按 F      ', await state());
  await key('f', 'KeyF', 70); console.log('再按 F    ', await state());
  await key('k', 'KeyK', 75, 4); console.log('按 Ctrl+K ', await state());
  await key('Escape', 'Escape', 27);

  console.log('\n=== 整局分析（等 KataGo 跑完）===');
  await evaluate(`document.getElementById('dockTimeline').click()`);
  await sleep(900);
  await evaluate(`document.getElementById('analyzeButton').click()`);
  const started = Date.now();
  for (let i = 0; i < 150; i++) {
    await sleep(4000);
    const progress = await evaluate(`JSON.stringify({ label: document.getElementById('analysisLabel').textContent, size: analyses.size, total: currentGame.moves.length })`);
    const info = JSON.parse(progress);
    if (i % 4 === 0) console.log('  ', Math.round((Date.now() - started) / 1000) + 's', info.label, info.size + '/' + (info.total + 1));
    if (/完成|失败/.test(info.label)) { console.log('  结束:', info.label, info.size + ' 个局面'); break; }
  }

  console.log('\n=== 真实走势渲染 ===');
  await evaluate(`document.getElementById('timelineExpandButton').click()`);
  await sleep(900);
  await shot('chart-real-winrate.png');
  const winrateStats = await evaluate(`(() => {
    const values = [...analyses.values()].map(r => r.rootInfo.winrate * 100);
    const leads = [...analyses.values()].map(r => Number(r.rootInfo.scoreLead || 0));
    return JSON.stringify({ 手数: analyses.size, 胜率区间: [Math.min(...values).toFixed(1), Math.max(...values).toFixed(1)], 目差区间: [Math.min(...leads).toFixed(1), Math.max(...leads).toFixed(1)] });
  })()`);
  console.log('  ', winrateStats);
  await evaluate(`document.querySelector('.chart-tabs button[data-chart="score"]').click()`);
  await sleep(500);
  await shot('chart-real-score.png');

  // 关键手：找出波动最大的几手，跳到那里看棋盘标注
  const swings = await evaluate(`(() => {
    const rows = [...analyses.values()].sort((a, b) => a.turnNumber - b.turnNumber);
    const deltas = rows.map((r, i) => i ? { turn: r.turnNumber, delta: r.rootInfo.winrate * 100 - rows[i - 1].rootInfo.winrate * 100 } : null).filter(Boolean);
    deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return JSON.stringify(deltas.slice(0, 5).map(d => ({ 手: d.turn, 波动: d.delta.toFixed(1) })));
  })()`);
  console.log('  波动最大的五手:', swings);
  const worst = JSON.parse(swings)[0]['手'];
  await evaluate(`setMove(${worst})`);
  await sleep(2500);
  await shot('chart-real-critical.png');
  console.log('  已跳到第', worst, '手');

  console.log('\n=== 控制台问题 ===');
  console.log(problems.length ? problems.slice(0, 10).join('\n') : '无');
  chrome.kill();
  process.exit(0);
})();
