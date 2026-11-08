"""Porting progress: how much of each game's extracted plot structure the storylets bind to.

What counts as a *quest plot* follows each game's own organization:

- ME1: Plot nodes that directly own journal entries (JournalGoal); ME1 files quests that way.
- ME2: the mission plots under the mission regions (Act_1-3, Acquisition/Legacy/Loyalty/N7
  missions); ME2 keeps its journal in Global.Journals.
- ME3: plots named by a mission code in Global.Game_Progress.Mission_Completion_Order (Kro002,
  Gth001, ...); ME3 keeps journals in Global.Critpath_Journals/Side_Journals.

A quest plot is *bound* when a storylet variable or evidence entry points into its subtree.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from .model import Content

ME2_MISSION_REGIONS = {"Act_1", "Act_2", "Act_3", "Acquisition_Missions", "Legacy_Missions",
                       "Loyalty_Missions", "N7_Missions"}


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
    me3_codes = set()
    if "me3" in catalog.dbs:
        for el in catalog.resolve_path("me3:Global.Game_Progress.Mission_Completion_Order"):
            me3_codes = {catalog.dbs["me3"].elements[c].label for c in el.children}
    out: dict[str, list[PlotCoverage]] = {}
    for game, db in catalog.dbs.items():
        rows = []
        for el in db.elements.values():
            if el.type_name != "Plot" or el.import_region:
                continue
            goals = [db.elements[c].label for c in el.children if db.elements[c].type_name == "JournalGoal"]
            region = db.region_of(el)
            if game == "me2":
                parent = db.elements.get(el.parent_eid)
                if not (parent is region and region.label in ME2_MISSION_REGIONS):
                    continue
            elif game == "me3":
                if el.label not in me3_codes or el.label.startswith("MP"):
                    continue
            elif not goals:
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
            extra = f" ({len(r.goals)} journal goals)" if r.goals else ""
            lines.append(f"- [{mark}] `{r.path}`{extra}")
        lines.append("")
    return "\n".join(lines)
