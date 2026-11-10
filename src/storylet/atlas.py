"""Build the interactive HTML atlas of the derived storylet graph (`storylet atlas`)."""
from __future__ import annotations

import collections
import json
import statistics
from pathlib import Path

from . import graph as g
from .engine import Engine, coverage
from .model import Content

TEMPLATE = Path(__file__).with_name("atlas_template.html")


def atlas_data(content: Content, runs: int = 450, seed: int = 3, max_writers: int = 10) -> dict:
    engine = Engine(content)
    s0 = engine.initial()
    starts = [engine.fire(s0, "campaign.start", ch) for ch in ("me1", "me2", "me3")]
    _, _, traces = coverage(engine, runs, seed, starts)
    pos: dict[str, list[float]] = collections.defaultdict(list)
    for t in traces:  # x = typical position within its own game's playthrough
        by = collections.defaultdict(list)
        for st in t.steps:
            by[content.storylets[st.storylet].game].append(st.storylet)
        for ids in by.values():
            for i, sid in enumerate(ids):
                pos[sid].append(i / max(1, len(ids) - 1))
    pairs = collections.defaultdict(set)
    for e in g.build(content, max_writers):
        pairs[(e.src, e.dst)].add(e.via)
    nodes = [{
        "id": s.id, "t": s.title, "g": s.game or "campaign", "a": s.area, "tr": s.trigger, "k": s.kind,
        "sum": s.summary, "req": str(s.requires), "eff": [str(x) for x in s.effects],
        "ch": [{"id": c.id, "l": c.label, "req": str(c.requires), "eff": [str(y) for y in c.effects]} for c in s.choices],
        "oc": [{"id": o.id, "w": str(o.when)} for o in s.outcomes],
        "lim": None if s.limit is None else str(s.limit), "tags": s.tags, "ev": s.evidence, "n": s.notes,
        "x": round(statistics.median(pos[s.id]), 3) if pos[s.id] else 0,
    } for s in content.storylets.values()]
    plot = sum(1 for v in content.vars.values() if v.is_plot)
    return {"nodes": nodes, "edges": [{"s": a, "d": b, "v": sorted(v)} for (a, b), v in pairs.items()],
            "stats": {"storylets": len(nodes), "plotvars": plot, "storyvars": len(content.vars) - plot,
                      "lifted": sum(1 for c in content.conditions.values() if c.ref), "edges": len(pairs)}}


def build_atlas(content: Content, out: Path) -> Path:
    data = json.dumps(atlas_data(content), separators=(",", ":")).replace("</", "<\\/")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(TEMPLATE.read_text(encoding="utf-8").replace("/*DATA*/", data), encoding="utf-8")
    return out
