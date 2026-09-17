// 生成绿色便携版：应用与 KataGo 引擎装进同一个目录，整个文件夹拷走就能在别的机器上运行。
// 用法：先 npm run tauri build -- --no-bundle，再 node scripts/package-portable.mjs
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const executable = join(root, 'src-tauri', 'target', 'release', 'yijing.exe');
const engineDir = process.env.KATAGO_DIR || 'G:/Edge_download/KataGo';
const output = join(root, 'release', '弈境-便携版');
const engineTarget = join(output, 'katago');

if (!existsSync(executable)) {
  console.error(`找不到 ${executable}\n请先运行：npm run tauri build -- --no-bundle`);
  process.exit(1);
}
if (!existsSync(engineDir)) {
  console.error(`找不到 KataGo 目录：${engineDir}\n可用 KATAGO_DIR 环境变量指定。`);
  process.exit(1);
}

// 日志与训练数据缓存没必要跟着走，模型和运行库才是必需
const skip = new Set(['gtp_logs', 'KataGoData']);

rmSync(output, { recursive: true, force: true });
mkdirSync(engineTarget, { recursive: true });
cpSync(executable, join(output, '弈境.exe'));

let model = null;
let modelSize = 0;
let copied = 0;
let bytes = 0;
for (const entry of readdirSync(engineDir)) {
  if (skip.has(entry)) continue;
  const source = join(engineDir, entry);
  if (!statSync(source).isFile()) continue;
  cpSync(source, join(engineTarget, entry));
  copied++;
  bytes += statSync(source).size;
  if (entry.endsWith('.bin.gz') || entry.endsWith('.txt.gz')) {
    const size = statSync(source).size;
    if (size > modelSize) { modelSize = size; model = entry; }
  }
}

if (!model) {
  console.error(`在 ${engineDir} 里没找到神经网络模型（*.bin.gz）`);
  process.exit(1);
}

// 相对路径由应用按「exe 所在目录」解析，换盘符/换用户名都不影响
writeFileSync(join(output, 'katago.json'), JSON.stringify({
  executable: './katago/katago.exe',
  model: `./katago/${model}`,
  config: './katago/analysis_example.cfg'
}, null, 2));

console.log(`便携版已生成：${output}`);
console.log(`  应用   弈境.exe`);
console.log(`  引擎   katago/ 共 ${copied} 个文件，${(bytes / 1024 / 1024).toFixed(0)} MB（模型 ${model}）`);
console.log('把整个「弈境-便携版」目录拷到任何 Windows 机器即可运行（需系统自带 WebView2）。');
