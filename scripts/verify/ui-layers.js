// 分层界面验证：逐层截图 + 测量棋盘占比与遮挡关系
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const OUT = 'G:\\Edge_download\\aicoding1\\.workbuddy\\shots\\';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=C:\\Windows\\Temp\\cdp-layers',
  '--hide-scrollbars', '--window-size=1460,940', 'about:blank'
], { windowsHide: true, stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('无法连接 Chrome 调试端口');
}

(async () => {
  const page = await target();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const waiters = new Map();
  const problems = [];
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') problems.push('异常: ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text));
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) problems.push('控制台: ' + msg.params.args.map(a => a.value ?? a.description).join(' '));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') problems.push(`[${msg.params.entry.source}] ${msg.params.entry.text}`);
  });
  await new Promise(resolve => ws.addEventListener('open', resolve));
  const send = (method, params = {}) => new Promise(resolve => { const mid = ++id; waiters.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evaluate = async expression => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || 'eval 失败');
    return res.result?.result?.value;
  };
  // 悬停层会静止淡出，截图前先让鼠标动一下把控件唤回
  const wake = async () => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 20 });
    await sleep(70);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 706, y: 24 });
    await sleep(220);
  };
  const shot = async name => {
    await wake();
    const res = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT + name, Buffer.from(res.result.data, 'base64'));
    console.log('  截图 ->', name);
  };
  const viewport = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await viewport(1440, 900);
  await send('Page.navigate', { url: 'http://127.0.0.1:4173/' });
  await sleep(7000);

  const measure = async label => {
    await wake();
    const data = await evaluate(`(() => {
      const box = sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect();
        const visible = r.width > 1 && r.height > 1 && getComputedStyle(el).opacity > .35 && !el.classList.contains('hidden');
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible }; };
      const board = document.querySelector('#goban').getBoundingClientRect();
      const vw = innerWidth, vh = innerHeight;
      const overlap = (a, b) => a && b ? Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)) : 0;
      const b = { x: board.x, y: board.y, w: board.width, h: board.height };
      const parts = { info: box('.hud-info'), dock: box('.dock'), bar: box('.player-bar'), library: box('#libraryDrawer'), analysis: box('#analysis-panel'), timeline: box('#chart-panel') };
      const overlaps = {};
      for (const [key, value] of Object.entries(parts)) if (value && value.visible) overlaps[key] = Math.round(overlap(b, value));
      return {
        viewport: vw + '×' + vh,
        board: { w: Math.round(b.w), h: Math.round(b.h) },
        boardHeightRatio: +(b.h / vh).toFixed(3),
        boardAreaRatio: +((b.w * b.h) / (vw * vh)).toFixed(3),
        canvasPx: document.querySelector('#goBoard').width,
        ratios: parts,
        overlaps,
        bodyClass: document.body.className,
        hint: document.getElementById('hintBar').textContent
      };
    })()`);
    console.log(`\n【${label}】`, JSON.stringify(data, null, 1).replace(/\n\s*/g, ' '));
    return data;
  };

  console.log('=== 第 1 层：纯棋盘 ===');
  const base = await measure('默认');
  await shot('layer-1-board.png');

  console.log('\n=== 第 2 层：点击工具轨 ===');
  await evaluate(`document.getElementById('dockLibrary').click()`);
  await sleep(900);
  await measure('棋谱库浮层');
  await shot('layer-2-library.png');

  console.log('\n=== 第 3 层：固定为并排 ===');
  await evaluate(`document.querySelector('[data-pin="library"]').click()`);
  await sleep(900);
  await measure('棋谱库并排');
  await evaluate(`document.getElementById('dockAnalysis').click()`);
  await sleep(1500);
  await evaluate(`document.querySelector('[data-pin="analysis"]').click()`);
  await sleep(1400);
  const docked = await measure('棋谱库 + AI 分析并排');
  await shot('layer-3-docked.png');

  console.log('\n=== 第 4 层：走势条 → 完整图表 ===');
  await evaluate(`document.getElementById('dockLibrary').click();document.getElementById('dockAnalysis').click();document.getElementById('dockTimeline').click()`);
  await sleep(1100);
  await measure('走势细带');
  await shot('layer-4-timeline-strip.png');
  await evaluate(`document.getElementById('timelineExpandButton').click()`);
  await sleep(1100);
  await evaluate(`document.querySelector('.chart-tabs button[data-chart="score"]').click()`);
  await sleep(500);
  const expanded = await measure('走势展开·目差');
  await shot('layer-5-timeline-full.png');

  console.log('\n=== 第 5 层：专注模式 ===');
  await evaluate(`document.getElementById('dockTimeline').click();document.getElementById('focusButton').click()`);
  await sleep(1200);
  const focus = await measure('专注');
  await shot('layer-6-focus.png');
  await evaluate(`document.getElementById('focusButton').click()`);
  await sleep(900);

  console.log('\n=== 窄窗口回退（1024×768）===');
  await viewport(1024, 768);
  await sleep(1200);
  await measure('窄屏');
  await shot('layer-7-narrow.png');

  console.log('\n=== 控制台问题 ===');
  console.log(problems.length ? problems.slice(0, 12).join('\n') : '无');
  console.log('\n=== 关键指标 ===');
  console.log('默认棋盘高占视口:', base.boardHeightRatio, '面积占比:', base.boardAreaRatio, '遮罩:', JSON.stringify(base.overlaps));
  console.log('并排时棋盘:', docked.board, '遮罩:', JSON.stringify(docked.overlaps));
  console.log('走势展开:', expanded.board, '遮罩:', JSON.stringify(expanded.overlaps));
  console.log('专注:', focus.board, '面积占比:', focus.boardAreaRatio);
  chrome.kill();
  process.exit(0);
})();
