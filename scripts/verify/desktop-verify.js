// 桌面版实机验证：启动打包后的 exe，经 WebView2 调试端口确认运行时是真的接上了，
// 而不只是「进程起来了」。检查项：Tauri 桥可用、棋谱库落到应用数据目录、
// 引擎状态是真实查询结果、界面无异常、棋盘确实画出来了。
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = 'G:\\Edge_download\\aicoding1';
const EXE = path.join(ROOT, 'src-tauri', 'target', 'release', 'yijing.exe');
const PORT = 9333;
const OUT = path.join(ROOT, '.workbuddy', 'shots') + '\\';
const LIB = path.join(os.homedir(), 'AppData', 'Roaming', 'com.yijing.goreview', 'library.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(label);
};

function killStray() {
  for (const name of ['yijing.exe', 'katago.exe']) {
    try { execSync(`taskkill /IM ${name} /F`, { stdio: 'ignore' }); } catch {}
  }
}

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  return null;
}

(async () => {
  if (!fs.existsSync(EXE)) {
    console.error(`找不到 ${EXE}，请先构建`);
    process.exit(1);
  }
  killStray();
  const backup = fs.existsSync(LIB) ? fs.readFileSync(LIB, 'utf8') : null;
  const hadLibrary = backup !== null;
  if (hadLibrary) fs.unlinkSync(LIB); // 干净起步，验证「首次运行会生成文件」
  console.log(`启动 ${EXE}`);
  console.log(`（验证前已备份既有棋谱库：${hadLibrary ? '是' : '无'}）\n`);

  const app = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: 'ignore',
    detached: false
  });

  const page = await target();
  if (!page) {
    console.log('\n未能连上 WebView2 调试端口。应用窗口本身可能已正常打开，');
    console.log('但无法脚本化断言。请手动确认窗口内容。');
    await sleep(1500);
    app.kill();
    killStray();
    process.exit(2);
  }

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
  const shot = async name => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT + name, Buffer.from(res.result.data, 'base64'));
    console.log(`  截图 -> ${name}`);
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  // 等界面初始化与首次分析跑起来
  await sleep(3500);

  console.log('运行时');
  check(await evaluate('Boolean(window.__TAURI__?.core?.invoke)'), 'Tauri 桥可用');
  check(await evaluate('document.title.includes("弈境")'), '窗口标题已跟随棋谱', await evaluate('document.title'));

  console.log('\n引擎状态');
  const status = await evaluate('window.__TAURI__.core.invoke("katago_status")');
  check(status?.available === true, 'KataGo 运行文件齐全', `路径来源：${status?.source}`);
  check(['stopped', 'loading', 'ready'].includes(status?.state), '引擎状态可读', `state=${status?.state}`);
  const label = await evaluate('document.getElementById("engineStatus")?.textContent?.trim()');
  check(Boolean(label) && label !== '连接 KataGo', '面板显示真实引擎状态', `显示为「${label}」`);

  console.log('\n棋盘渲染');
  const canvas = await evaluate(`(() => {
    const cv = document.getElementById('goBoard');
    const ctx = cv.getContext('2d');
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4 * 97) if (data[i] > 0) painted++;
    return { w: cv.width, h: cv.height, ratio: painted / (data.length / (4 * 97)) };
  })()`);
  check(canvas.ratio > 0.9, '棋盘已绘制', `${canvas.w}×${canvas.h}，不透明像素 ${(canvas.ratio * 100).toFixed(1)}%`);

  console.log('\n本地棋谱库');
  await sleep(1200); // 等 saveLibrary 的 400ms 合并写盘
  const exists = fs.existsSync(LIB);
  check(exists, '棋谱库已写入应用数据目录', LIB);
  if (exists) {
    const payload = JSON.parse(fs.readFileSync(LIB, 'utf8'));
    check(Array.isArray(payload.games) && payload.games.length > 0, '棋谱库内容非空', `${payload.games?.length || 0} 局`);
  }

  console.log('\n界面异常');
  const relevant = problems.filter(p => !/DevTools|Autofill|favicon/i.test(p));
  check(relevant.length === 0, '无控制台错误', relevant.slice(0, 4).join(' | '));

  await shot('desktop-main.png');
  // 打开分析面板再截一张，确认抽屉层在桌面窗口里工作正常
  await evaluate('document.getElementById("dockAnalysis").click()');
  await sleep(900);
  await shot('desktop-analysis.png');

  console.log(`\n${failures.length ? '失败项：' + failures.join('、') : '全部通过'}`);
  ws.close();
  app.kill();
  await sleep(600);
  killStray();

  if (hadLibrary) fs.writeFileSync(LIB, backup);
  process.exit(failures.length ? 1 : 0);
})().catch(async error => {
  console.error('验证脚本出错：', error.message);
  killStray();
  process.exit(1);
});
