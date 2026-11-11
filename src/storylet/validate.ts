/** Static and dynamic checks for storylet content, optionally against the extracted plot catalog. */
import type { Catalog } from '../meplot/catalog.ts';
import { Engine, coverage } from './engine.ts';
import { ExprError, FUNCTIONS, calls, idArg, names, parse, show } from './expr.ts';
import type { Effect, Node } from './expr.ts';
import { ownEffects } from './model.ts';
import type { Content } from './model.ts';
import * as py from './pycompat.ts';

export class Report {
  readonly errors: string[];
  readonly warnings: string[] = [];
  readonly info: string[] = [];

  constructor(errors: readonly string[] = []) {
    this.errors = [...errors];
  }

  get ok(): boolean {
    return this.errors.length === 0;
  }
}

type Expr =
  | { readonly where: string; readonly kind: 'read'; readonly node: Node }
  | { readonly where: string; readonly kind: 'write'; readonly effect: Effect };

/** Every expression in the content: reads, and the effects that write. */
function* iterExprs(content: Content): Generator<Expr> {
  const effects = function* (where: string, effs: readonly Effect[]): Generator<Expr> {
    for (const e of effs) {
      yield { where, kind: 'read', node: e.expr };
      yield { where, kind: 'write', effect: e };
    }
  };
  for (const st of content.storylets.values()) {
    yield { where: st.id, kind: 'read', node: st.requires };
    yield* effects(st.id, st.effects);
    for (const c of st.choices) {
      const w = `${st.id}/${c.id}`;
      yield { where: w, kind: 'read', node: c.requires };
      yield* effects(w, c.effects);
    }
    if (st.limit !== null) yield { where: st.id, kind: 'read', node: st.limit };
    for (const o of st.outcomes) {
      const w = `${st.id}/${o.id}`;
      yield { where: w, kind: 'read', node: o.when };
      yield* effects(w, o.effects);
    }
  }
}

/** `engine.refOf(name)[0]`, or undefined for a name that isn't a variable. */
function tryRef(engine: Engine, name: string): string | undefined {
  try {
    return engine.refOf(name)[0];
  } catch (e) {
    if (!(e instanceof ExprError)) throw e;
    return undefined;
  }
}

function addTo(m: Map<string, Set<string>>, key: string, value: string): void {
  let s = m.get(key);
  if (s === undefined) m.set(key, (s = new Set()));
  s.add(value);
}

/** ref -> ids of the storylets (or storylet/choice) that read / write it. */
export function readsWrites(
  content: Content,
  engine: Engine,
): [Map<string, Set<string>>, Map<string, Set<string>>] {
  const reads = new Map<string, Set<string>>();
  const writes = new Map<string, Set<string>>();
  for (const x of iterExprs(content)) {
    if (x.kind === 'write') {
      const ref = tryRef(engine, x.effect.target);
      if (ref !== undefined) addTo(writes, ref, x.where);
      continue;
    }
    for (const name of engine.expandNames(x.node)) {
      const ref = tryRef(engine, name);
      if (ref !== undefined) addTo(reads, ref, x.where);
    }
  }
  return [reads, writes];
}

/**
 * (where, message, isError) for choice `requires` that read a variable the same storylet's
 * effects write. Choices are offered before the storylet's effects apply, so such a choice sees
 * the old value. An error when the storylet writes the variable itself; info when only its traits
 * do (shared counters such as morality or mission count).
 */
export function* choiceReadsOwnEffects(
  content: Content,
  engine: Engine,
): Generator<readonly [string, string, boolean]> {
  for (const st of content.storylets.values()) {
    if (!st.choices.length) continue;
    const own = new Set(ownEffects(st).map((e) => engine.refOf(e.target)[0]));
    const fromTraits = new Set(
      st.effects
        .slice(ownEffects(st).length)
        .map((e) => engine.refOf(e.target)[0])
        .filter((r) => !own.has(r)),
    );
    const label = (refs: Iterable<string>): string =>
      py.repr([...refs].map((x) => content.byRef.get(x)?.name ?? x).sort());
    for (const c of st.choices) {
      const read = new Set<string>();
      for (const name of engine.expandNames(c.requires)) {
        const ref = tryRef(engine, name);
        if (ref !== undefined) read.add(ref);
      }
      const hitOwn = [...read].filter((r) => own.has(r));
      const hitTraits = [...read].filter((r) => fromTraits.has(r));
      if (hitOwn.length) {
        yield [
          `${st.id}/${c.id}`,
          `requires reads ${label(hitOwn)}, which ${st.id}'s own effects write; choices are offered before effects apply, so it sees the old value`,
          true,
        ];
      } else if (hitTraits.length) {
        yield [
          `${st.id}/${c.id}`,
          `requires reads ${label(hitTraits)}, which this storylet's traits also write; it sees the value from before this storylet`,
          false,
        ];
      }
    }
  }
}

export function validate(
  content: Content,
  catalog: Catalog | null = null,
  simRuns = 300,
  seed = 0,
): Report {
  const r = new Report(content.errors);
  const engine = new Engine(content);
  const ids = new Set(content.storylets.keys());

  // names, special forms
  for (const x of iterExprs(content)) {
    if (x.kind === 'write') {
      try {
        engine.refOf(x.effect.target);
      } catch (e) {
        if (!(e instanceof ExprError)) throw e;
        r.errors.push(`${x.where}: effect target: ${e.message}`);
      }
      continue;
    }
    const { where, node } = x;
    for (const name of names(node)) {
      const cond = content.conditions.get(name);
      if (cond !== undefined) {
        if (cond.takesArgument) {
          r.errors.push(`${where}: condition ${name} takes an argument; call it as ${name}(...)`);
        }
        continue;
      }
      try {
        engine.refOf(name);
      } catch (e) {
        if (!(e instanceof ExprError)) throw e;
        r.errors.push(`${where}: ${e.message}`);
      }
    }
    for (const call of calls(node)) {
      const cond = content.conditions.get(call.fn);
      if (cond !== undefined) {
        if (!cond.takesArgument || call.args.length !== 1) {
          r.errors.push(`${where}: ${call.fn}(...) is not a one-argument condition`);
        }
        continue;
      }
      if (call.fn === 'total') {
        const tag = call.args[0];
        if (call.args.length !== 1 || tag?.op !== 'lit' || !engine.tagged(idArg(tag)).length) {
          r.errors.push(`${where}: total() takes one string tag carried by at least one var`);
        }
        continue;
      }
      if (call.fn !== 'seen' && call.fn !== 'chose') {
        if (!FUNCTIONS.has(call.fn)) r.errors.push(`${where}: unknown function ${call.fn}()`);
        continue;
      }
      const args = call.args.map(idArg);
      if (!args.length || args.some((a) => a === undefined)) {
        r.errors.push(`${where}: ${call.fn}() takes storylet ids`);
        continue;
      }
      const [first, ...rest] = args as string[];
      if (!ids.has(first!)) {
        r.errors.push(`${where}: ${call.fn}() unknown storylet ${py.repr(first)}`);
      } else if (call.fn === 'chose') {
        const st = content.storylets.get(first!)!;
        const known = new Set([...st.choices.map((c) => c.id), ...st.outcomes.map((o) => o.id)]);
        if (rest.length !== 1 || !known.has(rest[0]!)) {
          r.errors.push(`${where}: chose() unknown choice ${py.repr(rest)} of ${first}`);
        }
      } else {
        for (const a of rest) {
          if (!ids.has(a)) r.errors.push(`${where}: seen() unknown storylet ${py.repr(a)}`);
        }
      }
    }
  }

  // condition bodies
  for (const cond of content.conditions.values()) {
    for (const name of names(cond.code)) {
      if (name === 'argument' || content.conditions.has(name)) continue;
      try {
        engine.refOf(name);
      } catch (e) {
        if (!(e instanceof ExprError)) throw e;
        r.errors.push(`${cond.source}: condition ${cond.name}: ${e.message}`);
      }
    }
  }

  // choice requires are evaluated before the storylet's own effects apply (see docs/debugging.md)
  if (!r.errors.length) {
    for (const [where, msg, isError] of choiceReadsOwnEffects(content, engine)) {
      (isError ? r.errors : r.info).push(`${where}: ${msg}`);
    }
  }

  // catalog binding
  if (catalog !== null) {
    for (const cond of content.conditions.values()) {
      if (cond.ref === null || cond.ref === '') continue;
      const el = catalog.get(cond.ref);
      if (el === undefined || el.kind !== 'cond') {
        r.errors.push(
          `${cond.source}: condition ${cond.name}: ${cond.ref} is not a plot-database conditional`,
        );
        continue;
      }
      if (
        cond.path !== null &&
        cond.path !== '' &&
        !catalog.resolvePath(cond.path).some((h) => h.ref === cond.ref)
      ) {
        r.errors.push(
          `${cond.source}: condition ${cond.name}: path ${cond.path} does not resolve to ${cond.ref}`,
        );
      }
      let dbCode: Node;
      try {
        const code = catalog.conditionCode(el);
        dbCode = parse(py.nonEmpty(code) ? code : 'false');
      } catch (e) {
        if (!(e instanceof ExprError)) throw e;
        r.errors.push(
          `${cond.source}: condition ${cond.name}: database code for ${cond.ref} not liftable: ${e.message}`,
        );
        continue;
      }
      if (show(dbCode) !== show(cond.code)) {
        r.errors.push(
          `${cond.source}: condition ${cond.name}: code differs from ${cond.ref} in database:\n    content: ${show(cond.code)}\n    database: ${show(dbCode)}`,
        );
      }
    }
    for (const decl of content.vars.values()) {
      if (decl.ref.startsWith('story.')) continue;
      const el = catalog.get(decl.ref);
      if (el === undefined) {
        r.errors.push(`${decl.source}: var ${decl.name}: ${decl.ref} not in plot database`);
        continue;
      }
      if (el.canonical !== el.ref) {
        r.errors.push(
          `${decl.source}: var ${decl.name}: ${decl.ref} is an alias; bind ${el.canonical}`,
        );
      }
      if (decl.path !== null && decl.path !== '') {
        const hits = catalog.resolvePath(decl.path);
        if (!hits.some((h) => h.canonical === decl.ref)) {
          const to = hits.length ? py.repr(hits.map((h) => h.ref)) : 'nothing';
          r.errors.push(
            `${decl.source}: var ${decl.name}: path ${decl.path} does not resolve to ${decl.ref} (resolves to ${to}; ${decl.ref} is ${el.db}:${el.path})`,
          );
        }
      } else {
        r.warnings.push(
          `${decl.source}: var ${decl.name}: no path given (${decl.ref} is ${el.db}:${el.path})`,
        );
      }
    }
    for (const st of content.storylets.values()) {
      for (const ev of st.evidence) {
        const ok = ev.includes(':')
          ? catalog.resolvePath(ev).length > 0
          : catalog.get(ev) !== undefined;
        if (!ok) {
          r.errors.push(
            `${st.source}:${st.id}: evidence ${py.repr(ev)} not found in plot database`,
          );
        }
      }
    }
  }

  // dataflow
  const [reads, writes] = readsWrites(content, engine);
  for (const [ref, readers] of py.sortedBy(reads, ([k]) => [k])) {
    const decl = content.byRef.get(ref);
    if (!writes.has(ref) && !(decl !== undefined && decl.default !== null)) {
      r.warnings.push(
        `${ref} (${decl?.name ?? '?'}) is read by ${py.repr([...readers].sort().slice(0, 3))} but never written`,
      );
    }
  }
  for (const [name, decl] of content.vars) {
    if (!reads.has(decl.ref) && !writes.has(decl.ref)) {
      r.info.push(`var ${name} is declared but unused`);
    }
  }
  for (const [ref] of py.sortedBy(writes, ([k]) => [k])) {
    if (!reads.has(ref)) {
      r.info.push(`${content.byRef.get(ref)?.name ?? ref} is written but never read (record-only)`);
    }
  }

  // dynamic reachability
  if (simRuns && !r.errors.length) {
    const { fired, chosen, traces } = coverage(engine, simRuns, seed);
    for (const st of content.storylets.values()) {
      if (!fired.has(st.id)) {
        r.warnings.push(`${st.id}: never fired in ${simRuns} simulated playthroughs`);
      }
      for (const c of st.choices) {
        if (fired.has(st.id) && !chosen.has([st.id, c.id])) {
          r.warnings.push(`${st.id}/${c.id}: never chosen in ${simRuns} simulated playthroughs`);
        }
      }
      for (const o of st.outcomes) {
        if (fired.has(st.id) && !chosen.has([st.id, o.id])) {
          r.info.push(
            `${st.id}/${o.id}: outcome never resolved in ${simRuns} simulated playthroughs`,
          );
        }
      }
    }
    const preempted = new Set(traces.flatMap((t) => [...t.preempted]));
    for (const sid of [...preempted].sort()) {
      r.warnings.push(
        `${sid}: auto storylet was available, never fired, then became unavailable (pre-empted by another auto beat; give it a higher priority?)`,
      );
    }
    const ties = new Set<string>();
    const tieGroups: (readonly string[])[] = [];
    for (const t of traces) {
      for (const tied of t.ties) {
        const k = JSON.stringify(tied);
        if (!ties.has(k)) (ties.add(k), tieGroups.push(tied));
      }
    }
    for (const tied of py.sortedBy(tieGroups, (t) => t)) {
      r.info.push(
        `auto storylets tied at equal priority, so file order decided which fired first: ${tied.join(', ')}`,
      );
    }
    const stuck = traces.filter((t) => t.stuck).length;
    if (stuck) {
      r.warnings.push(`${stuck} simulated playthroughs hit the step limit (repeatable loop?)`);
    }
    const lengths = traces.map((t) => t.steps.length).sort((a, b) => a - b);
    r.info.push(
      `simulated ${simRuns} playthroughs: ${fired.size}/${content.storylets.size} storylets fired; ` +
        `length min/median/max = ${lengths[0]}/${lengths[Math.floor(lengths.length / 2)]}/${lengths.at(-1)}`,
    );
  }
  return r;
}
