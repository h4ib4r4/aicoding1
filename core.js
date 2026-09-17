(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.YijingCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const BOARD_SIZE = 19;

  function emptyBoard(size = BOARD_SIZE) {
    return Array.from({ length: size }, () => Array(size).fill(null));
  }

  function neighbors(x, y, size = BOARD_SIZE) {
    return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
      .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < size && ny < size);
  }

  function groupAt(board, x, y) {
    const color = board[y]?.[x];
    if (!color) return { stones: [], liberties: [] };
    const seen = new Set();
    const liberties = new Set();
    const stones = [];
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      const key = `${cx},${cy}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stones.push([cx, cy]);
      for (const [nx, ny] of neighbors(cx, cy, board.length)) {
        if (!board[ny][nx]) liberties.add(`${nx},${ny}`);
        else if (board[ny][nx] === color && !seen.has(`${nx},${ny}`)) stack.push([nx, ny]);
      }
    }
    return { stones, liberties: [...liberties].map(p => p.split(',').map(Number)) };
  }

  function applyMove(board, move) {
    const next = board.map(row => row.slice());
    if (!move || move.pass) return next;
    const { x, y, color } = move;
    if (x < 0 || y < 0 || x >= next.length || y >= next.length || next[y][x]) return null;
    next[y][x] = color;
    const opponent = color === 'B' ? 'W' : 'B';
    for (const [nx, ny] of neighbors(x, y, next.length)) {
      if (next[ny][nx] === opponent) {
        const group = groupAt(next, nx, ny);
        if (!group.liberties.length) group.stones.forEach(([gx, gy]) => { next[gy][gx] = null; });
      }
    }
    if (!groupAt(next, x, y).liberties.length) return null;
    return next;
  }

  function replay(moves, count, size = BOARD_SIZE, setup = []) {
    let board = emptyBoard(size);
    for (const stone of setup) {
      if (!stone.pass && stone.x >= 0 && stone.y >= 0 && stone.x < size && stone.y < size) board[stone.y][stone.x] = stone.color;
    }
    for (const move of moves.slice(0, count)) {
      const updated = applyMove(board, move);
      if (updated) board = updated;
    }
    return board;
  }

  function capturedStones(moves, count, size = BOARD_SIZE, setup = []) {
    if (!Number.isInteger(count) || count <= 0 || count > moves.length) return 0;
    const before = replay(moves, count - 1, size, setup);
    const move = moves[count - 1];
    const after = applyMove(before, move);
    if (!after || !move || move.pass) return 0;
    const opponent = move.color === 'B' ? 'W' : 'B';
    let captured = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (before[y][x] === opponent && !after[y][x]) captured++;
    }
    return captured;
  }

  function groupCounts(board) {
    const size = board.length;
    const seen = Array.from({ length: size }, () => Array(size).fill(false));
    const counts = { B: 0, W: 0 };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const color = board[y][x];
      if (!color || seen[y][x]) continue;
      for (const [gx, gy] of groupAt(board, x, y).stones) seen[gy][gx] = true;
      if (counts[color] !== undefined) counts[color]++;
    }
    return counts;
  }

  // 明清「还棋头」：除自己的第一块棋外，每多一块要还对方 2 目。
  // 返回该项对黑棋目差的修正（正数表示黑棋得益，因为白棋块数更多）。
  function groupTaxAdjustment(board, pointsPerExtraGroup = 2) {
    const counts = groupCounts(board);
    const paid = color => Math.max(0, counts[color] - 1) * pointsPerExtraGroup;
    return paid('W') - paid('B');
  }

  // 棋盘上每颗子该显示的手数。同一交叉点被反复争夺时取最后一次落子，
  // 与「第 N 手落在哪里」的直觉一致。
  function moveNumberAt(moves, upTo) {
    const list = Array.isArray(moves) ? moves : [];
    const limit = Math.max(0, Math.min(Number.isFinite(Number(upTo)) ? Number(upTo) : list.length, list.length));
    const numbers = new Map();
    for (let index = 0; index < limit; index++) {
      const move = list[index];
      if (!move || move.pass) continue;
      numbers.set(`${move.x},${move.y}`, index + 1);
    }
    return numbers;
  }

  // AI 候选点用字母、手数用数字：两套标记从字形上就分得开，
  // 棋盘与候选列表共用这一份，避免两边对不上号。
  const CANDIDATE_MARKS = ['A', 'B', 'C'];

  // 古谱与现代棋谱的评估前提不同：座子制、白先、无贴目、还棋头。
  const RULE_PRESETS = {
    modern: { id: 'modern', name: '现代规则', rules: 'chinese', komi: 7.5, groupTax: false, note: '中国规则 · 贴 7.5 目' },
    'ancient-chinese': { id: 'ancient-chinese', name: '明清规则', rules: 'chinese', komi: 0, groupTax: true, note: '座子 · 白先 · 无贴目 · 还棋头' }
  };

  function resolveRules(meta = {}) {
    const key = typeof meta.ruleset === 'string' ? meta.ruleset : '';
    const preset = RULE_PRESETS[key] || RULE_PRESETS.modern;
    const raw = meta.komi;
    const explicit = raw !== null && raw !== undefined && raw !== '';
    const komi = explicit && Number.isFinite(Number(raw)) ? Number(raw) : preset.komi;
    return { ...preset, komi };
  }

  function sgfPoint(value, size = BOARD_SIZE) {
    if (!value || value.length < 2) return { pass: true };
    const x = value.charCodeAt(0) - 97;
    const y = value.charCodeAt(1) - 97;
    return x < 0 || y < 0 || x >= size || y >= size ? { pass: true } : { x, y };
  }

  function mainSgfSequence(text) {
    function readTree(start) {
      let result = '', inValue = false, escaped = false, followedFirstChild = false;
      for (let i = start + 1; i < text.length; i++) {
        const char = text[i];
        if (escaped) { result += char; escaped = false; continue; }
        if (inValue && char === '\\') { result += char; escaped = true; continue; }
        if (char === '[') { inValue = true; result += char; continue; }
        if (char === ']') { inValue = false; result += char; continue; }
        if (!inValue && char === '(') {
          const child = readTree(i);
          if (!followedFirstChild) { result += child.result; followedFirstChild = true; }
          i = child.end;
          continue;
        }
        if (!inValue && char === ')') return { result, end: i };
        result += char;
      }
      return { result, end: text.length - 1 };
    }
    const start = text.indexOf('(');
    return start < 0 ? '' : readTree(start).result;
  }

  function parseSgf(text) {
    if (typeof text !== 'string' || !text.includes('(;')) throw new Error('不是有效的 SGF 文件');
    const main = mainSgfSequence(text);
    const prop = key => {
      const match = main.match(new RegExp(`${key}\\[((?:\\\\.|[^\\]])*)\\]`));
      return match ? match[1].replace(/\\\]/g, ']').replace(/\\\\/g, '\\') : '';
    };
    const boardSize = Number(prop('SZ') || BOARD_SIZE);
    if (boardSize !== BOARD_SIZE) throw new Error(`目前仅支持 19 路棋谱，此文件为 ${boardSize} 路`);
    const setup = [];
    for (const [key, color] of [['AB','B'],['AW','W']]) {
      const group = main.match(new RegExp(`${key}((?:\\[(?:\\\\.|[^\\]])*\\])+)`));
      if (group) for (const value of group[1].matchAll(/\[([^\]]*)\]/g)) setup.push({ color, ...sgfPoint(value[1], boardSize) });
    }
    const moves = [];
    const moveRegex = /;(B|W)\[([^\]]*)\]/g;
    let match;
    while ((match = moveRegex.exec(main))) moves.push({ color: match[1], ...sgfPoint(match[2], boardSize) });
    const komiText = prop('KM');
    const komi = komiText === '' ? null : Number(komiText);
    return {
      title: prop('GN') || prop('EV') || '导入的棋谱',
      black: prop('PB') || '黑棋', white: prop('PW') || '白棋',
      blackRank: prop('BR'), whiteRank: prop('WR'),
      result: prop('RE') || '未知', date: prop('DT') || '', event: prop('EV') || '',
      komi: Number.isFinite(komi) ? komi : null, ruleset: prop('RU'),
      setup, moves
    };
  }

  // 坐标 → SGF 字母对：x/y 都从 'a' 起，且 SGF 不像围棋记谱那样跳过 i。
  // 传 pass、越界或残缺的点一律返回空串，对应 SGF 的 ;B[] 写法。
  function sgfValue(point, size = BOARD_SIZE) {
    if (!point || point.pass) return '';
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return '';
    return x < 0 || y < 0 || x >= size || y >= size
      ? ''
      : String.fromCharCode(97 + x) + String.fromCharCode(97 + y);
  }

  // 导出 SGF。座子（古谱的 AB/AW）和贴目/规则必须写回去：
  // 少了 AB/AW，这份棋谱再被别人打开就是一副空盘，古谱也就失去了意义。
  function serializeSgf(game = {}, options = {}) {
    const size = options.boardSize || BOARD_SIZE;
    // SGF 只规定 \] \\ 两种转义，以及「\ + 真换行」的软换行；没有 \n 这种写法。
    // 把换行转成 \n 是错的：规范解析器会把 \ 吃掉，还原出一个字母 n。
    // 换行按原样写进值里即可（SGF 值本身允许含换行），只把 CRLF 归一成 LF。
    const escape = value => String(value === null || value === undefined ? '' : value)
      .replace(/\\/g, '\\\\').replace(/\]/g, '\\]').replace(/\r\n?/g, '\n');
    const rules = resolveRules({ ruleset: game.ruleset, komi: game.komi });
    const moves = Array.isArray(game.moves) ? game.moves : [];
    const setup = (Array.isArray(game.setup) ? game.setup : []).filter(stone => sgfValue(stone, size));
    const props = [];
    const put = (key, value) => { const text = escape(value); if (text !== '') props.push(`${key}[${text}]`); };

    put('GM', 1); put('FF', 4); put('CA', 'UTF-8'); put('AP', 'Yijing:0.1');
    put('SZ', size);
    put('GN', game.title); put('PB', game.black); put('PW', game.white);
    put('BR', game.blackRank); put('WR', game.whiteRank);
    put('EV', game.event); put('DT', game.date); put('RE', game.result);
    put('KM', rules.komi);
    // RU 原样保留，我们的规则标识（ancient-chinese）才能原样读回来
    put('RU', game.ruleset);

    const blackSetup = setup.filter(stone => stone.color === 'B').map(stone => sgfValue(stone, size));
    const whiteSetup = setup.filter(stone => stone.color === 'W').map(stone => sgfValue(stone, size));
    if (blackSetup.length) props.push(`AB${blackSetup.map(value => `[${value}]`).join('')}`);
    if (whiteSetup.length) props.push(`AW${whiteSetup.map(value => `[${value}]`).join('')}`);
    // HA 是「让子数」，按 SGF 惯例至少两子、且白方盘上没有摆子才算。
    // 座子制是双方各摆两子的固定开局，标成让子会让别的程序把古谱误读成让子棋。
    if (blackSetup.length >= 2 && !whiteSetup.length) put('HA', blackSetup.length);
    // 白先必须显式写出（SGF 默认黑先），否则座子古谱读回来就变成黑先了
    if (setup.length && moves.length && moves[0].color === 'W') put('PL', 'W');

    const body = moves.map(move => `;${move.color === 'W' ? 'W' : 'B'}[${sgfValue(move, size)}]`).join('');
    return `(;${props.join('')}${body})`;
  }

  function pointName(x, y, size = BOARD_SIZE) {
    const letters = 'ABCDEFGHJKLMNOPQRST';
    return `${letters[x] || '?'}${size - y}`;
  }

  function gtpPointToCoords(point, size = BOARD_SIZE) {
    if (!point || point.toLowerCase() === 'pass') return { pass: true };
    const letters = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';
    const x = letters.indexOf(point[0].toUpperCase());
    const y = size - Number(point.slice(1));
    return x < 0 || y < 0 || y >= size ? null : { x, y };
  }

  return { BOARD_SIZE, emptyBoard, neighbors, groupAt, applyMove, replay, capturedStones, groupCounts, groupTaxAdjustment, moveNumberAt, CANDIDATE_MARKS, RULE_PRESETS, resolveRules, sgfPoint, sgfValue, mainSgfSequence, parseSgf, serializeSgf, pointName, gtpPointToCoords };
});
