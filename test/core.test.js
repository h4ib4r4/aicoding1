const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { emptyBoard, applyMove, replay, capturedStones, parseSgf, serializeSgf, sgfValue, pointName, gtpPointToCoords, groupCounts, groupTaxAdjustment, moveNumberAt, CANDIDATE_MARKS, resolveRules } = require('../core.js');
const { buildQuery, coordsToGtp } = require('../katago.js');

// 直接读真实的内置古谱：导出/导入的往返要在真数据上成立，不能只跑人造样本
const collection = (() => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'collection.js'), 'utf8');
  const sandbox = {};
  new Function('window', source)(sandbox);
  return sandbox.YijingCollection;
})();

test('落子并重放棋局', () => {
  const moves = [{x:3,y:3,color:'B'},{x:4,y:3,color:'W'}];
  const board = replay(moves, 2, 19);
  assert.equal(board[3][3], 'B');
  assert.equal(board[3][4], 'W');
});

test('提走没有气的棋子', () => {
  let board = emptyBoard(5);
  board[1][1] = 'W';
  for (const move of [{x:1,y:0,color:'B'},{x:0,y:1,color:'B'},{x:2,y:1,color:'B'},{x:1,y:2,color:'B'}]) board = applyMove(board, move);
  assert.equal(board[1][1], null);
});

test('拒绝自杀手', () => {
  const board = emptyBoard(5);
  board[0][1] = board[1][0] = board[1][2] = board[2][1] = 'W';
  assert.equal(applyMove(board, {x:1,y:1,color:'B'}), null);
});

test('检测单手提子数量', () => {
  const moves = [
    {x:1,y:0,color:'B'}, {x:1,y:1,color:'W'},
    {x:0,y:1,color:'B'}, {x:4,y:4,color:'W'},
    {x:2,y:1,color:'B'}, {x:3,y:4,color:'W'},
    {x:1,y:2,color:'B'}
  ];
  assert.equal(capturedStones(moves, 7, 5), 1);
  assert.equal(capturedStones(moves, 6, 5), 0);
});

test('解析 SGF 元数据与主线着法', () => {
  const game = parseSgf('(;GM[1]FF[4]GN[测试局]PB[林野]PW[陈星]RE[W+R];B[pd];W[dd];B[])');
  assert.equal(game.title, '测试局');
  assert.equal(game.black, '林野');
  assert.deepEqual(game.moves[0], {color:'B',x:15,y:3});
  assert.equal(game.moves[2].pass, true);
});

test('只解析 SGF 主线并兼容旧式虚着', () => {
  const game = parseSgf('(;GM[1]FF[4]SZ[19];B[pd];W[dd](;B[qp];W[dc])(;B[tt];W[pp]))');
  assert.equal(game.moves.length, 4);
  assert.deepEqual(game.moves[0], {color:'B',x:15,y:3});
  assert.deepEqual(game.moves[2], {color:'B',x:16,y:15});
  assert.deepEqual(parseSgf('(;SZ[19];B[tt])').moves[0], {color:'B',pass:true});
});

test('明确拒绝当前不支持的棋盘尺寸', () => {
  assert.throws(() => parseSgf('(;SZ[13];B[dd])'), /仅支持 19 路/);
});

test('解析并重放让子棋初始摆子', () => {
  const game = parseSgf('(;SZ[19]HA[2]AB[pd][dp];W[qq])');
  assert.deepEqual(game.setup, [{color:'B',x:15,y:3},{color:'B',x:3,y:15}]);
  const board = replay(game.moves, 1, 19, game.setup);
  assert.equal(board[3][15], 'B');
  assert.equal(board[16][16], 'W');
});

test('坐标名称跳过字母 I', () => {
  assert.equal(pointName(8, 3), 'J16');
  assert.equal(coordsToGtp(8, 3), 'J16');
  assert.deepEqual(gtpPointToCoords('J16'), { x: 8, y: 3 });
});

test('生成 KataGo Analysis Engine 查询', () => {
  const query = buildQuery({ id: 'test', moves: [{x:15,y:3,color:'B'}], initialStones: [{x:3,y:3,color:'B'}], analyzeTurns: [0,1], maxVisits: 32 });
  assert.deepEqual(query.moves, [['B','Q16']]);
  assert.deepEqual(query.initialStones, [['B','D16']]);
  assert.deepEqual(query.analyzeTurns, [0,1]);
  assert.equal(query.maxVisits, 32);
});

test('分析查询接受棋谱自带的规则与贴目', () => {
  const query = buildQuery({ id: 'test', moves: [{x:15,y:3,color:'B'}], analyzeTurns: [1], rules: 'chinese', komi: 0 });
  assert.equal(query.rules, 'chinese');
  assert.equal(query.komi, 0);
  assert.equal(buildQuery({ id: 'test', moves: [], analyzeTurns: [0] }).komi, 7.5);
});

test('查询里剔除越界的摆子并保留合法座子', () => {
  const query = buildQuery({ id: 'test', moves: [], initialStones: [{color:'B',x:3,y:15},{color:'W',x:3,y:3},{color:'B',x:-1,y:99},{color:'W',pass:true}], analyzeTurns: [0] });
  assert.deepEqual(query.initialStones, [['B','D4'],['W','D16']]);
});

test('统计棋块数：相连同色算一块', () => {
  const board = emptyBoard(5);
  board[0][0] = 'B'; board[0][1] = 'B';
  board[2][2] = 'B';
  board[4][4] = 'W';
  assert.deepEqual(groupCounts(board), { B: 2, W: 1 });
});

test('还棋头：除第一块外每块 2 目', () => {
  const oneVsOne = emptyBoard(5);
  oneVsOne[0][0] = 'B'; oneVsOne[4][4] = 'W';
  assert.equal(groupTaxAdjustment(oneVsOne), 0);

  const twoVsOne = emptyBoard(5);
  twoVsOne[0][0] = 'B'; twoVsOne[2][2] = 'B'; twoVsOne[4][4] = 'W';
  assert.equal(groupTaxAdjustment(twoVsOne), -2);

  const oneVsThree = emptyBoard(7);
  oneVsThree[0][0] = 'B';
  oneVsThree[4][0] = 'W'; oneVsThree[4][2] = 'W'; oneVsThree[4][4] = 'W';
  assert.equal(groupTaxAdjustment(oneVsThree), 4);

  assert.equal(groupTaxAdjustment(emptyBoard(5)), 0);
});

test('古谱规则预设不贴目且启用还棋头', () => {
  const ancient = resolveRules({ ruleset: 'ancient-chinese' });
  assert.equal(ancient.komi, 0);
  assert.equal(ancient.groupTax, true);
  assert.equal(ancient.name, '明清规则');

  const modern = resolveRules({});
  assert.equal(modern.komi, 7.5);
  assert.equal(modern.groupTax, false);

  assert.equal(resolveRules({ ruleset: 'ancient-chinese', komi: null }).komi, 0, 'KM 缺失时回落到预设');
  assert.equal(resolveRules({ komi: 6.5 }).komi, 6.5, '棋谱自带贴目优先');
  assert.equal(resolveRules({ ruleset: 'ancient-chinese', komi: 5.5 }).komi, 5.5);
});

test('解析 SGF 的贴目与规则属性', () => {
  const game = parseSgf('(;GM[1]SZ[19]KM[7.5]RU[Chinese];B[pd])');
  assert.equal(game.komi, 7.5);
  assert.equal(game.ruleset, 'Chinese');
  assert.equal(parseSgf('(;SZ[19];B[pd])').komi, null);
  assert.equal(parseSgf('(;SZ[19]KM[bad];B[pd])').komi, null);
});

test('棋面手数：取每个交叉点最后一次落子', () => {
  const moves = [
    { x: 3, y: 3, color: 'B' }, { x: 15, y: 15, color: 'W' },
    { x: 3, y: 3, color: 'B' },                        // 同一点重下（劫争后回提）
    { color: 'W', pass: true }, { x: 9, y: 9, color: 'B' }
  ];
  const numbers = moveNumberAt(moves);
  assert.equal(numbers.get('3,3'), 3, '同一点取最后一次落子');
  assert.equal(numbers.get('15,15'), 2);
  assert.equal(numbers.get('9,9'), 5);
  assert.equal(numbers.has('4,4'), false);

  assert.equal(moveNumberAt(moves, 2).get('3,3'), 1, '按当前手数截断');
  assert.equal(moveNumberAt(moves, 2).has('9,9'), false);
  assert.equal(moveNumberAt(moves, 0).size, 0);
  assert.equal(moveNumberAt(moves, 999).get('9,9'), 5, '越界的 upTo 收敛到总手数');
  assert.equal(moveNumberAt(null).size, 0);
  assert.equal(moveNumberAt(undefined, 5).size, 0);

  const passOnly = moveNumberAt([{ color: 'B', pass: true }, { color: 'W', pass: true }]);
  assert.equal(passOnly.size, 0, '虚着不占手数标记');
});

test('AI 候选点用字母标记，与手数（数字）不同形', () => {
  assert.deepEqual(CANDIDATE_MARKS, ['A', 'B', 'C']);
  for (const mark of CANDIDATE_MARKS) assert.equal(/^[A-Z]$/.test(mark), true, '候选标记必须是字母');
});

test('SGF 坐标编码与解码互为逆运算', () => {
  assert.equal(sgfValue({ x: 3, y: 15 }), 'dp');
  assert.equal(sgfValue({ x: 15, y: 3 }), 'pd');
  assert.equal(sgfValue({ x: 0, y: 0 }), 'aa', 'SGF 不像围棋记谱那样跳过 i');
  assert.equal(sgfValue({ color: 'B', pass: true }), '', '虚着对应 ;B[]');
  assert.equal(sgfValue({ x: -1, y: 5 }), '');
  assert.equal(sgfValue({ x: 19, y: 5 }), '');
  assert.equal(sgfValue(null), '');
  assert.deepEqual(parseSgf('(;SZ[19];B[aa])').moves[0], { color: 'B', x: 0, y: 0 });
});

test('导出座子古谱：写回 AB/AW、贴目、规则与白先', () => {
  const game = {
    title: '当湖十局 · 第 1 局', black: '范西屏', white: '施襄夏', date: '1739年', result: '未知',
    ruleset: 'ancient-chinese',
    setup: [{ color: 'B', x: 3, y: 15 }, { color: 'B', x: 15, y: 3 }, { color: 'W', x: 3, y: 3 }, { color: 'W', x: 15, y: 15 }],
    moves: [{ color: 'W', x: 16, y: 5 }, { color: 'B', x: 16, y: 10 }]
  };
  const text = serializeSgf(game);
  assert.match(text, /AB\[dp\]\[pd\]/, '座子（黑）必须写回');
  assert.match(text, /AW\[dd\]\[pp\]/, '座子（白）必须写回');
  assert.match(text, /KM\[0\]/, '古谱不贴目');
  assert.match(text, /RU\[ancient-chinese\]/);
  assert.match(text, /PL\[W\]/, '白先必须显式声明');
  assert.equal(/HA\[/.test(text), false, '座子是双方各摆两子，不是让子');

  const back = parseSgf(text);
  assert.deepEqual(back.setup, game.setup);
  assert.deepEqual(back.moves, game.moves);
  assert.equal(back.komi, 0);
  assert.equal(back.ruleset, 'ancient-chinese');
  assert.equal(back.title, game.title);
  assert.equal(back.black, '范西屏');
});

test('内置十局古谱导出后仍然带座子且白先', () => {
  assert.equal(collection.length, 10, '内置棋谱应为十局');
  for (const game of collection) {
    const text = serializeSgf(game);
    const back = parseSgf(text);
    assert.equal(back.setup.length, 4, `${game.title} 应有四颗座子`);
    assert.deepEqual(back.setup, game.setup, `${game.title} 座子位置必须一致`);
    assert.equal(back.moves.length, game.moves.length, `${game.title} 手数必须一致`);
    assert.equal(back.moves[0].color, 'W', `${game.title} 应保持白先`);
    assert.equal(resolveRules(back).komi, 0, `${game.title} 不贴目`);
    const board = replay(back.moves, 0, 19, back.setup);
    for (const stone of game.setup) assert.equal(board[stone.y][stone.x], stone.color, '座子应真的落在盘上');
  }
});

test('只有真让子局才写 HA', () => {
  const handicap = serializeSgf({ setup: [{ color: 'B', x: 15, y: 3 }, { color: 'B', x: 3, y: 15 }], moves: [{ color: 'B', x: 16, y: 16 }] });
  assert.match(handicap, /AB\[pd\]\[dp\]/);
  assert.match(handicap, /HA\[2\]/);
  assert.equal(/AW\[/.test(handicap), false);
  assert.equal(/PL\[/.test(handicap), false, '让子棋仍是黑先，不必声明');
  assert.deepEqual(parseSgf(handicap).setup, [{ color: 'B', x: 15, y: 3 }, { color: 'B', x: 3, y: 15 }]);

  assert.equal(/HA\[/.test(serializeSgf({ setup: [{ color: 'B', x: 3, y: 15 }], moves: [] })), false, '单子摆子不是让子');
  assert.equal(/HA\[/.test(serializeSgf({ setup: [{ color: 'B', x: 3, y: 15 }, { color: 'W', x: 3, y: 3 }], moves: [] })), false, '双方都有摆子不是让子');
});

test('导出转义 SGF 特殊字符并丢弃越界摆子', () => {
  const text = serializeSgf({ title: 'a]b\\c', moves: [] });
  assert.equal(parseSgf(text).title, 'a]b\\c');

  const multiLine = serializeSgf({ event: '第一行\n第二行', moves: [] });
  assert.equal(parseSgf(multiLine).event, '第一行\n第二行');

  const cleaned = serializeSgf({ setup: [{ color: 'B', x: -1, y: 0 }, { color: 'B', pass: true }, { color: 'B', x: 3, y: 15 }], moves: [] });
  assert.match(cleaned, /AB\[dp\]/);
  assert.equal(parseSgf(cleaned).setup.length, 1, '越界与虚着摆子不写出去');
});

test('导出虚着写成空值', () => {
  const text = serializeSgf({ moves: [{ color: 'B', pass: true }, { color: 'W', x: 3, y: 3 }] });
  assert.match(text, /;B\[\];W\[dd\]/);
  assert.deepEqual(parseSgf(text).moves, [{ color: 'B', pass: true }, { color: 'W', x: 3, y: 3 }]);
});
