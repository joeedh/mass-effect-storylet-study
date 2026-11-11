/** Storylet data model (schema v1; see docs/schema-evolution.md for later additions). */
import { names, parse } from './expr.ts';
import type { Effect, Node } from './expr.ts';
import type { Value } from './pycompat.ts';

export type VarType = 'bool' | 'int' | 'float' | 'enum';
export const STATE_TYPES: readonly VarType[] = ['bool', 'int', 'float', 'enum'];
export const DEFAULTS: Readonly<Record<VarType, Value>> = {
  bool : false,
  int  : 0,
  float: 0,
  enum : '',
};
export const GAME_INDEX: ReadonlyMap<string, number> = new Map([
  ['me1', 1],
  ['me2', 2],
  ['me3', 3],
]);
export const CAMPAIGN_VAR = 'story.game'; // declaring it turns on per-game gating (schema v2)

export function isVarType(t: unknown): t is VarType {
  return typeof t === 'string' && (STATE_TYPES as readonly string[]).includes(t);
}

/**
 * A named state variable.
 *
 * `ref` is either a canonical plot-table ref (`me1.bool.3828`), meaning the variable is the
 * game's own state, or a `story.*` ref for state the games keep somewhere the plot databases
 * don't show (or that this model abstracts).
 */
export interface VarDecl {
  readonly name: string;
  readonly ref: string;
  readonly type: VarType;
  readonly path: string | null;
  readonly default: Value | null;
  readonly doc: string;
  readonly source: string;
  readonly values: readonly Value[]; // enum members (v2)
  readonly tags: readonly string[]; // (v3) aggregated with total('tag')
}

export function isPlotVar(decl: VarDecl): boolean {
  return !decl.ref.startsWith('story.');
}

export function initialValue(decl: VarDecl): Value {
  return decl.default ?? DEFAULTS[decl.type];
}

/**
 * A named boolean expression, usually lifted verbatim from a plot-database conditional.
 *
 * `code` is written in canonical refs (`me1.bool.2506`); `meplot bind` produces it and the
 * validator checks it still matches the database. Conditions whose code uses BioWare's
 * `argument` are called like functions: `me1.world.completed_at_least(2)`.
 */
export interface ConditionDecl {
  readonly name: string;
  readonly code: Node;
  readonly ref: string | null;
  readonly path: string | null;
  readonly doc: string;
  readonly source: string;
  readonly numeric: boolean; // `derived:` values (v2) are not coerced to bool
  readonly takesArgument: boolean;
}

export function makeCondition(c: Omit<ConditionDecl, 'takesArgument'>): ConditionDecl {
  return { ...c, takesArgument: [...names(c.code)].includes('argument') };
}

export interface Choice {
  readonly id: string;
  readonly label: string;
  readonly requires: Node;
  readonly effects: readonly Effect[];
  readonly summary: string;
}

/** A system-resolved branch (v2): applied when `when` holds, no player involvement. */
export interface Outcome {
  readonly id: string;
  readonly when: Node;
  readonly effects: readonly Effect[];
  readonly summary: string;
}

/** 'auto' fires as soon as available; 'player' is an agency point; 'idle' (v2) fires only when
 * nothing else is available. */
export type Trigger = 'auto' | 'player' | 'idle';
/** 'bridge' (v2) is exempt from per-game gating. */
export type StoryletKind = 'beat' | 'bridge';

export interface Storylet {
  readonly id: string;
  readonly title: string;
  readonly game: string;
  readonly area: string;
  readonly summary: string;
  readonly requires: Node;
  readonly trigger: Trigger;
  readonly kind: StoryletKind;
  readonly repeatable: boolean;
  readonly priority: number;
  readonly effects: readonly Effect[];
  readonly choices: readonly Choice[];
  readonly outcomes: readonly Outcome[];
  /** Outcomes stop after this many have applied (null: all matches). `resolve: first` (v2)
   * loads as limit 1. */
  readonly limit: Node | null;
  readonly traits: readonly string[];
  /** How many of `effects` (the last ones) came from traits. */
  readonly traitEffects: number;
  readonly tags: readonly string[];
  /** Plot-db refs/paths grounding this storylet. */
  readonly evidence: readonly string[];
  readonly notes: string;
  readonly source: string;
}

export const ALWAYS: Node = parse(true);

/** Effects written on the storylet itself, excluding those its traits contribute. */
export function ownEffects(st: Storylet): readonly Effect[] {
  return st.effects.slice(0, st.effects.length - st.traitEffects);
}

export function storyletChoice(st: Storylet, cid: string): Choice {
  const c = st.choices.find((x) => x.id === cid);
  if (c === undefined) throw new Error(`${st.id} has no choice '${cid}'`);
  return c;
}

export class Content {
  readonly vars = new Map<string, VarDecl>();
  readonly conditions = new Map<string, ConditionDecl>();
  readonly storylets = new Map<string, Storylet>();
  readonly byRef = new Map<string, VarDecl>();
  readonly errors: string[] = [];

  ordered(): Storylet[] {
    return [...this.storylets.values()];
  }

  get gated(): boolean {
    return this.vars.has(CAMPAIGN_VAR);
  }

  /** The same declarations, with only the storylets that `keep` accepts. */
  filtered(keep: (st: Storylet) => boolean): Content {
    const sub = new Content();
    for (const [k, v] of this.vars) sub.vars.set(k, v);
    for (const [k, v] of this.conditions) sub.conditions.set(k, v);
    for (const [k, v] of this.byRef) sub.byRef.set(k, v);
    sub.errors.push(...this.errors);
    for (const [k, v] of this.storylets) if (keep(v)) sub.storylets.set(k, v);
    return sub;
  }
}
