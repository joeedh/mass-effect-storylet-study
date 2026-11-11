/** Storylet runtime: availability, firing, simulation and exhaustive exploration. */
import {
  ExprError,
  FUNCTIONS,
  SPECIAL_FORMS,
  calls,
  evaluate,
  idArg,
  names,
  show,
} from './expr.ts';
import type { Call, Node } from './expr.ts';
import {
  CAMPAIGN_VAR,
  DEFAULTS,
  GAME_INDEX,
  initialValue,
  isVarType,
  storyletChoice,
} from './model.ts';
import type { Choice, Content, Storylet, VarDecl, VarType } from './model.ts';
import { PyRandom } from './pyrandom.ts';
import * as py from './pycompat.ts';
import type { Value } from './pycompat.ts';

const REF_KINDS: ReadonlySet<string> = new Set(['bool', 'int', 'float']);

/** A set of string tuples, compared by value (Python's set of tuples). */
export class TupleSet<T extends readonly string[]> implements Iterable<T> {
  private readonly items = new Map<string, T>();

  constructor(items: Iterable<T> = []) {
    for (const t of items) this.add(t);
  }

  static key(t: readonly string[]): string {
    return JSON.stringify(t);
  }

  has(t: T): boolean {
    return this.items.has(TupleSet.key(t));
  }

  add(t: T): this {
    this.items.set(TupleSet.key(t), t);
    return this;
  }

  addAll(ts: Iterable<T>): this {
    for (const t of ts) this.add(t);
    return this;
  }

  /** A new set with `t` added; this one is unchanged. */
  with(t: T): TupleSet<T> {
    return new TupleSet<T>(this.items.values()).add(t);
  }

  get size(): number {
    return this.items.size;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.items.values();
  }

  /** Members in Python's `sorted()` order. */
  sorted(): T[] {
    return py.sortedBy(this, (t) => t);
  }
}

export type ChosenPair = readonly [storylet: string, choice: string];
export type ReadonlyTupleSet<T extends readonly string[]> = Pick<
  TupleSet<T>,
  'has' | 'with' | 'size' | 'sorted'
> &
  Iterable<T>;

/**
 * An immutable point in a playthrough: variable values (defaults omitted, sorted by ref), the
 * storylets fired and the (storylet, choice/outcome) pairs taken. Two states with the same
 * content have the same `key`.
 */
export class State {
  readonly values: readonly (readonly [string, Value])[];
  readonly fired: ReadonlySet<string>;
  readonly chosen: ReadonlyTupleSet<ChosenPair>;
  private cachedKey: string | undefined;

  constructor(
    values: readonly (readonly [string, Value])[] = [],
    fired: ReadonlySet<string> = new Set(),
    chosen: ReadonlyTupleSet<ChosenPair> = new TupleSet(),
  ) {
    this.values = values;
    this.fired = fired;
    this.chosen = chosen;
  }

  /** A fresh, mutable copy of the values. */
  asMap(): Map<string, Value> {
    return new Map(this.values);
  }

  get key(): string {
    this.cachedKey ??= JSON.stringify([this.values, [...this.fired].sort(), this.chosen.sorted()]);
    return this.cachedKey;
  }
}

export interface Step {
  readonly storylet: string;
  readonly choice: string | null;
}

export interface Trace {
  readonly steps: Step[];
  final: State;
  stuck: boolean;
  /** Auto storylets tied at the top priority: content order decided which fired first. */
  readonly ties: TupleSet<readonly string[]>;
  /** Auto storylets that were available, did not fire, and then stopped being available. */
  readonly preempted: Set<string>;
}

export type Option = readonly [Storylet, string | null];
export type Policy = (state: State, opts: readonly Option[]) => Option;
type Values = ReadonlyMap<string, Value>;

export class Engine {
  readonly content: Content;
  readonly storylets: readonly Storylet[];

  constructor(content: Content) {
    this.content = content;
    this.storylets = content.ordered();
  }

  // -- names ------------------------------------------------------------------------------------
  /** Return [ref, type] for a variable name or raw ref. */
  refOf(name: string): readonly [string, VarType] {
    const decl = this.content.vars.get(name);
    if (decl !== undefined) return [decl.ref, decl.type];
    const parts = name.split('.');
    const kind = parts[1];
    if (
      parts.length === 3 &&
      ['me1', 'me2', 'me3'].includes(parts[0]!) &&
      kind !== undefined &&
      REF_KINDS.has(kind) &&
      /^\d+$/.test(parts[2]!) &&
      isVarType(kind)
    ) {
      return [name, kind];
    }
    throw new ExprError(`unknown variable ${py.repr(name)}`);
  }

  tagged(tag: string | undefined): VarDecl[] {
    if (tag === undefined) return [];
    return [...this.content.vars.values()].filter((d) => d.tags.includes(tag));
  }

  /** Variable names an expression depends on, looking through named conditions. */
  expandNames(node: Node, seen: ReadonlySet<string> = new Set()): Set<string> {
    const out = new Set<string>();
    for (const call of calls(node)) {
      if (call.fn === 'total' && call.args.length) {
        for (const d of this.tagged(idArg(call.args[0]))) out.add(d.name);
      }
    }
    const condNames = [...names(node), ...[...calls(node)].map((c) => c.fn)];
    for (const name of condNames) {
      const cond = this.content.conditions.get(name);
      if (cond !== undefined) {
        if (!seen.has(name)) {
          for (const n of this.expandNames(cond.code, new Set([...seen, name]))) out.add(n);
        }
      } else if (name !== 'argument' && !FUNCTIONS.has(name) && !SPECIAL_FORMS.has(name)) {
        out.add(name);
      }
    }
    return out;
  }

  default(ref: string, vtype: VarType): Value {
    const decl = this.content.byRef.get(ref);
    return decl !== undefined ? initialValue(decl) : DEFAULTS[vtype];
  }

  get(state: State | Values, name: string): Value {
    const [ref, vtype] = this.refOf(name);
    const values = state instanceof State ? state.asMap() : state;
    return values.get(ref) ?? this.default(ref, vtype);
  }

  // -- evaluation ---------------------------------------------------------------------------------
  /** Evaluate against `values` (default: the state's own); `seen()`/`chose()` read `state`. */
  eval(
    node: Node,
    state: State,
    values: Values = state.asMap(),
    bound?: ReadonlyMap<string, Value>,
    depth = 0,
  ): Value {
    if (depth > 32) throw new ExprError('condition recursion too deep');

    const env = (name: string): Value => {
      const b = bound?.get(name);
      if (b !== undefined) return b;
      const cond = this.content.conditions.get(name);
      if (cond !== undefined) {
        if (cond.takesArgument) {
          throw new ExprError(`condition ${name} takes an argument: call it as ${name}(...)`);
        }
        const v = this.eval(cond.code, state, values, undefined, depth + 1);
        return cond.numeric ? v : py.truthy(v);
      }
      const [ref, vtype] = this.refOf(name);
      return values.get(ref) ?? this.default(ref, vtype);
    };

    const special = (call: Call): Value => {
      if (call.fn === 'seen') {
        return call.args.every((a) => {
          const id = idArg(a);
          return id !== undefined && state.fired.has(id);
        });
      }
      if (call.fn === 'chose') {
        if (call.args.length < 2) throw new ExprError('chose() takes a storylet and a choice');
        const [s, c] = [idArg(call.args[0]), idArg(call.args[1])];
        return s !== undefined && c !== undefined && state.chosen.has([s, c]);
      }
      if (call.fn === 'total') {
        // (v3) sum of all variables carrying a tag
        if (!call.args.length) throw new ExprError('total() takes a tag');
        return this.tagged(idArg(call.args[0])).reduce<Value>(
          (acc, d) => py.add(acc, values.get(d.ref) ?? initialValue(d)),
          0,
        );
      }
      const cond = this.content.conditions.get(call.fn);
      if (cond !== undefined && call.args.length === 1) {
        const arg = evaluate(call.args[0]!, env, special);
        const v = this.eval(cond.code, state, values, new Map([['argument', arg]]), depth + 1);
        return cond.numeric ? v : py.truthy(v);
      }
      throw new ExprError(`unknown function ${call.fn}()`);
    };

    return evaluate(node, env, special);
  }

  /** v2 campaign gating: a game's storylets only run while that game is being played. */
  inCurrentGame(st: Storylet, values: Values): boolean {
    const index = GAME_INDEX.get(st.game);
    if (!this.content.gated || st.kind === 'bridge' || index === undefined) return true;
    return py.eq(values.get(CAMPAIGN_VAR) ?? this.default(CAMPAIGN_VAR, 'int'), index);
  }

  choices(st: Storylet, state: State, values: Values = state.asMap()): Choice[] {
    return st.choices.filter((c) => py.truthy(this.eval(c.requires, state, values)));
  }

  isAvailable(st: Storylet, state: State, values: Values = state.asMap()): boolean {
    if (!st.repeatable && state.fired.has(st.id)) return false;
    if (!this.inCurrentGame(st, values)) return false;
    if (!py.truthy(this.eval(st.requires, state, values))) return false;
    return !st.choices.length || this.choices(st, state, values).length > 0;
  }

  available(state: State): Storylet[] {
    const values = state.asMap();
    return this.storylets.filter((s) => this.isAvailable(s, state, values));
  }

  private assign(
    values: Map<string, Value>,
    ref: string,
    vtype: VarType,
    op: string,
    rhs: Value,
    target: string,
  ): void {
    const cur = (): Value => values.get(ref) ?? this.default(ref, vtype);
    if (op === '+=') rhs = py.add(cur(), rhs);
    else if (op === '-=') rhs = py.arith('-', cur(), rhs);
    if (vtype === 'bool') rhs = py.truthy(rhs);
    else if (vtype === 'int') rhs = py.toInt(rhs);
    else if (vtype === 'float') rhs = py.toFloat(rhs);
    else {
      const decl = this.content.byRef.get(ref);
      const allowed = decl?.values ?? [];
      if (!py.eq(rhs, '') && !allowed.some((v) => py.eq(v, rhs))) {
        throw new py.ValueError(`${target}: ${py.repr(rhs)} is not one of ${py.repr(allowed)}`);
      }
    }
    values.set(ref, rhs);
  }

  private applyEffects(
    effects: Iterable<{ target: string; op: string; expr: Node }>,
    scope: State,
    values: Map<string, Value>,
  ): void {
    for (const eff of effects) {
      const [ref, vtype] = this.refOf(eff.target);
      this.assign(values, ref, vtype, eff.op, this.eval(eff.expr, scope, values), eff.target);
    }
  }

  /** Fire a storylet (with a choice, when it has choices). Returns a new state; `state` is untouched. */
  fire(state: State, storylet: Storylet | string, choice: string | null = null): State {
    let st: Storylet;
    if (typeof storylet === 'string') {
      const found = this.content.storylets.get(storylet);
      if (found === undefined) throw new py.ValueError(`unknown storylet ${py.repr(storylet)}`);
      st = found;
    } else {
      st = storylet;
    }
    if (!this.isAvailable(st, state)) throw new py.ValueError(`storylet ${st.id} is not available`);
    const effects = [...st.effects];
    let chosen = state.chosen;
    if (st.choices.length) {
      const opts = this.choices(st, state);
      if (choice === null) {
        if (opts.length !== 1) {
          throw new py.ValueError(`${st.id}: choose one of ${py.repr(opts.map((c) => c.id))}`);
        }
        choice = opts[0]!.id;
      }
      const c = storyletChoice(st, choice);
      if (!opts.includes(c)) throw new py.ValueError(`${st.id}/${choice} is not available`);
      effects.push(...c.effects);
      chosen = chosen.with([st.id, c.id]);
    } else if (choice !== null) {
      throw new py.ValueError(`${st.id} has no choices`);
    }
    const values = state.asMap();
    const fired = new Set(state.fired).add(st.id);
    let mid = new State(state.values, fired, chosen);
    this.applyEffects(effects, mid, values);
    // v2: system-resolved outcomes, evaluated in order against the updated state, stopping once
    // `limit` of them have applied (`resolve: first` is limit 1)
    const cap = st.limit === null ? null : this.outcomeLimit(st, mid, values);
    let applied = 0;
    for (const o of st.outcomes) {
      if (cap !== null && applied >= cap) break;
      mid = new State(mid.values, fired, chosen);
      if (py.truthy(this.eval(o.when, mid, values))) {
        chosen = chosen.with([st.id, o.id]);
        mid = new State(mid.values, fired, chosen);
        this.applyEffects(o.effects, mid, values);
        applied++;
      }
    }
    return this.pack(values, fired, chosen);
  }

  outcomeLimit(st: Storylet, state: State, values: Values): number {
    const limit = st.limit;
    if (limit === null) throw new Error(`${st.id} has no limit`);
    const v = this.eval(limit, state, values);
    if (typeof v === 'string') {
      throw new ExprError(`${st.id}: limit ${show(limit)} is ${py.repr(v)}, not a number`);
    }
    return Math.max(0, py.toInt(v));
  }

  private pack(
    values: Values,
    fired: ReadonlySet<string>,
    chosen: ReadonlyTupleSet<ChosenPair>,
  ): State {
    const items: (readonly [string, Value])[] = [];
    for (const [ref, v] of values) {
      const decl = this.content.byRef.get(ref);
      const kind = ref.split('.')[1];
      const vtype: VarType = decl !== undefined ? decl.type : isVarType(kind) ? kind : 'bool';
      if (!py.eq(v, this.default(ref, vtype))) items.push([ref, v]);
    }
    return new State(
      py.sortedBy(items, ([ref]) => [ref]),
      fired,
      chosen,
    );
  }

  /** The starting state, with some variables (by name or raw ref) overridden. */
  initial(overrides: Readonly<Record<string, Value>> = {}): State {
    const values = new Map<string, Value>();
    for (const [name, v] of Object.entries(overrides)) values.set(this.refOf(name)[0], v);
    return this.pack(values, new Set(), new TupleSet());
  }

  // -- simulation ---------------------------------------------------------------------------------
  /** What can happen next: forced (auto) beats pre-empt player agency. */
  stepOptions(state: State): Option[] {
    return this.stepOptionsFrom(state, this.available(state))[0];
  }

  /**
   * Options, plus the ids of auto storylets tied at the top priority (empty if no tie). Ties go
   * to the first in content order, which is file order: give storylets whose order matters
   * distinct priorities.
   */
  private stepOptionsFrom(state: State, avail: readonly Storylet[]): [Option[], string[]] {
    const autos = avail.filter((s) => s.trigger === 'auto');
    let tied: string[] = [];
    let pool: Storylet[];
    if (autos.length) {
      const top = Math.max(...autos.map((s) => s.priority));
      const atTop = autos.filter((s) => s.priority === top);
      pool = atTop.slice(0, 1);
      if (atTop.length > 1) tied = atTop.map((s) => s.id);
    } else {
      // v2: 'idle' storylets fire only when the player has nothing else to do
      const players = avail.filter((s) => s.trigger === 'player');
      pool = players.length ? players : avail.filter((s) => s.trigger === 'idle');
    }
    const out: Option[] = [];
    const values = state.asMap();
    for (const s of pool) {
      if (s.choices.length) for (const c of this.choices(s, state, values)) out.push([s, c.id]);
      else out.push([s, null]);
    }
    return [out, tied];
  }

  run(
    state: State = this.initial(),
    rng: PyRandom = new PyRandom(),
    maxSteps = 2000,
    policy?: Policy,
  ): Trace {
    const trace: Trace = {
      steps    : [],
      final    : state,
      stuck    : true,
      ties     : new TupleSet(),
      preempted: new Set(),
    };
    let waiting = new Set<string>(); // auto storylets available before the last step that did not fire
    for (let i = 0; i < maxSteps; i++) {
      const avail = this.available(state);
      const autos = new Set(avail.filter((s) => s.trigger === 'auto').map((s) => s.id));
      for (const id of waiting) if (!autos.has(id)) trace.preempted.add(id);
      const [opts, tied] = this.stepOptionsFrom(state, avail);
      if (tied.length) trace.ties.add(tied);
      if (!opts.length) {
        trace.stuck = false;
        break;
      }
      const [st, cid] = policy ? policy(state, opts) : rng.choice(opts);
      state = this.fire(state, st, cid);
      trace.steps.push({ storylet: st.id, choice: cid });
      autos.delete(st.id);
      waiting = autos;
    }
    trace.final = state;
    return trace;
  }

  /** Exhaustive search over distinct states (memoized). May be truncated by `maxStates`. */
  explore(start: State = this.initial(), maxStates = 200_000): Exploration {
    const seen = new Set<string>([start.key]);
    const stack = [start];
    const ex: Exploration = {
      states   : 0,
      terminals: new Map(),
      fired    : new Set(),
      chosen   : new TupleSet(),
      truncated: false,
    };
    for (let s = stack.pop(); s !== undefined; s = stack.pop()) {
      const opts = this.stepOptions(s);
      if (!opts.length) {
        ex.terminals.set(s.key, s);
        continue;
      }
      for (const [st, cid] of opts) {
        ex.fired.add(st.id);
        if (py.nonEmpty(cid)) ex.chosen.add([st.id, cid]);
        const n = this.fire(s, st, cid);
        if (!seen.has(n.key)) {
          if (seen.size >= maxStates) {
            ex.truncated = true;
            continue;
          }
          seen.add(n.key);
          stack.push(n);
        }
      }
    }
    ex.states = seen.size;
    return ex;
  }
}

export interface Exploration {
  states: number;
  /** Terminal states by key. */
  readonly terminals: Map<string, State>;
  readonly fired: Set<string>;
  readonly chosen: TupleSet<ChosenPair>;
  truncated: boolean;
}

export interface Coverage {
  readonly fired: Set<string>;
  readonly chosen: TupleSet<ChosenPair>;
  readonly traces: Trace[];
}

/**
 * Simulate `runs` playthroughs. With `guided`, options are weighted towards storylets and
 * choices taken least often so far (coverage-guided, like a fuzzer), which reaches long
 * prerequisite chains that uniform random play almost never completes.
 */
export function coverage(
  engine: Engine,
  runs: number,
  seed = 0,
  starts?: readonly State[],
  guided = true,
): Coverage {
  const rng = new PyRandom(seed);
  const fired = new Set<string>();
  const chosen = new TupleSet<ChosenPair>();
  const counts = new Map<string, number>();
  const traces: Trace[] = [];
  const begin = starts !== undefined && starts.length > 0 ? starts : [engine.initial()];
  const countKey = (sid: string, cid: string | null): string => JSON.stringify([sid, cid]);

  const policy: Policy = (_state, opts) => {
    if (!guided) return rng.choice(opts);
    const weights = opts.map(
      ([st, cid]) => 1.0 / (1 + (counts.get(countKey(st.id, cid)) ?? 0)) ** 2,
    );
    return rng.weightedChoice(opts, weights);
  };

  for (let i = 0; i < runs; i++) {
    const t = engine.run(begin[i % begin.length], rng, undefined, policy);
    traces.push(t);
    for (const step of t.steps) {
      fired.add(step.storylet);
      const key = countKey(step.storylet, step.choice);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    chosen.addAll(t.final.chosen);
  }
  return { fired, chosen, traces };
}
