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

  function replay(moves, count, size = BOARD_SIZE) {
    let board = emptyBoard(size);
    for (const move of moves.slice(0, count)) {
      const updated = applyMove(board, move);
      if (updated) board = updated;
    }
    return board;
  }

  function sgfPoint(value) {
    if (!value || value.length < 2) return { pass: true };
    return { x: value.charCodeAt(0) - 97, y: value.charCodeAt(1) - 97 };
  }

  function parseSgf(text) {
    if (typeof text !== 'string' || !text.includes('(;')) throw new Error('不是有效的 SGF 文件');
    const prop = key => {
      const match = text.match(new RegExp(`${key}\\[((?:\\\\.|[^\\]])*)\\]`));
      return match ? match[1].replace(/\\\]/g, ']').replace(/\\\\/g, '\\') : '';
    };
    const moves = [];
    const moveRegex = /;(B|W)\[([^\]]*)\]/g;
    let match;
    while ((match = moveRegex.exec(text))) moves.push({ color: match[1], ...sgfPoint(match[2]) });
    return {
      title: prop('GN') || prop('EV') || '导入的棋谱',
      black: prop('PB') || '黑棋', white: prop('PW') || '白棋',
      blackRank: prop('BR'), whiteRank: prop('WR'),
      result: prop('RE') || '未知', date: prop('DT') || '', event: prop('EV') || '', moves
    };
  }

  function pointName(x, y, size = BOARD_SIZE) {
    const letters = 'ABCDEFGHJKLMNOPQRST';
    return `${letters[x] || '?'}${size - y}`;
  }

  return { BOARD_SIZE, emptyBoard, neighbors, groupAt, applyMove, replay, parseSgf, pointName };
});
