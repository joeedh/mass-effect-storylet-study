import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as py from '../src/storylet/pycompat.ts';
import { PyRandom } from '../src/storylet/pyrandom.ts';

// Captured from CPython 3.15.1: for each seed, three random(), getrandbits(1, 5, 32), then
// (after drawing 33 and 64 bits, four 32-bit words) choice() over range(n) for n in
// 1, 2, 3, 7, 100, 1000, then eight choices(range(4), [1, 0.25, 1/9, 0.5]).
const VECTORS: Record<
  string,
  { random: number[]; bits: number[]; choice: number[]; choices: number[] }
> = {
  '0': {
    random : [0.8444218515250481, 0.7579544029403025, 0.420571580830845],
    bits   : [0, 30, 2195908194],
    choice : [0, 1, 1, 4, 27, 516],
    choices: [0, 0, 0, 3, 3, 0, 2, 1],
  },
  '1': {
    random : [0.13436424411240122, 0.8474337369372327, 0.763774618976614],
    bits   : [0, 3, 2127877499],
    choice : [0, 0, 0, 3, 3, 914],
    choices: [3, 0, 3, 0, 0, 2, 0, 3],
  },
  '4': {
    random : [0.23604808973743452, 0.1031660342307158, 0.396058242610681],
    bits   : [0, 2, 285680177],
    choice : [0, 0, 0, 4, 68, 368],
    choices: [0, 0, 0, 0, 3, 3, 3, 3],
  },
  '12345': {
    random : [0.41661987254534116, 0.010169169457068361, 0.8252065092537432],
    bits   : [0, 27, 1582316135],
    choice : [0, 0, 1, 0, 55, 267],
    choices: [1, 0, 1, 0, 3, 0, 3, 0],
  },
  '4294967301': {
    random : [0.15727238718789782, 0.2824866316461999, 0.6044540318498407],
    bits   : [0, 11, 2696275445],
    choice : [0, 1, 0, 2, 93, 691],
    choices: [3, 3, 2, 3, 0, 0, 3, 3],
  },
  '1180591620717411303427': {
    random : [0.16339507200642456, 0.9974755625541745, 0.2450324792369598],
    bits   : [0, 5, 142793064],
    choice : [0, 1, 0, 3, 56, 894],
    choices: [3, 0, 0, 0, 3, 0, 1, 1],
  },
};

describe('PyRandom', () => {
  for (const [seed, v] of Object.entries(VECTORS)) {
    it(`matches CPython for seed ${seed}`, () => {
      const r = new PyRandom(BigInt(seed));
      assert.deepEqual([r.random(), r.random(), r.random()], v.random);
      assert.deepEqual(
        [1, 5, 32].map((k) => r.getrandbits(k)),
        v.bits,
      );
      for (let i = 0; i < 4; i++) r.getrandbits(32);
      assert.deepEqual(
        [1, 2, 3, 7, 100, 1000].map((n) => r.choice([...Array(n).keys()])),
        v.choice,
      );
      assert.deepEqual(
        Array.from({ length: 8 }, () => r.weightedChoice([0, 1, 2, 3], [1.0, 0.25, 1 / 9, 0.5])),
        v.choices,
      );
    });
  }
});

describe('pycompat', () => {
  it("rounds half to even, like Python's format", () => {
    assert.equal(py.fixed(0.25, 1), '0.2');
    assert.equal(py.fixed(0.35, 1), '0.3'); // 0.35 is below the tie in binary
    assert.equal(py.fixed(12.75, 1), '12.8');
    assert.equal(py.fixed(-0.25, 1), '-0.2');
    assert.equal(py.fixed(74.8, 1), '74.8');
    assert.equal(py.round(0.0625, 3), 0.062);
  });

  it('formats messages like repr()', () => {
    assert.equal(py.repr('nope'), "'nope'");
    assert.equal(py.repr("it's"), `"it's"`);
    assert.equal(py.repr(['a', 'b']), "['a', 'b']");
    assert.equal(py.repr([]), '[]');
  });

  it('compares and sorts tuples like Python', () => {
    assert.deepEqual(
      py.sortedBy(
        [
          ['b', 1],
          ['a', 2],
          ['a', 1],
        ],
        (t) => t,
      ),
      [
        ['a', 1],
        ['a', 2],
        ['b', 1],
      ],
    );
    assert.equal(py.eq(true, 1), true);
    assert.equal(py.eq('1', 1), false);
    assert.equal(py.toInt(-1.9), -1);
    assert.throws(() => py.toInt('1.5'));
  });
});
