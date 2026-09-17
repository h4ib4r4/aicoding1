const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnalyzeInput } = require('../server.js');

test('分析请求保留座子摆子', () => {
  const request = parseAnalyzeInput({
    moves: [{ x: 15, y: 3, color: 'B' }],
    initialStones: [{ color: 'B', x: 3, y: 15 }, { color: 'W', x: 3, y: 3 }],
    analyzeTurns: [1]
  });
  assert.deepEqual(request.initialStones, [{ color: 'B', x: 3, y: 15 }, { color: 'W', x: 3, y: 3 }]);
});

test('分析请求透传规则与贴目', () => {
  const request = parseAnalyzeInput({ moves: [], analyzeTurns: [0], rules: 'chinese', komi: 0 });
  assert.equal(request.rules, 'chinese');
  assert.equal(request.komi, 0);
  assert.equal('komi' in parseAnalyzeInput({ moves: [], analyzeTurns: [0] }), false);
  assert.equal(parseAnalyzeInput({ moves: [], analyzeTurns: [0], komi: '' }).komi, undefined);
});

test('分析请求限制访问次数上限', () => {
  assert.equal(parseAnalyzeInput({ moves: [], analyzeTurns: [0], maxVisits: 9999 }).maxVisits, 500);
  assert.equal(parseAnalyzeInput({ moves: [], analyzeTurns: [0], maxVisits: 0 }).maxVisits, 64);
});

test('缺少棋谱或分析手数时报错', () => {
  assert.throws(() => parseAnalyzeInput({ moves: [], analyzeTurns: [] }), /缺少棋谱或分析手数/);
  assert.throws(() => parseAnalyzeInput({ analyzeTurns: [1] }), /缺少棋谱或分析手数/);
});
