/**
 * Layer 1: derive the narrative graph implied by storylet content.
 *
 * There are no hand-written "next" links in storylets; the graph is *emergent*. An edge `A -> B`
 * exists when A (or one of its choices) writes a variable that B's preconditions (or one of B's
 * choice preconditions) read, or when B tests `seen(A)` / `chose(A, ...)`.
 */
import { Engine } from './engine.ts';
import { ExprError, calls, idArg, show } from './expr.ts';
import type { Node } from './expr.ts';
import { GAME_INDEX } from './model.ts';
import type { Content, Storylet } from './model.ts';
import * as py from './pycompat.ts';

export type EdgeKind = 'state' | 'seen' | 'chose';

export interface GEdge {
  readonly src: string;
  readonly src_choice: string | null;
  readonly dst: string;
  readonly via: string;
  readonly kind: EdgeKind;
}

type Special = readonly [src: string, choice: string | null, kind: 'seen' | 'chose'];

function readsOf(engine: Engine, st: Storylet): [Set<string>, Special[]] {
  const refs = new Set<string>();
  const specials = new Map<string, Special>();
  const nodes: Node[] = [
    st.requires,
    ...st.choices.map((c) => c.requires),
    ...st.outcomes.map((o) => o.when),
  ];
  if (st.limit !== null) nodes.push(st.limit);
  for (const node of nodes) {
    for (const name of engine.expandNames(node)) {
      try {
        refs.add(engine.refOf(name)[0]);
      } catch (e) {
        if (!(e instanceof ExprError)) throw e;
      }
    }
    for (const call of calls(node)) {
      const args = call.args.map(idArg);
      const add = (s: Special): void => void specials.set(JSON.stringify(s), s);
      if (call.fn === 'seen') {
        for (const a of args) if (a !== undefined) add([a, null, 'seen']);
      } else if (
        call.fn === 'chose' &&
        args.length === 2 &&
        args[0] !== undefined &&
        args[1] !== undefined
      ) {
        add([args[0], args[1], 'chose']);
      }
    }
  }
  return [refs, [...specials.values()]];
}

function edgeKey(e: GEdge): string {
  return JSON.stringify([e.src, e.src_choice, e.dst, e.via, e.kind]);
}

/**
 * Derive edges. `maxWriters` drops edges through "infrastructure" variables written by more than
 * that many storylets (mission counters, morality points, EMS), which otherwise connect
 * everything to everything.
 */
export function build(content: Content, maxWriters: number | null = null): GEdge[] {
  const engine = new Engine(content);
  const writers = new Map<string, [string, string | null][]>();
  const addWriter = (target: string, w: [string, string | null]): void => {
    const ref = engine.refOf(target)[0];
    const list = writers.get(ref);
    if (list === undefined) writers.set(ref, [w]);
    else list.push(w);
  };
  for (const st of content.storylets.values()) {
    for (const e of st.effects) addWriter(e.target, [st.id, null]);
    for (const c of st.choices) for (const e of c.effects) addWriter(e.target, [st.id, c.id]);
    for (const o of st.outcomes) {
      for (const e of o.effects) addWriter(e.target, [st.id, `=${o.id}`]);
    }
  }
  /** With campaign gating, a later game's storylet can never enable an earlier game's. */
  const backwards = (src: string, dst: string): boolean => {
    const a = GAME_INDEX.get(content.storylets.get(src)?.game ?? '');
    const b = GAME_INDEX.get(content.storylets.get(dst)?.game ?? '');
    return content.gated && a !== undefined && b !== undefined && b < a;
  };

  const edges = new Map<string, GEdge>();
  const add = (e: GEdge): void => void edges.set(edgeKey(e), e);
  for (const st of content.storylets.values()) {
    const [refs, specials] = readsOf(engine, st);
    for (const ref of refs) {
      const ws = writers.get(ref) ?? [];
      if (maxWriters !== null && new Set(ws.map(([w]) => w)).size > maxWriters) continue;
      const label = content.byRef.get(ref)?.name ?? ref;
      for (const [src, cid] of ws) {
        if (src !== st.id && !backwards(src, st.id)) {
          add({ src, src_choice: cid, dst: st.id, via: label, kind: 'state' });
        }
      }
    }
    for (const [src, cid, kind] of specials) {
      add({
        src,
        src_choice: cid,
        dst       : st.id,
        via       : `${kind}(${src}${py.nonEmpty(cid) ? ', ' + cid : ''})`,
        kind,
      });
    }
  }
  // Python sorted by (src, dst, via) only, leaving ties in hash order; the full key is deterministic.
  return py.sortedBy(edges.values(), (e) => [e.src, e.dst, e.via, e.src_choice ?? '', e.kind]);
}

export function toJson(content: Content, edges: readonly GEdge[]): string {
  const nodes = [...content.storylets.values()].map((s) => ({
    id      : s.id,
    title   : s.title,
    game    : s.game,
    area    : s.area,
    trigger : s.trigger,
    kind    : s.kind,
    summary : s.summary,
    requires: show(s.requires),
    tags    : s.tags,
    effects : s.effects.map((e) => e.src),
    notes   : s.notes,
    evidence: s.evidence,
    choices: s.choices.map((c) => ({
      id      : c.id,
      label   : c.label,
      requires: show(c.requires),
      effects : c.effects.map((e) => e.src),
    })),
    outcomes: s.outcomes.map((o) => ({
      id     : o.id,
      when   : show(o.when),
      effects: o.effects.map((e) => e.src),
    })),
    limit   : s.limit === null ? null : show(s.limit),
  }));
  return JSON.stringify({ nodes, edges }, null, 1);
}

function q(s: string): string {
  return '"' + s.replaceAll('"', '\\"') + '"';
}

function groupBy<K, V>(items: Iterable<V>, key: (v: V) => K): Map<K, V[]> {
  const out = new Map<K, V[]>();
  for (const v of items) {
    const k = key(v);
    const list = out.get(k);
    if (list === undefined) out.set(k, [v]);
    else list.push(v);
  }
  return out;
}

/** Graphviz. With `collapse`, parallel edges between two storylets are merged. */
export function toDot(content: Content, edges: readonly GEdge[], collapse = true): string {
  const lines = [
    'digraph storylets {',
    '  rankdir=LR; node [shape=box, style=rounded, fontsize=10]; edge [fontsize=8];',
  ];
  const byArea = groupBy(content.storylets.values(), (s) => JSON.stringify([s.game, s.area]));
  const areas = py.sortedBy(byArea, ([k]) => JSON.parse(k) as [string, string]);
  areas.forEach(([k, sts], i) => {
    const [game, area] = JSON.parse(k) as [string, string];
    lines.push(`  subgraph cluster_${i} { label=${q(area || game)}; style=dashed;`);
    for (const s of sts) {
      const shape = s.choices.length ? ', shape=diamond' : '';
      const style = s.trigger === 'auto' ? ', style="rounded,bold"' : '';
      lines.push(`    ${q(s.id)} [label=${q(s.title)}${shape}${style}];`);
    }
    lines.push('  }');
  });
  for (const es of groupBy(edges, (e) => JSON.stringify([e.src, e.dst])).values()) {
    const { src, dst } = es[0]!;
    if (collapse) {
      const vias = [
        ...new Set(es.map((e) => (py.nonEmpty(e.src_choice) ? `${e.src_choice}: ` : '') + e.via)),
      ].sort();
      const label = vias.slice(0, 3).join('\\n') + (vias.length > 3 ? '\\n…' : '');
      lines.push(`  ${q(src)} -> ${q(dst)} [label=${q(label)}];`);
    } else {
      for (const e of es) lines.push(`  ${q(src)} -> ${q(dst)} [label=${q(e.via)}];`);
    }
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

export function toMermaid(content: Content, edges: readonly GEdge[]): string {
  const ids = new Map([...content.storylets.keys()].map((sid, i) => [sid, `s${i}`]));
  const lines = ['flowchart LR'];
  for (const [area, sts] of groupBy(content.storylets.values(), (s) => s.area || s.game)) {
    lines.push(`  subgraph ${area.replaceAll('.', '_')}["${area}"]`);
    for (const s of sts) {
      const title = s.title.replaceAll('"', "'");
      lines.push(
        s.choices.length ? `    ${ids.get(s.id)}{"${title}"}` : `    ${ids.get(s.id)}["${title}"]`,
      );
    }
    lines.push('  end');
  }
  const seen = new Set<string>();
  for (const e of edges) {
    const key = JSON.stringify([e.src, e.dst]);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`  ${ids.get(e.src)} --> ${ids.get(e.dst)}`);
  }
  return lines.join('\n') + '\n';
}
