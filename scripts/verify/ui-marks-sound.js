// 验证：显示项开关 + 棋盘标记（当前手环 / 候选字母）+ 落子音效合成
// 棋盘标记靠像素取色断言 —— 截图看不出「红环画在棋子外面还是里面」
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9343;
const PROFILE = process.env.CDP_PROFILE || 'C:\\Windows\\Temp\\cdp-marks';
const URL = 'http://127.0.0.1:4173/';
const OUT = 'G:\\Edge_download\\aicoding1\\.workbuddy\\shots\\';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--hide-scrollbars', '--window-size=1460,940', 'about:blank'
], { windowsHide: true, stdio: 'ignore' });

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};

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
  const wake = async () => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 20 });
    await sleep(70);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 706, y: 24 });
    await sleep(220);
  };
  const shot = async (name, clip) => {
    await wake();
    const res = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
    fs.writeFileSync(OUT + name, Buffer.from(res.result.data, 'base64'));
    console.log('  截图 ->', name);
  };
  // 在棋盘画布上按目标色数像素：判断标记到底画上去了没有
  const installProbe = () => evaluate(`window.__probeColor = (cx, cy, half, target, tol) => {
    const dpr = window.devicePixelRatio || 1;
    const cv = document.getElementById('goBoard');
    const ctx = cv.getContext('2d');
    const x = Math.max(0, Math.round((cx - half) * dpr));
    const y = Math.max(0, Math.round((cy - half) * dpr));
    const w = Math.min(cv.width - x, Math.round(half * 2 * dpr));
    const h = Math.min(cv.height - y, Math.round(half * 2 * dpr));
    if (w <= 0 || h <= 0) return -1;
    const data = ctx.getImageData(x, y, w, h).data;
    let hits = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - target[0]) <= tol && Math.abs(data[i+1] - target[1]) <= tol && Math.abs(data[i+2] - target[2]) <= tol) hits++;
    }
    return hits;
  };
  window.__pointAt = (x, y) => { const {pad, step} = boardMetrics(); return {cx: pad + x * step, cy: pad + y * step, radius: step * 0.45, step}; };
  true`);

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  // 改完源码立刻验证时，缓存里可能还留着上一版 core.js
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await sleep(7000);
  await installProbe();

  console.log('\n【1】显示项：dock 标签与设置分组');
  const ui = await evaluate(`JSON.stringify({
    labels: [...document.querySelectorAll('.dock button')].map(b => (b.querySelector('em')?.textContent || '').trim()).filter(Boolean),
    numberTitle: document.getElementById('numberToggle').title,
    heatTitle: document.getElementById('heatToggle').title,
    numberActive: document.getElementById('numberToggle').classList.contains('active'),
    heatActive: document.getElementById('heatToggle').classList.contains('active'),
    legend: document.querySelector('.legend-note')?.textContent.trim() || ''
  })`);
  const u = JSON.parse(ui);
  check('dock 三个显示项都有文字标签', ['手数', 'AI 点', '标记'].every(l => u.labels.includes(l)), u.labels.join(' / '));
  check('开关初始状态为开', u.numberActive && u.heatActive);
  check('提示文案区分数字与字母', /数字/.test(u.legend) && /A \/ B \/ C/.test(u.legend), u.legend);

  await evaluate(`document.getElementById('settingsButton').click(); true`);
  await sleep(400);
  const modal = await evaluate(`JSON.stringify({
    hasGroup: !!document.querySelector('.modal .field-group'),
    groupText: document.querySelector('.modal .field-group > span')?.textContent.trim() || '',
    numbersChecked: document.getElementById('showNumbersInput').checked,
    heatChecked: document.getElementById('showHeatInput').checked
  })`);
  const m = JSON.parse(modal);
  check('设置弹窗里有「棋盘显示」分组', m.hasGroup && m.groupText === '棋盘显示', m.groupText);
  check('分组内两个勾选框已勾上', m.numbersChecked && m.heatChecked);
  await evaluate(`document.getElementById('settingsModal').classList.add('hidden'); true`);

  console.log('\n【2】等待当前局面分析，检查棋盘标记');
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const state = await evaluate(`document.getElementById('candidateList')?.querySelectorAll('.candidate').length || 0`);
    if (state > 0) { ready = true; break; }
    await sleep(2000);
  }
  check('KataGo 返回候选着法', ready);
  if (!ready) { console.log('  引擎没出结果，跳过后面的像素断言'); }

  if (ready) {
    const info = JSON.parse(await evaluate(`JSON.stringify({
      candidates: [...document.querySelectorAll('.candidate-index')].map(e => e.textContent.trim()),
      marks: candidates().map(c => c.move),
      points: candidates().map(c => { const p = __pointAt(c.x, c.y); return {x: c.x, y: c.y, cx: p.cx, cy: p.cy}; }),
      last: (() => { const mv = currentGame.moves[currentMove - 1]; const p = __pointAt(mv.x, mv.y); return {x: mv.x, y: mv.y, cx: p.cx, cy: p.cy, radius: p.radius}; })(),
      step: boardMetrics().step,
      rect: (() => { const r = document.getElementById('goBoard').getBoundingClientRect(); return {left: r.left, top: r.top}; })(),
      total: currentGame.moves.length,
      move: currentMove
    })`));
    check('候选列表面板用字母 A/B/C', info.candidates.every(c => /^[A-Z]$/.test(c)), info.candidates.join(', '));
    check('棋盘候选点与列表数量一致', info.marks.length === info.points.length, info.marks.join(' '));

    // 候选点绿色 #1f7a52
    const greenHits = await evaluate(`window.__probeColor(${info.points[0].cx}, ${info.points[0].cy}, ${Math.round(info.step * 0.5)}, [31,122,82], 42)`);
    check('棋盘上出现 AI 候选标记（绿色）', greenHits > 8, `命中 ${greenHits} 像素 @ ${info.marks[0]}`);

    // 当前手外圈 #d64f34，采样范围覆盖到棋子外侧
    const ringHits = await evaluate(`window.__probeColor(${info.last.cx}, ${info.last.cy}, ${Math.round(info.last.radius * 1.7)}, [214,79,52], 26)`);
    check('当前手有高亮外环（红）', ringHits > 10, `命中 ${ringHits} 像素 @ 第 ${info.move} 手`);

    // 手数关闭：标记体系整体改变，但当前手环必须还在
    const before = await evaluate(`document.getElementById('goBoard').toDataURL().length`);
    await evaluate(`setShowNumbers(false, false); true`);
    await sleep(300);
    const after = await evaluate(`document.getElementById('goBoard').toDataURL().length`);
    const stored = JSON.parse(await evaluate(`localStorage.getItem('yijing.settings')`));
    check('关闭手数后棋盘重绘', before !== after, `${before} -> ${after}`);
    check('开关写进 settings 落盘', stored.showNumbers === false);
    check('dock 按钮同步取消高亮', !(await evaluate(`document.getElementById('numberToggle').classList.contains('active')`)));
    const ringAfter = await evaluate(`window.__probeColor(${info.last.cx}, ${info.last.cy}, ${Math.round(info.last.radius * 1.7)}, [214,79,52], 26)`);
    check('关掉手数后当前手环仍在（找得到着棋点）', ringAfter > 10, `命中 ${ringAfter} 像素`);
    await shot('marks-numbers-off.png');

    // 截图 clip 用的是页面坐标，得把棋盘在视口里的偏移加上
    const zoom = (point, name) => shot(name, {
      x: info.rect.left + point.cx - info.step * 2.2,
      y: info.rect.top + point.cy - info.step * 2.2,
      width: info.step * 4.4, height: info.step * 4.4, scale: 3
    });
    await zoom(info.last, 'marks-zoom-lastmove.png');
    await zoom(info.points[0], 'marks-zoom-candidate.png');

    await evaluate(`setShowNumbers(true, false); true`);
    await sleep(300);
    await shot('marks-numbers-on.png');

    // 工具轨加了文字标签、设置里多了分组，单独放大看一眼有没有挤坏
    const dockBox = JSON.parse(await evaluate(`(() => { const r = document.getElementById('dock').getBoundingClientRect(); return JSON.stringify({x: r.left - 14, y: r.top - 10, width: r.width + 28, height: r.height + 20}); })()`));
    await shot('marks-dock.png', { ...dockBox, scale: 3 });
    await evaluate(`document.getElementById('settingsButton').click(); true`);
    await sleep(500);
    const modalBox = JSON.parse(await evaluate(`(() => { const r = document.querySelector('#settingsModal .modal').getBoundingClientRect(); return JSON.stringify({x: r.left - 12, y: r.top - 12, width: r.width + 24, height: r.height + 24}); })()`));
    await shot('marks-settings.png', { ...modalBox, scale: 2 });
    await evaluate(`document.getElementById('settingsModal').classList.add('hidden'); true`);
  }

  console.log('\n【3】音效合成：节点与包络');
  const audio = JSON.parse(await evaluate(`(() => {
    if (!window.__audioProbePatched) {
      const proto = (window.AudioContext || window.webkitAudioContext).prototype;
      window.__audioProbe = { filters: 0, buffers: 0, oscs: 0 };
      ['createBiquadFilter', 'createBufferSource', 'createOscillator', 'createGain'].forEach(name => {
        const original = proto[name];
        proto[name] = function (...args) { window.__audioProbe[name.replace('createBiquadFilter','filters').replace('createBufferSource','buffers').replace('createOscillator','oscs').replace('createGain','gains')]++; return original.apply(this, args); };
      });
      window.__audioProbePatched = true;
    }
    const snapshot = () => JSON.stringify(window.__audioProbe);
    window.__audioProbe = { filters: 0, buffers: 0, oscs: 0, gains: 0 };
    playStoneSound(false);
    const plain = JSON.parse(snapshot());
    window.__audioProbe = { filters: 0, buffers: 0, oscs: 0, gains: 0 };
    playStoneSound(true);
    const capture = JSON.parse(snapshot());
    return JSON.stringify({ plain, capture, soundEnabled: settings.soundEnabled, state: audioContext ? audioContext.state : 'null', master: !!audioMasterGain });
  })()`));
  check('音效设置开启时能拿到 AudioContext', audio.soundEnabled && audio.state !== 'null', `state=${audio.state}`);
  check('落子声走噪声瞬态路线（带通滤波 + 噪声源）', audio.plain.buffers >= 3 && audio.plain.filters >= 3, JSON.stringify(audio.plain));
  check('提子声是多次敲击的连击', audio.capture.buffers >= audio.plain.buffers * 3, `落子 ${audio.plain.buffers} 个噪声源 -> 提子 ${audio.capture.buffers} 个`);
  check('提子声带低频托底', audio.capture.oscs > audio.plain.oscs, `振荡器 ${audio.plain.oscs} -> ${audio.capture.oscs}`);
  check('音量经 master gain 统一控制', audio.master);
  const muted = await evaluate(`(() => { settings.soundEnabled = false; const ctx = ensureAudio(); settings.soundEnabled = true; return ctx === null; })()`);
  check('关闭音效时完全不建音频上下文', muted === true);

  console.log('\n【4】刷新后开关状态保持');
  await evaluate(`setShowNumbers(false, false); setShowHeat(true, false); true`);
  await sleep(300);
  await send('Page.navigate', { url: URL });
  await sleep(6000);
  await installProbe();
  const persisted = JSON.parse(await evaluate(`JSON.stringify({
    numbers: showNumbers, heat: showHeat,
    numberActive: document.getElementById('numberToggle').classList.contains('active'),
    heatActive: document.getElementById('heatToggle').classList.contains('active'),
    checkboxes: [document.getElementById('showNumbersInput')?.checked, document.getElementById('showHeatInput')?.checked]
  })`));
  check('刷新后手数仍是关闭', persisted.numbers === false && persisted.numberActive === false);
  check('刷新后 dock 高亮与设置勾选同步', persisted.checkboxes[0] === false && persisted.checkboxes[1] === true);

  console.log('\n=== 控制台异常 ===');
  if (problems.length) { problems.slice(0, 8).forEach(p => console.log('  ' + p)); fails++; }
  else console.log('  无');

  console.log(fails ? `\n❌ ${fails} 项未通过` : '\n✅ 全部通过');
  chrome.kill();
  process.exit(fails ? 1 : 0);
})().catch(error => { console.error('脚本失败:', error.message); chrome.kill(); process.exit(2); });
