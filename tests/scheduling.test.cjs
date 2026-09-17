const { test } = require('node:test');
const assert = require('node:assert/strict');
const { superMemo } = require('./load.cjs').load('src/scheduling.ts');

test('preserves all scores and uses the newly adjusted ease', () => {
  const expected = [[1, 1.7], [1, 1.96], [1, 2.18], [16.52, 2.36], [17.5, 2.5], [18.2, 2.6]];
  expected.forEach(([interval, easeFactor], reviewScore) => {
    // Not frozen: the bundle is non-strict CJS, so a write to a frozen object
    // fails silently and the assertion below would pass against a mutating
    // implementation. A plain object lets the mutation actually surface.
    const input = { interval: 7, easeFactor: 2.5, reviewScore };
    assert.deepEqual(superMemo(input), { interval, easeFactor });
    assert.deepEqual(input, { interval: 7, easeFactor: 2.5, reviewScore });
  });
});

test('preserves minimums and fractional rounding', () => {
  assert.deepEqual(superMemo({ interval: 0.1, easeFactor: 1, reviewScore: 3 }), { interval: 1, easeFactor: 1.3 });
  assert.deepEqual(superMemo({ interval: 1.23456, easeFactor: 2.34567, reviewScore: 5 }), { interval: 3.0194, easeFactor: 2.4457 });
});
