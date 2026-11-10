/**
 * Layer 0: the *extracted* plot graph.
 *
 * Built only from BioWare's plot databases. Nodes are plot elements; edges are:
 *
 * - `contains`: parent -> child in the plot hierarchy
 * - `reads`: conditional -> state variable referenced in its expression (exact, from code)
 * - `writes`: transition -> state variable it most likely sets (inferred from naming; see
 *   `inferTransitionTarget`; carries a confidence)
 * - `alias`: imported element in a later game -> the variable it carries forward (exact)
 *
 * The databases do not record which conversation or Kismet sequence calls a conditional or
 * transition (that lives in the .pcc packages), so this graph is the *state* skeleton of the
 * narrative. Layer 1 (storylets, see `src/storylet`) is the curated narrative graph bound to it.
 */
import type { Catalog, Element } from "./catalog.ts";

export const READ_RE = /\bme[123]\.(?:bool|int|float)\.\d+\b/g;
const SET_PREFIX = /^(?:set_|clear_)/i;
const VALUE_SUFFIX = /_(true|false)$/i;

export type Confidence = "exact" | "high" | "medium";

export interface Edge {
  readonly src: string;
  readonly dst: string;
  readonly type: "contains" | "alias" | "reads" | "writes";
  readonly confidence: Confidence;
  readonly value: string | null;
}

function edge(src: string, dst: string, type: Edge["type"], confidence: Confidence = "exact", value: string | null = null): Edge {
  return { src, dst, type, confidence, value };
}

export function conditionReads(cat: Catalog, el: Element): string[] {
  const code = cat.conditionCode(el) ?? "";
  return [...new Set(code.match(READ_RE) ?? [])].sort();
}

export interface TransitionTarget {
  readonly state: Element;
  readonly confidence: "high" | "medium";
  readonly value: string | null;
}

/** Guess which state a transition sets. */
export function inferTransitionTarget(cat: Catalog, tr: Element): TransitionTarget | null {
  const db = cat.dbs.get(tr.db)!;
  let label = tr.label;
  let value: string | null = null;
  const m = VALUE_SUFFIX.exec(label);
  if (m) {
    value = m[1]!.toLowerCase();
    label = label.slice(0, m.index);
  } else if (tr.argument === "true" || tr.argument === "false") {
    value = tr.argument;
  } else if (tr.argument !== null && !["", "None", "argument"].includes(tr.argument)) {
    value = tr.argument;
  }
  const base = label.replace(SET_PREFIX, "").toLowerCase();
  if (!base) return null;
  const parent = db.elements.get(tr.parentEid);
  if (parent === undefined) return null;
  for (const c of parent.children) {
    const sib = db.elements.get(c)!;
    if (sib.isState && sib.label.toLowerCase() === base) return { state: sib, confidence: "high", value };
  }
  for (const sib of db.descendants(parent.eid)) {
    if (sib.isState && sib.label.toLowerCase() === base) return { state: sib, confidence: "medium", value };
  }
  // e.g. "Set_Return_for_Kaidan_True" vs state "Return_to_Landing_Pad": no match -> unknown
  return null;
}

export function buildGraph(cat: Catalog): [Element[], Edge[], Map<string, number>] {
  const nodes: Element[] = [];
  const edges: Edge[] = [];
  const stats = new Map<string, number>();
  const count = (k: string): void => void stats.set(k, (stats.get(k) ?? 0) + 1);
  for (const db of cat.dbs.values()) {
    for (const el of db.elements.values()) {
      nodes.push(el);
      const parent = db.elements.get(el.parentEid);
      if (parent !== undefined) edges.push(edge(parent.ref, el.ref, "contains"));
      if (el.canonical !== el.ref) {
        edges.push(edge(el.ref, el.canonical, "alias"));
        count("alias");
      }
      if (el.kind === "cond") {
        for (const r of conditionReads(cat, el)) {
          edges.push(edge(el.ref, r, "reads"));
          count("reads");
        }
      } else if (el.kind === "trans") {
        count("transitions");
        const hit = inferTransitionTarget(cat, el);
        if (hit) {
          edges.push(edge(el.ref, hit.state.canonical, "writes", hit.confidence, hit.value));
          count(`writes_${hit.confidence}`);
        }
      }
    }
  }
  return [nodes, edges, stats];
}

export function graphJson(cat: Catalog) {
  const [nodes, edges, stats] = buildGraph(cat);
  return {
    stats: Object.fromEntries(stats),
    nodes: nodes.map((n) => ({ ref: n.ref, label: n.label, path: n.path, type: n.typeName, db: n.db })),
    edges: edges.map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== null))),
  };
}
