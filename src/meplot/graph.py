"""Layer 0: the *extracted* plot graph.

Built only from BioWare's plot databases. Nodes are plot elements; edges are:

``contains``  parent -> child in the plot hierarchy
``reads``     conditional -> state variable referenced in its expression (exact, from code)
``writes``    transition -> state variable it most likely sets (inferred from naming; see
              ``infer_transition_target``; carries a confidence)
``alias``     imported element in a later game -> the variable it carries forward (exact)

The databases do not record which conversation or Kismet sequence calls a conditional or
transition (that lives in the .pcc packages), so this graph is the *state* skeleton of the
narrative. Layer 1 (storylets, see ``storylet``) is the curated narrative graph bound to it.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

from .catalog import Catalog, Element

READ_RE = re.compile(r"\bme[123]\.(?:bool|int|float)\.\d+\b")
_SET_PREFIX = re.compile(r"^(?:set_|clear_)", re.I)
_VALUE_SUFFIX = re.compile(r"_(true|false)$", re.I)


@dataclass(frozen=True)
class Edge:
    src: str
    dst: str
    type: str
    confidence: str = "exact"
    value: str | None = None


def condition_reads(cat: Catalog, el: Element) -> list[str]:
    code = cat.condition_code(el) or ""
    return sorted(set(READ_RE.findall(code)))


def infer_transition_target(cat: Catalog, tr: Element) -> tuple[Element, str, str | None] | None:
    """Guess which state a transition sets: (state, confidence, value)."""
    db = cat.dbs[tr.db]
    label = tr.label
    value = None
    m = _VALUE_SUFFIX.search(label)
    if m:
        value = m.group(1).lower()
        label = label[: m.start()]
    elif tr.argument in ("true", "false"):
        value = tr.argument
    elif tr.argument not in (None, "", "None", "argument"):
        value = tr.argument
    base = _SET_PREFIX.sub("", label).lower()
    if not base:
        return None
    parent = db.elements.get(tr.parent_eid)
    if parent is None:
        return None
    siblings = [db.elements[c] for c in parent.children]
    for sib in siblings:
        if sib.is_state and sib.label.lower() == base:
            return sib, "high", value
    for sib in db.descendants(parent.eid):
        if sib.is_state and sib.label.lower() == base:
            return sib, "medium", value
    # e.g. "Set_Return_for_Kaidan_True" vs state "Return_to_Landing_Pad": no match -> unknown
    return None


def build_graph(cat: Catalog) -> tuple[list[Element], list[Edge], dict]:
    nodes: list[Element] = []
    edges: list[Edge] = []
    stats: Counter = Counter()
    for db in cat.dbs.values():
        for el in db.elements.values():
            nodes.append(el)
            parent = db.elements.get(el.parent_eid)
            if parent is not None:
                edges.append(Edge(parent.ref, el.ref, "contains"))
            if el.canonical != el.ref:
                edges.append(Edge(el.ref, el.canonical, "alias"))
                stats["alias"] += 1
            if el.kind == "cond":
                for r in condition_reads(cat, el):
                    edges.append(Edge(el.ref, r, "reads"))
                    stats["reads"] += 1
            elif el.kind == "trans":
                stats["transitions"] += 1
                hit = infer_transition_target(cat, el)
                if hit:
                    tgt, conf, value = hit
                    edges.append(Edge(el.ref, tgt.canonical, "writes", conf, value))
                    stats[f"writes_{conf}"] += 1
    return nodes, edges, dict(stats)


def graph_json(cat: Catalog) -> dict:
    nodes, edges, stats = build_graph(cat)
    return {
        "stats": stats,
        "nodes": [
            {"ref": n.ref, "label": n.label, "path": n.path, "type": n.type_name, "db": n.db}
            for n in nodes
        ],
        "edges": [
            {k: v for k, v in e.__dict__.items() if v is not None}
            for e in edges
        ],
    }
