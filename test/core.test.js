const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyBoard, applyMove, replay, capturedStones, parseSgf, pointName, gtpPointToCoords, groupCounts, groupTaxAdjustment, resolveRules } = require('../core.js');
const { buildQuery, coordsToGtp } = require('../katago.js');

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
