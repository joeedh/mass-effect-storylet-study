/**
 * Expression language for storylet conditions and effects.
 *
 * The syntax is deliberately a superset of BioWare's conditional code (as found in the plot
 * databases), so extracted conditionals can be lifted into storylets verbatim:
 *
 *     expr     := or ( '?' expr ':' expr )?
 *     or       := and ( '||' and )*
 *     and      := not ( '&&' not )*
 *     not      := '!' not | cmp
 *     cmp      := sum ( ('=='|'!='|'<'|'<='|'>'|'>=') sum )?
 *     sum      := term ( ('+'|'-') term )*
 *     term     := unary ( ('*'|'/'|'%') unary )*
 *     unary    := '-' unary | atom
 *     atom     := NUMBER | 'true' | 'false' | STRING | NAME | NAME '(' args ')' | '(' expr ')'
 *     NAME     := dotted identifier; segments may be numeric (`me1.bool.3828`, `me1.virmire.choice`)
 *
 * Effects are statements `target = expr`, `target += expr`, `target -= expr`.
 *
 * Names are resolved by the caller through an `env` callback, so the language knows nothing
 * about plot tables. Functions are looked up in `FUNCTIONS`. Values follow Python's rules (see
 * pycompat.ts), because content was written against them.
 */
import * as py from './pycompat.ts';
import type { Value } from './pycompat.ts';

export class ExprError extends py.ValueError {
  override name = 'ExprError';
}

type TokenKind = 'num' | 'str' | 'name' | 'op' | 'end';
type Token = readonly [TokenKind, string];

const TOKEN_RE =
  /\s*(?:(?<num>\d+\.\d+|\d+)(?![A-Za-z_])|(?<str>"[^"]*"|'[^']*')|(?<name>[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)|(?<op>\+=|-=|==|!=|<=|>=|&&|\|\||[-+*/%<>!()=,?:]))/y;

export function tokenize(source: string): Token[] {
  const src = source.trimEnd();
  const out: Token[] = [];
  let pos = 0;
  while (pos < src.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(src);
    const groups = m?.groups;
    if (!m || !groups || TOKEN_RE.lastIndex === pos) {
      throw new ExprError(
        `unexpected input at ${pos}: ${py.repr(src.slice(pos, pos + 20))} in ${py.repr(src)}`,
      );
    }
    pos = TOKEN_RE.lastIndex;
    const kind = (['num', 'str', 'name', 'op'] as const).find((k) => groups[k] !== undefined);
    if (kind === undefined) throw new ExprError(`unexpected input at ${pos} in ${py.repr(src)}`);
    out.push([kind, groups[kind]!]);
  }
  out.push(['end', '']);
  return out;
}

// --- AST ---------------------------------------------------------------------------------------
export type BinaryOp =
  '||' | '&&' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%';

export interface Lit {
  readonly op: 'lit';
  readonly value: Value;
}
export interface Name {
  readonly op: 'name';
  readonly name: string;
}
export interface Call {
  readonly op: 'call';
  readonly fn: string;
  readonly args: readonly Node[];
}
export interface Unary {
  readonly op: 'not' | 'neg';
  readonly arg: Node;
}
export interface Binary {
  readonly op: BinaryOp;
  readonly left: Node;
  readonly right: Node;
}
export interface Ternary {
  readonly op: '?:';
  readonly cond: Node;
  readonly then: Node;
  readonly else: Node;
}
export type Node = Lit | Name | Call | Unary | Binary | Ternary;

export function lit(value: Value): Lit {
  return { op: 'lit', value };
}

export function children(node: Node): readonly Node[] {
  switch (node.op) {
    case 'lit':
    case 'name':
      return [];
    case 'call':
      return node.args;
    case 'not':
    case 'neg':
      return [node.arg];
    case '?:':
      return [node.cond, node.then, node.else];
    default:
      return [node.left, node.right];
  }
}

// Functions whose arguments are storylet/choice ids or tags, not expressions (evaluated by the engine).
export const SPECIAL_FORMS: ReadonlySet<string> = new Set(['seen', 'chose', 'total']);

/** Variable/condition names read. Arguments of seen()/chose()/total() are ids, not names. */
export function* names(node: Node): Generator<string> {
  if (node.op === 'name') yield node.name;
  if (node.op === 'call' && SPECIAL_FORMS.has(node.fn)) return;
  for (const c of children(node)) yield* names(c);
}

export function* calls(node: Node): Generator<Call> {
  if (node.op === 'call') yield node;
  for (const c of children(node)) yield* calls(c);
}

/** An id argument of a special form: a bare name or a string literal. */
export function idArg(node: Node | undefined): string | undefined {
  if (node?.op === 'name') return node.name;
  if (node?.op === 'lit' && typeof node.value === 'string') return node.value;
  return undefined;
}

/** Canonical, re-parseable source text. */
export function show(node: Node): string {
  switch (node.op) {
    case 'lit': {
      const v = node.value;
      return typeof v === 'string' ? `"${v}"` : py.str(v);
    }
    case 'name':
      return node.name;
    case 'call':
      return `${node.fn}(${node.args.map(show).join(', ')})`;
    case 'not':
      return `!${show(node.arg)}`;
    case 'neg':
      return `-${show(node.arg)}`;
    case '?:':
      return `(${show(node.cond)} ? ${show(node.then)} : ${show(node.else)})`;
    default:
      return `(${show(node.left)} ${node.op} ${show(node.right)})`;
  }
}

// --- parser ------------------------------------------------------------------------------------
class Parser {
  private readonly src: string;
  private readonly toks: Token[];
  private i = 0;

  constructor(src: string) {
    this.src = src;
    this.toks = tokenize(src);
  }

  private peek(): Token {
    return this.toks[this.i]!;
  }

  private take(value?: string): Token {
    const tok = this.toks[this.i]!;
    if (value !== undefined && tok[1] !== value) {
      throw new ExprError(
        `expected ${py.repr(value)}, got ${py.repr(tok[1])} in ${py.repr(this.src)}`,
      );
    }
    this.i++;
    return tok;
  }

  private at(...values: string[]): boolean {
    const [k, v] = this.peek();
    return k === 'op' && values.includes(v);
  }

  parse(): Node {
    const node = this.expr();
    if (this.peek()[0] !== 'end') {
      throw new ExprError(`trailing input ${py.repr(this.peek()[1])} in ${py.repr(this.src)}`);
    }
    return node;
  }

  private expr(): Node {
    const cond = this.or();
    if (this.at('?')) {
      this.take('?');
      const a = this.expr();
      this.take(':');
      const b = this.expr();
      return { op: '?:', cond, then: a, else: b };
    }
    return cond;
  }

  private binary(sub: () => Node, ops: readonly BinaryOp[]): Node {
    let left = sub();
    while (this.at(...ops)) {
      const op = this.take()[1] as BinaryOp;
      left = { op, left, right: sub() };
    }
    return left;
  }

  private or(): Node {
    return this.binary(() => this.and(), ['||']);
  }

  private and(): Node {
    return this.binary(() => this.not(), ['&&']);
  }

  private not(): Node {
    if (this.at('!')) {
      this.take();
      return { op: 'not', arg: this.not() };
    }
    return this.cmp();
  }

  private cmp(): Node {
    const left = this.sum();
    if (this.at('==', '!=', '<', '<=', '>', '>=')) {
      const op = this.take()[1] as BinaryOp;
      return { op, left, right: this.sum() };
    }
    return left;
  }

  private sum(): Node {
    return this.binary(() => this.term(), ['+', '-']);
  }

  private term(): Node {
    return this.binary(() => this.unary(), ['*', '/', '%']);
  }

  private unary(): Node {
    if (this.at('-')) {
      this.take();
      return { op: 'neg', arg: this.unary() };
    }
    return this.atom();
  }

  private atom(): Node {
    const [kind, val] = this.take();
    if (kind === 'num') return lit(Number(val));
    if (kind === 'str') return lit(val.slice(1, -1));
    if (kind === 'name') {
      if (val === 'true' || val === 'false') return lit(val === 'true');
      if (this.at('(')) {
        this.take('(');
        const args: Node[] = [];
        if (!this.at(')')) {
          args.push(this.expr());
          while (this.at(',')) {
            this.take(',');
            args.push(this.expr());
          }
        }
        this.take(')');
        return { op: 'call', fn: val, args };
      }
      return { op: 'name', name: val };
    }
    if (kind === 'op' && val === '(') {
      const node = this.expr();
      this.take(')');
      return node;
    }
    throw new ExprError(`unexpected ${py.repr(val)} in ${py.repr(this.src)}`);
  }
}

const CACHE = new Map<string, Node>();

/** Parse source text; a YAML bool or number becomes a literal. */
export function parse(src: string | boolean | number): Node {
  if (typeof src !== 'string') return lit(src);
  let node = CACHE.get(src);
  if (node === undefined) {
    node = new Parser(src).parse();
    CACHE.set(src, node);
  }
  return node;
}

// --- evaluation --------------------------------------------------------------------------------
type Fn = (...xs: Value[]) => Value;

function arity(name: string, xs: readonly Value[], n: number): void {
  if (xs.length !== n) {
    throw new py.PyTypeError(`${name}() takes ${n} argument(s) (${xs.length} given)`);
  }
}

export const FUNCTIONS: ReadonlyMap<string, Fn> = new Map<string, Fn>([
  ['count', (...xs) => xs.filter(py.truthy).length],
  ['sum', (...xs) => xs.reduce<Value>((acc, x) => py.add(acc, x), 0)],
  ['any', (...xs) => xs.some(py.truthy)],
  ['all', (...xs) => xs.every(py.truthy)],
  ['min', (...xs) => py.extreme('min', xs)],
  ['max', (...xs) => py.extreme('max', xs)],
  ['abs', (...xs) => (arity('abs', xs, 1), py.abs(xs[0]!))],
  ['int', (...xs) => (xs.length === 0 ? 0 : (arity('int', xs, 1), py.toInt(xs[0]!)))],
  ['bool', (...xs) => (xs.length === 0 ? false : (arity('bool', xs, 1), py.truthy(xs[0]!)))],
]);
// Any call that is neither a builtin nor a special form is delegated to the `special` callback
// (the engine uses this for lifted plot-database conditionals that take an `argument`).

export type Env = (name: string) => Value;
export type Special = (call: Call) => Value;

export function evaluate(node: Node, env: Env, special?: Special): Value {
  const ev = (n: Node): Value => evaluate(n, env, special);
  switch (node.op) {
    case 'lit':
      return node.value;
    case 'name':
      return env(node.name);
    case 'not':
      return !py.truthy(ev(node.arg));
    case 'neg':
      return py.neg(ev(node.arg));
    case '&&':
      return py.truthy(ev(node.left)) && py.truthy(ev(node.right));
    case '||':
      return py.truthy(ev(node.left)) || py.truthy(ev(node.right));
    case '?:':
      return ev(py.truthy(ev(node.cond)) ? node.then : node.else);
    case 'call': {
      const fn = FUNCTIONS.get(node.fn);
      if (fn === undefined || SPECIAL_FORMS.has(node.fn)) {
        if (special === undefined) throw new ExprError(`unknown function ${node.fn}()`);
        return special(node);
      }
      return fn(...node.args.map(ev));
    }
    default: {
      const a = ev(node.left);
      const b = ev(node.right);
      switch (node.op) {
        case '==':
          return py.eq(a, b);
        case '!=':
          return !py.eq(a, b);
        case '<':
        case '<=':
        case '>':
        case '>=':
          return py.compare(node.op, a, b);
        case '+':
          return py.add(a, b);
        case '-':
        case '*':
        case '/':
        case '%':
          return py.arith(node.op, a, b);
      }
    }
  }
}

// --- effects -----------------------------------------------------------------------------------
const EFFECT_RE =
  /^\s*(?<target>[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*(?<op>\+=|-=|=)(?!=)\s*(?<expr>.+?)\s*$/;

export type EffectOp = '=' | '+=' | '-=';

export interface Effect {
  readonly target: string;
  readonly op: EffectOp;
  readonly expr: Node;
  /** The source text, which is also how an effect prints. */
  readonly src: string;
}

export function parseEffect(src: string): Effect {
  const g = EFFECT_RE.exec(src)?.groups;
  if (g === undefined) {
    throw new ExprError(`bad effect ${py.repr(src)}: expected 'target = expr' / '+=' / '-='`);
  }
  return {
    target: g['target']!,
    op    : g['op'] as EffectOp,
    expr  : parse(g['expr']!),
    src   : src.trim(),
  };
}
