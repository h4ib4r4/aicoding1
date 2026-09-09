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
    return {
      title: prop('GN') || prop('EV') || '导入的棋谱',
      black: prop('PB') || '黑棋', white: prop('PW') || '白棋',
      blackRank: prop('BR'), whiteRank: prop('WR'),
      result: prop('RE') || '未知', date: prop('DT') || '', event: prop('EV') || '', setup, moves
    };
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

  return { BOARD_SIZE, emptyBoard, neighbors, groupAt, applyMove, replay, capturedStones, sgfPoint, mainSgfSequence, parseSgf, pointName, gtpPointToCoords };
});
