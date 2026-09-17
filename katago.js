const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  executable: 'G:\\Edge_download\\KataGo\\katago.exe',
  model: 'G:\\Edge_download\\KataGo\\kata1-tf3-b11c768-s11001M-d5973M.bin.gz',
  config: 'G:\\Edge_download\\KataGo\\analysis_example.cfg'
};

function resolveConfig(env = process.env) {
  return {
    executable: env.KATAGO_EXE || DEFAULTS.executable,
    model: env.KATAGO_MODEL || DEFAULTS.model,
    config: env.KATAGO_CONFIG || DEFAULTS.config,
    dataDir: env.KATAGO_DATA_DIR || path.join(__dirname, '.katago-data')
  };
}

function buildQuery({ id, moves, initialStones = [], analyzeTurns, maxVisits = 64, rules = 'chinese', komi = 7.5 }) {
  return {
    id,
    moves: moves.map(move => [move.color, move.pass ? 'pass' : coordsToGtp(move.x, move.y)]),
    initialStones: initialStones
      .filter(stone => stone && !stone.pass && Number.isInteger(stone.x) && Number.isInteger(stone.y) && stone.x >= 0 && stone.x < 19 && stone.y >= 0 && stone.y < 19)
      .map(stone => [stone.color, coordsToGtp(stone.x, stone.y)]),
    rules, komi, boardXSize: 19, boardYSize: 19,
    analyzeTurns, maxVisits, includePolicy: true
  };
}

function coordsToGtp(x, y, size = 19) {
  return `${'ABCDEFGHJKLMNOPQRSTUVWXYZ'[x]}${size - y}`;
}

class KataGoManager {
  constructor(config = resolveConfig()) {
    this.config = config;
    this.process = null;
    this.buffer = '';
    this.pending = new Map();
    this.lastError = '';
  }

  status() {
    const files = Object.fromEntries(['executable', 'model', 'config'].map(key => [key, { path: this.config[key], exists: fs.existsSync(this.config[key]) }]));
    return { ready: Object.values(files).every(file => file.exists), running: Boolean(this.process), backend: 'TensorRT / CUDA', dataDir: this.config.dataDir, files, error: this.lastError };
  }

  start() {
    if (this.process) return;
    const status = this.status();
    if (!status.ready) throw new Error('KataGo 可执行文件、模型或配置文件不存在');
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    const dataDir = this.config.dataDir.replace(/\\/g, '/');
    this.process = spawn(this.config.executable, ['analysis', '-model', this.config.model, '-config', this.config.config, '-override-config', `homeDataDir=${dataDir},logDir=${dataDir}/logs`], { windowsHide: true });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', chunk => this.consume(chunk));
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', chunk => {
      const line = chunk.trim();
      if (/error|failed|exception/i.test(line)) this.lastError = line.split(/\r?\n/).slice(-1)[0];
    });
    this.process.on('exit', code => {
      this.process = null;
      const error = new Error(`KataGo 进程已退出（${code}）`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let result;
      try { result = JSON.parse(line); } catch { continue; }
      const request = this.pending.get(String(result.id));
      if (!request) continue;
      if (result.error) {
        clearTimeout(request.timer); this.pending.delete(String(result.id)); request.reject(new Error(result.error)); continue;
      }
      request.results.push(result);
      if (request.results.length >= request.expected) {
        clearTimeout(request.timer); this.pending.delete(String(result.id)); request.resolve(request.results.sort((a, b) => a.turnNumber - b.turnNumber));
      }
    }
  }

  analyze(input) {
    this.start();
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const query = buildQuery({ ...input, id });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('KataGo 分析超时')); }, 180000);
      this.pending.set(id, { expected: query.analyzeTurns.length, results: [], resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify(query)}\n`);
    });
  }

  close() { if (this.process) this.process.kill(); }
}

module.exports = { KataGoManager, resolveConfig, buildQuery, coordsToGtp };
