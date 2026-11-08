"""Porting progress: how much of each game's extracted plot structure the storylets bind to.

A *quest plot* is any Plot node in a game's own database that directly owns journal entries
(JournalGoal/Task/Item) - i.e. something BioWare surfaced to the player as a quest. A quest
plot counts as *bound* when a storylet variable or evidence entry points into its subtree.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from .model import Content


@dataclass
class PlotCoverage:
    game: str
    ref: str
    path: str
    goals: list[str]
    bound_by: set[str]


def _owner_plots(catalog, ref: str) -> list:
    """Every Plot ancestor (in the owning game's DB) of the element with ``ref``."""
    el = catalog.get(ref)
    if el is None:
        return []
    db = catalog.dbs[el.db]
    out = []
    cur = el
    while cur is not None:
        if cur.type_name == "Plot":
            out.append(cur)
        cur = db.elements.get(cur.parent_eid)
    return out


def quest_coverage(content: Content, catalog) -> dict[str, list[PlotCoverage]]:
    touched: dict[str, set[str]] = defaultdict(set)  # plot ref -> storylets/vars touching it
    for decl in content.vars.values():
        if decl.is_plot:
            for p in _owner_plots(catalog, decl.ref):
                touched[p.ref].add(f"var:{decl.name}")
    for st in content.storylets.values():
        for ev in st.evidence:
            els = catalog.resolve_path(ev) if ":" in ev else [catalog.get(ev)]
            for el in filter(None, els):
                for p in _owner_plots(catalog, el.canonical) + ([el] if el.type_name == "Plot" else []):
                    touched[p.ref].add(st.id)
    out: dict[str, list[PlotCoverage]] = {}
    for game, db in catalog.dbs.items():
        rows = []
        for el in db.elements.values():
            if el.type_name != "Plot" or el.import_region:
                continue
            goals = [db.elements[c].label for c in el.children if db.elements[c].type_name == "JournalGoal"]
            if not goals:
                continue
            if any(t in el.path.upper() for t in ("TEST", "DELETED", "DEBUG", "SANDBOX")):
                continue
            rows.append(PlotCoverage(game, el.ref, el.path, goals, touched.get(el.ref, set())))
        out[game] = sorted(rows, key=lambda r: r.path)
    return out


def coverage_markdown(cov: dict[str, list[PlotCoverage]]) -> str:
    lines = ["# Porting coverage (quest plots bound by storylets)", ""]
    for game, rows in cov.items():
        bound = sum(1 for r in rows if r.bound_by)
        lines.append(f"## {game}: {bound}/{len(rows)} quest plots bound")
        lines.append("")
        for r in rows:
            mark = "x" if r.bound_by else " "
            lines.append(f"- [{mark}] `{r.path}` ({len(r.goals)} journal goals)")
        lines.append("")
    return "\n".join(lines)
