/**
 * Python value semantics the storylet engine was written against, made explicit.
 *
 * The expression language and the engine were first written in Python, and content relies on its
 * rules: `true == 1`, floored `%`, errors (not NaN) on bad arithmetic. JavaScript's operators
 * differ on each, so evaluation goes through these helpers instead.
 */

/** Every value an expression or a state variable can hold. */
export type Value = boolean | number | string;

/** Python's `ValueError`: bad content or a bad request (firing an unavailable storylet). */
export class ValueError extends Error {
  override name = "ValueError";
}

/**
 * Thrown where Python raised `TypeError` or `ZeroDivisionError` during evaluation. Deliberately
 * not a `ValueError`: code that catches expression errors must not swallow these.
 */
export class PyTypeError extends Error {
  override name = "PyTypeError";
}

type Num = number | boolean;

function isNum(v: Value): v is Num {
  return typeof v === "number" || typeof v === "boolean";
}

function typeName(v: Value): string {
  return typeof v === "boolean" ? "bool" : typeof v === "number" ? "number" : "str";
}

function num(v: Value, op: string, other?: Value): number {
  if (!isNum(v)) {
    const desc = other === undefined ? typeName(v) : `${typeName(v)} and ${typeName(other)}`;
    throw new PyTypeError(`unsupported operand type(s) for ${op}: ${desc}`);
  }
  return Number(v);
}

export function truthy(v: Value): boolean {
  return typeof v === "number" ? v !== 0 : Boolean(v); // NaN is truthy in Python
}

/** `==`: numbers and bools compare by value (`true == 1`); everything else must match exactly. */
export function eq(a: Value, b: Value): boolean {
  if (isNum(a) && isNum(b)) return Number(a) === Number(b);
  return a === b;
}

/** Ordering: numbers and bools numerically, two strings by code unit; anything else throws. */
export function compare(op: "<" | "<=" | ">" | ">=", a: Value, b: Value): boolean {
  let x: number | string;
  let y: number | string;
  if (isNum(a) && isNum(b)) {
    x = Number(a);
    y = Number(b);
  } else if (typeof a === "string" && typeof b === "string") {
    x = a;
    y = b;
  } else {
    throw new PyTypeError(`'${op}' not supported between ${typeName(a)} and ${typeName(b)}`);
  }
  switch (op) {
    case "<":
      return x < y;
    case "<=":
      return x <= y;
    case ">":
      return x > y;
    case ">=":
      return x >= y;
  }
}

export function add(a: Value, b: Value): Value {
  if (typeof a === "string" && typeof b === "string") return a + b;
  return num(a, "+", b) + num(b, "+", a);
}

export function arith(op: "-" | "*" | "/" | "%", a: Value, b: Value): Value {
  if (op === "*" && (typeof a === "string" || typeof b === "string")) return repeat(a, b);
  const x = num(a, op, b);
  const y = num(b, op, a);
  switch (op) {
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      if (y === 0) throw new PyTypeError("division by zero");
      return x / y;
    case "%": {
      if (y === 0) throw new PyTypeError("modulo by zero");
      const r = x % y;
      return r !== 0 && r < 0 !== y < 0 ? r + y : r; // floored, like Python
    }
  }
}

/** `"ab" * 3`: a string times an integer (or bool) repeats it, as in Python. */
function repeat(a: Value, b: Value): string {
  const [s, n] = typeof a === "string" ? [a, b] : [b, a];
  if (typeof s !== "string" || typeof n === "string" || !Number.isInteger(Number(n))) {
    throw new PyTypeError(`can't multiply sequence by non-int of type '${typeName(n)}'`);
  }
  return s.repeat(Math.max(0, Number(n)));
}

export function neg(a: Value): number {
  return -num(a, "unary -");
}

/** Python's `int()`: truncates numbers, accepts bools and integer strings. */
export function toInt(v: Value): number {
  if (typeof v === "string") {
    if (!/^\s*[+-]?\d+\s*$/.test(v)) throw new PyTypeError(`invalid literal for int(): '${v}'`);
    return Number.parseInt(v, 10);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new PyTypeError(`cannot convert ${n} to int`);
  return Math.trunc(n) + 0; // + 0 turns -0 into 0
}

/** Python's `float()` for the values state can hold. */
export function toFloat(v: Value): number {
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (v.trim() === "" || Number.isNaN(n)) throw new PyTypeError(`could not convert string to float: '${v}'`);
    return n;
  }
  return Number(v);
}

/** Python's `max(a, b, ...)` / `min(...)`: at least two arguments; the first extreme one wins. */
export function extreme(kind: "min" | "max", args: readonly Value[]): Value {
  if (args.length < 2) throw new PyTypeError(`${kind}() takes at least two arguments here`);
  let best = args[0]!;
  for (const v of args.slice(1)) {
    if (kind === "max" ? compare(">", v, best) : compare("<", v, best)) best = v;
  }
  return best;
}

export function abs(v: Value): number {
  return Math.abs(num(v, "abs()"));
}

/** Python's `str()` of a value, except that bools keep the expression language's spelling. */
export function str(v: Value): string {
  return typeof v === "boolean" ? (v ? "true" : "false") : String(v);
}

/**
 * Python's `repr()` for messages: strings quoted the way Python quotes them, lists in brackets.
 * Bools are spelled `true`/`false`, as in content.
 */
export function repr(v: Value | null | undefined | readonly (Value | null)[]): string {
  if (Array.isArray(v)) return `[${(v as readonly (Value | null)[]).map(repr).join(", ")}]`;
  if (v === null || v === undefined) return "None";
  if (typeof v !== "string") return str(v as Value);
  const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
  let body = v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
  if (quote === "'") body = body.replaceAll("'", "\\'");
  return quote + body + quote;
}

/** Lexicographic comparison of tuples, as Python's `sorted()` does; strings by code unit. */
export function cmpTuple(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}

/** `sorted(xs, key=...)` with a tuple key. Stable, like Python's sort. */
export function sortedBy<T>(xs: Iterable<T>, key: (x: T) => readonly (string | number)[]): T[] {
  return [...xs].map((x) => [key(x), x] as const).sort((p, q) => cmpTuple(p[0], q[0])).map((p) => p[1]);
}

/**
 * Python's `format(x, f".{digits}f")` and `round(x, digits)`: correctly rounded from the exact
 * binary value, ties to even. `toFixed` breaks exact ties upwards (0.25 -> "0.3"; Python "0.2").
 */
export function fixed(x: number, digits: number): string {
  const up = x.toFixed(digits);
  const scaled = Math.abs(x) * 10 ** digits;
  // An exact tie needs the scaled value to be a representable half; then pick the even neighbour.
  if (Number.isFinite(scaled) && scaled - Math.floor(scaled) === 0.5 && Number.isSafeInteger(Math.floor(scaled) * 2 + 1)) {
    if (isExactlyHalf(Math.abs(x), digits)) {
      const lo = Math.floor(scaled);
      const even = lo % 2 === 0 ? lo : lo + 1;
      return (x < 0 && even !== 0 ? "-" : "") + (even / 10 ** digits).toFixed(digits);
    }
  }
  return up;
}

/** Whether |x| * 10^digits is exactly k + 0.5 (not merely after floating-point rounding). */
function isExactlyHalf(ax: number, digits: number): boolean {
  // x = m * 2^e exactly; x * 10^d = (2k + 1) / 2 iff 2 * m * 10^d * 2^e is an odd integer.
  const [m, e] = decompose(ax);
  let n = 2n * m * 10n ** BigInt(digits);
  if (e >= 0) n <<= BigInt(e);
  else {
    const d = 1n << BigInt(-e);
    if (n % d !== 0n) return false;
    n /= d;
  }
  return n % 2n === 1n;
}

function decompose(x: number): [bigint, number] {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const bits = buf.getBigUint64(0);
  const exp = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  return exp === 0 ? [frac, -1074] : [frac | (1n << 52n), exp - 1075];
}

export function round(x: number, digits: number): number {
  return Number(fixed(x, digits));
}

/** Python's truthiness of an optional string: neither None nor empty. */
export function nonEmpty(s: string | null | undefined): s is string {
  return s !== null && s !== undefined && s !== "";
}

/** `" ".join(s.split())`: collapse runs of whitespace and trim. */
export function squash(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}
