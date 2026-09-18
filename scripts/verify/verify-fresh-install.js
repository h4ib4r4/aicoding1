// 全新环境验收：模拟「别人刚拿到这个文件夹」——清空应用数据目录后启动，确认
// 不依赖本机任何既有数据也能跑起来。
//
// 关键前提是**先备份再清空**，跑完必须还原，否则会把开发者的棋谱库弄丢。
// 用法：node scripts/verify/verify-fresh-install.js [便携版目录]
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = 'G:\\Edge_download\\aicoding1';
const PORTABLE = process.argv[2] || path.join(ROOT, 'release', '弈境-便携版');
const EXE = path.join(PORTABLE, '弈境.exe');
const DATA = path.join(process.env.APPDATA, 'com.yijing.goreview');
const DB = path.join(DATA, 'yijing.sqlite');
const LOG = path.join(DATA, 'yijing.log');
// stash 必须和 DATA 同一个卷：跨盘 rename 会报 EXDEV（C: → G: 就踩过）
const STASH = path.join(DATA, '..', 'com.yijing.goreview.stash');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function fingerprint(dbPath) {
  // 用 games 表的 key/position/digest 拼一个稳定指纹，判断还原是否逐字节一致
  const out = execSync(
    `"${path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'versions', '3.13.12', 'python.exe')}" -c "` +
    `import sqlite3,hashlib,sys;c=sqlite3.connect(sys.argv[1]);` +
    `r=c.execute('SELECT game_key,position,digest FROM games ORDER BY position').fetchall();` +
    `m=c.execute('SELECT key,length(value) FROM meta ORDER BY key').fetchall();` +
    `print(len(r),hashlib.sha256(str(r).encode()).hexdigest()[:16],m)" "${dbPath}"`,
    { encoding: 'utf8' }
  ).trim();
  return out;
}

function stashExisting() {
  fs.rmSync(STASH, { recursive: true, force: true });
  fs.mkdirSync(STASH, { recursive: true });
  const moved = [];
  for (const name of fs.readdirSync(DATA)) {
    if (name.endsWith('.stash')) continue;
    fs.renameSync(path.join(DATA, name), path.join(STASH, name)); // 同卷，安全
    moved.push(name);
  }
  return moved;
}

function restore(moved) {
  for (const name of moved) {
    const from = path.join(STASH, name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(DATA, name);
    if (fs.existsSync(to)) fs.rmSync(to, { force: true });
    fs.renameSync(from, to);
  }
  fs.rmSync(STASH, { recursive: true, force: true });
}

(async () => {
  if (!fs.existsSync(EXE)) {
    log(`找不到便携版的 exe：${EXE}\n先运行 node scripts/package-portable.mjs`);
    process.exit(1);
  }
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

  const before = fingerprint(DB);
  log(`原库指纹：${before}`);

  let moved = [];
  let child;
  try {
    log('\n--- 移走现有数据，模拟全新机器 ---');
    moved = stashExisting();
    log(`移走 ${moved.length} 项：${moved.join('、') || '（本来就是空的）'}`);

    log(`\n--- 启动 ${path.basename(PORTABLE)}\\弈境.exe ---`);
    child = spawn(EXE, [], { cwd: PORTABLE, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();

    // 等首启流程跑完：载入内置棋谱 → 落库 → 预热引擎
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      if (fs.existsSync(DB) && fs.existsSync(LOG)) {
        const text = fs.readFileSync(LOG, 'utf8');
        if (text.includes('引擎预热完成')) break;
      }
    }

    const text = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
    log('\n--- 启动日志 ---');
    log(text.trim() || '（无日志：前端没跑起来）');

    const checks = [
      ['应用数据目录生成了库', fs.existsSync(DB)],
      ['是首次运行路径', text.includes('按首次运行处理') || text.includes('读到本地棋谱库：11 局')],
      ['内置棋谱已落库', text.includes('写入 11') || text.includes('读到本地棋谱库：11 局')],
      ['引擎从便携版目录加载成功', text.includes('引擎状态：available=true') && text.includes('引擎预热完成')],
      ['日志里没有报错', !/失败|错误|error/i.test(text)]
    ];
    log('\n--- 判定 ---');
    let ok = true;
    for (const [name, pass] of checks) {
      log(`  ${pass ? '✓' : '✗'} ${name}`);
      if (!pass) ok = false;
    }
    if (ok) log(`\n完整库指纹：${fingerprint(DB)}`);
    else log('\n有检查项未通过，见上方日志。');
  } finally {
    log('\n--- 关闭应用并还原数据 ---');
    try { execSync('taskkill /IM 弈境.exe', { stdio: 'ignore' }); } catch {}
    try { execSync('taskkill /IM katago.exe /F', { stdio: 'ignore' }); } catch {}
    await sleep(3000);
    fs.rmSync(DB, { force: true });
    fs.rmSync(LOG, { force: true });
    restore(moved);
    const after = fingerprint(DB);
    log(before === after ? `✓ 已还原，指纹一致：${after}` : `✗ 还原后指纹不同！原 ${before} / 现 ${after}`);
  }
})();
