const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyBoard, applyMove, replay, parseSgf, pointName, gtpPointToCoords } = require('../core.js');
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

test('解析 SGF 元数据与主线着法', () => {
  const game = parseSgf('(;GM[1]FF[4]GN[测试局]PB[林野]PW[陈星]RE[W+R];B[pd];W[dd];B[])');
  assert.equal(game.title, '测试局');
  assert.equal(game.black, '林野');
  assert.deepEqual(game.moves[0], {color:'B',x:15,y:3});
  assert.equal(game.moves[2].pass, true);
});

test('坐标名称跳过字母 I', () => {
  assert.equal(pointName(8, 3), 'J16');
  assert.equal(coordsToGtp(8, 3), 'J16');
  assert.deepEqual(gtpPointToCoords('J16'), { x: 8, y: 3 });
});

test('生成 KataGo Analysis Engine 查询', () => {
  const query = buildQuery({ id: 'test', moves: [{x:15,y:3,color:'B'}], analyzeTurns: [0,1], maxVisits: 32 });
  assert.deepEqual(query.moves, [['B','Q16']]);
  assert.deepEqual(query.analyzeTurns, [0,1]);
  assert.equal(query.maxVisits, 32);
});
