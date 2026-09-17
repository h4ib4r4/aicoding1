// 最终验收：从「用户原始数据」出发，跑一遍迁移，确认应用能正常加载、能正常关掉。
// 顺便把测试期间被点来点去的数据恢复成原始状态。
const { spawn, execSync, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const RELEASE = 'G:\\Edge_download\\aicoding1\\src-tauri\\target\\release';
const DATA = path.join(process.env.APPDATA, 'com.yijing.goreview');
const DB = path.join(DATA, 'yijing.sqlite');
const LOG = path.join(DATA, 'yijing.log');
const SNAPSHOT = 'G:\\Edge_download\\aicoding1\\.workbuddy\\tmp\\library.json.snapshot';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function killAll() {
  for (const name of ['yijing.exe', 'katago.exe']) {
    try { execSync(`taskkill /IM ${name} /F`, { stdio: 'ignore' }); } catch {}
  }
}
function alive() {
  try {
    return execSync('tasklist /FI "IMAGENAME eq yijing.exe" /NH', { encoding: 'utf8' }).includes('yijing.exe');
  } catch { return false; }
}
function query(script) {
  return JSON.parse(execFileSync('python', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
}

(async () => {
  // 恢复成用户原始数据：有 library.json，没有数据库
  killAll();
  await sleep(1200);
  for (const name of fs.readdirSync(DATA)) {
    if (name.startsWith('library.json') || name === 'yijing.sqlite' || name.startsWith('yijing.sqlite-') || name === 'yijing.log') {
      fs.rmSync(path.join(DATA, name), { force: true });
    }
  }
  const original = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  fs.copyFileSync(SNAPSHOT, path.join(DATA, 'library.json'));
  log(`已恢复用户原始数据：library.json 里 ${original.games.length} 局，收藏 ${original.games.filter(g => g.favorite).length} 局`);

  spawn(path.join(RELEASE, 'yijing.exe'), [], { cwd: RELEASE, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (fs.existsSync(DB)) {
      try {
        if (query(`import sqlite3,json;c=sqlite3.connect(r'${DB}');print(json.dumps(c.execute('SELECT COUNT(*) FROM games').fetchone()[0]))`) > 0) break;
      } catch {}
    }
  }

  const state = query(`
import json, sqlite3
c = sqlite3.connect(r'${DB}')
games = [json.loads(r[0]) for r in c.execute('SELECT payload FROM games ORDER BY position')]
meta = {k: v for k, v in c.execute('SELECT key, value FROM meta')}
print(json.dumps({
  'rows': len(games),
  'version': c.execute('PRAGMA user_version').fetchone()[0],
  'favorites': sum(1 for g in games if g.get('favorite')),
  'first': games[0].get('title') if games else None,
  'ancient': sum(1 for g in games if g.get('ruleset') == 'ancient-chinese'),
  'setups': [len(g.get('setup') or []) for g in games if g.get('ruleset') == 'ancient-chinese'],
  'hasSettings': 'settings' in meta,
  'tables': sorted(r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")),
}))
`);
  const expectedFavorites = original.games.filter(g => g.favorite).length;
  log('迁移结果：', JSON.stringify(state));
  log(state.rows === original.games.length ? `✓ 局数一致（${state.rows}）` : `✗ 局数不符：期望 ${original.games.length}`);
  log(state.version === 1 ? '✓ 结构版本为 1' : '✗ 结构版本不对');
  log(state.favorites === expectedFavorites ? `✓ 收藏状态与原始数据一致（${state.favorites}）` : `✗ 收藏状态被改动过：${state.favorites} vs ${expectedFavorites}`);
  log(state.ancient === 10 && state.setups.every(n => n === 4) ? '✓ 十局古谱仍带四颗座子' : '✗ 古谱座子丢失');
  log(state.hasSettings ? '✓ 设置已迁移' : '✗ 设置丢失');
  log(!JSON.stringify(state.tables).includes('game_search') ? '✓ 已无遗留的旧表' : '✗ 旧表还在');

  // 优雅关窗（等同点 X）
  try { execSync('taskkill /IM yijing.exe', { stdio: 'ignore' }); } catch {}
  let closed = false;
  for (let i = 0; i < 24; i++) { await sleep(500); if (!alive()) { closed = true; break; } }
  log(closed ? '✓ 点 X 能正常关闭应用' : '✗ 应用关不掉');
  if (!closed) killAll();

  const text = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  const denied = text.split('\n').filter(l => l.includes('not allowed by ACL'));
  const errors = text.split('\n').filter(l => l.includes('未捕获错误') || l.includes('未处理的拒绝'));
  log(denied.length === 0 && errors.length === 0 ? '✓ 运行期没有权限或未捕获错误' : `✗ 日志里有异常：\n${[...denied, ...errors].join('\n')}`);
  log('--- 本次日志 ---');
  for (const line of text.split('\n').filter(Boolean)) log('   ', line);
  process.exit(closed && state.rows === original.games.length && state.version === 1 && denied.length === 0 && errors.length === 0 ? 0 : 1);
})().catch(error => { log('脚本异常:', error.message); killAll(); process.exit(1); });
