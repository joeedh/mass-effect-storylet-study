/**
 * A port of CPython's `random.Random` (MT19937), limited to what the simulator uses.
 *
 * Seeded runs reproduce Python's exactly: `--seed 4` gives the playthrough it gave before the
 * TypeScript port, and the docs' seeded examples stay valid. Each method follows the CPython
 * implementation it is named after (Modules/_randommodule.c, Lib/random.py).
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class PyRandom {
  private readonly mt = new Uint32Array(N);
  private mti = N + 1;

  /** An integer seed as Python's `random.Random(seed)`; no seed draws one from the OS. */
  constructor(seed?: number | bigint) {
    if (seed === undefined) {
      const words = new Uint32Array(N);
      crypto.getRandomValues(words);
      this.initByArray(Array.from(words));
    } else {
      this.initByArray(seedKey(seed));
    }
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = N;
  }

  private initByArray(key: readonly number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = ((mt[i]! ^ Math.imul(prev, 1664525)) + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = ((mt[i]! ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  private genrandUint32(): number {
    const mt = this.mt;
    if (this.mti >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) {
        const y = (mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK);
        mt[kk] = mt[kk + M]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        const y = (mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK);
        mt[kk] = mt[kk + (M - N)]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      const y = (mt[N - 1]! & UPPER_MASK) | (mt[0]! & LOWER_MASK);
      mt[N - 1] = mt[M - 1]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      this.mti = 0;
    }
    let y = mt[this.mti++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** A float in [0, 1) with 53 random bits. */
  random(): number {
    const a = this.genrandUint32() >>> 5;
    const b = this.genrandUint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  /** `k` random bits, for 0 <= k <= 32 (all that `choice` needs). */
  getrandbits(k: number): number {
    if (!Number.isInteger(k) || k < 0 || k > 32) {
      throw new RangeError(`getrandbits(${k}) supports 0..32 bits`);
    }
    if (k === 0) return 0;
    return this.genrandUint32() >>> (32 - k);
  }

  /** A uniform integer in [0, n), by rejection sampling as CPython's `_randbelow`. */
  randbelow(n: number): number {
    const k = bitLength(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  choice<T>(seq: readonly T[]): T {
    if (seq.length === 0) throw new RangeError('cannot choose from an empty sequence');
    return seq[this.randbelow(seq.length)]!;
  }

  /** One weighted pick, as `random.choices(population, weights)[0]`. */
  weightedChoice<T>(population: readonly T[], weights: readonly number[]): T {
    if (population.length !== weights.length) {
      throw new RangeError('population and weights differ in length');
    }
    const cum: number[] = [];
    let acc = 0;
    for (const w of weights) cum.push((acc += w));
    const total = acc;
    if (!(total > 0) || !Number.isFinite(total)) {
      throw new RangeError('total of weights must be positive and finite');
    }
    return population[bisectRight(cum, this.random() * total, 0, population.length - 1)]!;
  }
}

function bitLength(n: number): number {
  if (n >= 2 ** 32) throw new RangeError(`randbelow(${n}) supports n < 2**32`);
  return n <= 0 ? 0 : 32 - Math.clz32(n);
}

function bisectRight(a: readonly number[], x: number, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (x < a[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Python seeds with the absolute value, split into 32-bit words, least significant first. */
function seedKey(seed: number | bigint): number[] {
  if (typeof seed === 'number' && !Number.isSafeInteger(seed)) {
    throw new RangeError(`seed must be an integer: ${seed}`);
  }
  let n = BigInt(seed);
  if (n < 0n) n = -n;
  const key: number[] = [];
  while (n > 0n) {
    key.push(Number(n & 0xffffffffn));
    n >>= 32n;
  }
  return key.length ? key : [0];
}
