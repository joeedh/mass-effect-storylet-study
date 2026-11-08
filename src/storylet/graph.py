"""Layer 1: derive the narrative graph implied by storylet content.

There are no hand-written "next" links in storylets; the graph is *emergent*. An edge
``A -> B`` exists when A (or one of its choices) writes a variable that B's preconditions
(or one of B's choice preconditions) read, or when B tests ``seen(A)`` / ``chose(A, ...)``.
"""
from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass

from .engine import Engine
from .expr import ExprError
from .model import Content, Storylet


@dataclass(frozen=True)
class GEdge:
    src: str
    src_choice: str | None
    dst: str
    via: str
    kind: str  # 'state' | 'seen' | 'chose'


def _reads(engine: Engine, st: Storylet) -> tuple[set[str], set[tuple[str, str | None, str]]]:
    refs: set[str] = set()
    specials: set[tuple[str, str | None, str]] = set()
    nodes = [st.requires, *(c.requires for c in st.choices), *(o.when for o in st.outcomes)]
    for node in nodes:
        for name in engine.expand_names(node):
            try:
                refs.add(engine.ref_of(name)[0])
            except ExprError:
                pass
        for call in node.calls():
            args = [a.value for a in call.args]
            if call.value == "seen":
                specials.update((a, None, "seen") for a in args)
            elif call.value == "chose" and len(args) == 2:
                specials.add((args[0], args[1], "chose"))
    return refs, specials


def build(content: Content) -> list[GEdge]:
    engine = Engine(content)
    writers: dict[str, list[tuple[str, str | None]]] = defaultdict(list)
    for st in content.storylets.values():
        for e in st.effects:
            writers[engine.ref_of(e.target)[0]].append((st.id, None))
        for c in st.choices:
            for e in c.effects:
                writers[engine.ref_of(e.target)[0]].append((st.id, c.id))
        for o in st.outcomes:
            for e in o.effects:
                writers[engine.ref_of(e.target)[0]].append((st.id, f"={o.id}"))
    edges: set[GEdge] = set()
    for st in content.storylets.values():
        refs, specials = _reads(engine, st)
        for ref in refs:
            decl = content.by_ref.get(ref)
            label = decl.name if decl else ref
            for src, cid in writers.get(ref, []):
                if src != st.id:
                    edges.add(GEdge(src, cid, st.id, label, "state"))
        for src, cid, kind in specials:
            edges.add(GEdge(src, cid, st.id, f"{kind}({src}{', ' + cid if cid else ''})", kind))
    return sorted(edges, key=lambda e: (e.src, e.dst, e.via))


def to_json(content: Content, edges: list[GEdge]) -> str:
    nodes = [{"id": s.id, "title": s.title, "game": s.game, "area": s.area, "trigger": s.trigger,
              "summary": s.summary, "choices": [{"id": c.id, "label": c.label} for c in s.choices]}
             for s in content.storylets.values()]
    return json.dumps({"nodes": nodes, "edges": [e.__dict__ for e in edges]}, indent=1)


def _q(s: str) -> str:
    return '"' + s.replace('"', '\\"') + '"'


def to_dot(content: Content, edges: list[GEdge], collapse: bool = True) -> str:
    """Graphviz. With ``collapse``, parallel edges between two storylets are merged."""
    lines = ["digraph storylets {", "  rankdir=LR; node [shape=box, style=rounded, fontsize=10]; edge [fontsize=8];"]
    by_area: dict[tuple[str, str], list[Storylet]] = defaultdict(list)
    for s in content.storylets.values():
        by_area[(s.game, s.area)].append(s)
    for i, ((game, area), sts) in enumerate(sorted(by_area.items())):
        lines.append(f"  subgraph cluster_{i} {{ label={_q(area or game)}; style=dashed;")
        for s in sts:
            shape = ", shape=diamond" if s.choices else ""
            style = ", style=\"rounded,bold\"" if s.trigger == "auto" else ""
            lines.append(f"    {_q(s.id)} [label={_q(s.title)}{shape}{style}];")
        lines.append("  }")
    merged: dict[tuple[str, str], list[GEdge]] = defaultdict(list)
    for e in edges:
        merged[(e.src, e.dst)].append(e)
    for (src, dst), es in merged.items():
        if collapse:
            vias = sorted({(f"{e.src_choice}: " if e.src_choice else "") + e.via for e in es})
            label = "\\n".join(vias[:3]) + ("\\n…" if len(vias) > 3 else "")
            lines.append(f"  {_q(src)} -> {_q(dst)} [label={_q(label)}];")
        else:
            for e in es:
                lines.append(f"  {_q(src)} -> {_q(dst)} [label={_q(e.via)}];")
    lines.append("}")
    return "\n".join(lines) + "\n"


def to_mermaid(content: Content, edges: list[GEdge]) -> str:
    ids = {sid: f"s{i}" for i, sid in enumerate(content.storylets)}
    lines = ["flowchart LR"]
    by_area: dict[str, list[Storylet]] = defaultdict(list)
    for s in content.storylets.values():
        by_area[s.area or s.game].append(s)
    for area, sts in by_area.items():
        lines.append(f"  subgraph {area.replace('.', '_')}[\"{area}\"]")
        for s in sts:
            title = s.title.replace('"', "'")
            lines.append(f"    {ids[s.id]}{{\"{title}\"}}" if s.choices else f"    {ids[s.id]}[\"{title}\"]")
        lines.append("  end")
    seen = set()
    for e in edges:
        key = (e.src, e.dst)
        if key in seen:
            continue
        seen.add(key)
        lines.append(f"  {ids[e.src]} --> {ids[e.dst]}")
    return "\n".join(lines) + "\n"
