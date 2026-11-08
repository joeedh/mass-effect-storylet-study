"""Normalize the three BioWare plot databases into one cross-game catalog.

Identity model
--------------
Every in-game plot element gets a *local ref* ``<db>.<kind>.<plotid>`` (e.g. ``me1.bool.3828``),
where ``db`` is the database it was read from. Elements that are not runtime state (regions,
plots, flag groups, journal entries) get ``<db>.node.<elementid>``.

The trilogy carries plot tables forward between games, which the databases make visible:

* LE3's ``ME2_Plots_for_ME3`` region is the ME2 plot table, at the *same* plot ids.
* LE3's ``ME1_Plots_for_ME3`` region is the ME1 plot table at plot id ``+10000``
  (element ids ``+25000``).

Such elements are aliases: their *canonical ref* is the ref in the game that owns the
variable (``me3.bool.13828`` -> ``me1.bool.3828``). A storylet that reads ME1 state from
ME3 therefore reads the same variable that the ME1 storylet wrote.

LE2's ``ME1_Plots_for_ME2`` region is different: those are ME2-native variables populated
by the save importer, so they stay ``me2.*`` and must be bridged explicitly by content.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Iterator

DB_NAMES = {"le1": "me1", "le2": "me2", "le3": "me3"}

TYPE_NAMES = {
    -1: "None", 1: "Region", 2: "Plot", 3: "FlagGroup", 4: "Flag", 5: "State", 6: "SubState",
    7: "Conditional", 8: "Consequence", 9: "Transition", 10: "JournalGoal", 11: "JournalTask",
    12: "JournalItem", 13: "Integer", 14: "Float", 15: "Mod", 16: "Category",
}
SECTION_KIND = {"bools": "bool", "ints": "int", "floats": "float", "conditionals": "cond", "transitions": "trans"}
STATE_KINDS = ("bool", "int", "float")
JOURNAL_TYPES = {10, 11, 12}

# Import regions inside LE3 (see module docstring). Values: (source game, plot id offset, element id offset)
LE3_IMPORT_REGIONS = {
    "ME1_Plots_for_ME3": ("me1", 10000, 25000),
    "ME2_Plots_for_ME3": ("me2", 0, 0),
}

PE_RE = re.compile(r"PE\{(\d+)\}")
REF_RE = re.compile(r"^(me[123])\.(bool|int|float|cond|trans|node)\.(\d+)$")


@dataclass
class Element:
    db: str
    eid: int
    pid: int
    type: int
    label: str
    parent_eid: int
    section: str
    sequence: float = 0.0
    subtype: int | None = None
    code: str | None = None
    argument: str | None = None
    path: str = ""
    ref: str = ""
    canonical: str = ""
    import_region: str | None = None
    children: list[int] = field(default_factory=list)

    @property
    def type_name(self) -> str:
        return TYPE_NAMES.get(self.type, str(self.type))

    @property
    def kind(self) -> str:
        return self.ref.split(".")[1]

    @property
    def is_state(self) -> bool:
        return self.kind in STATE_KINDS

    @property
    def is_journal(self) -> bool:
        return self.type in JOURNAL_TYPES

    def to_json(self) -> dict:
        d = {
            "ref": self.ref, "eid": self.eid, "pid": self.pid, "type": self.type_name,
            "label": self.label, "path": self.path, "parent": self.parent_eid,
        }
        if self.canonical != self.ref:
            d["canonical"] = self.canonical
        if self.import_region:
            d["import_region"] = self.import_region
        if self.subtype is not None:
            d["subtype"] = self.subtype
        if self.code is not None:
            d["code"] = self.code
        if self.argument is not None:
            d["argument"] = self.argument
        return d


def _num(v, default=0):
    if v is None or v == "":
        return default
    try:
        return int(v)
    except (TypeError, ValueError):
        return float(v)


class GameDB:
    """One plot database (LE1, LE2 or LE3)."""

    def __init__(self, db: str, raw: dict):
        self.db = db
        self.elements: dict[int, Element] = {}
        for section, items in raw.items():
            for e in items:
                el = Element(
                    db=db, eid=int(e["elementid"]), pid=int(e.get("plotid", -1)), type=int(e["type"]),
                    label=str(e.get("label") or ""), parent_eid=int(e.get("parentelementid") or 0),
                    section=section, sequence=float(_num(e.get("sequence"), 0)),
                    subtype=(int(e["subtype"]) if e.get("subtype") is not None else None),
                    code=e.get("code"), argument=(None if e.get("argument") is None else str(e["argument"])),
                )
                self.elements[el.eid] = el
        for el in self.elements.values():
            parent = self.elements.get(el.parent_eid)
            if parent is not None:
                parent.children.append(el.eid)
        for el in self.elements.values():
            el.children.sort(key=lambda c: (self.elements[c].sequence, c))
            el.path = self._path(el)
            kind = SECTION_KIND.get(el.section)
            el.ref = f"{db}.{kind}.{el.pid}" if kind and el.pid >= 0 else f"{db}.node.{el.eid}"
            el.canonical = el.ref

    def _path(self, el: Element) -> str:
        parts: list[str] = []
        seen = set()
        cur: Element | None = el
        while cur is not None and cur.parent_eid > 0 and cur.eid not in seen:
            seen.add(cur.eid)
            parts.append(cur.label)
            cur = self.elements.get(cur.parent_eid)
        return ".".join(reversed(parts))

    def roots(self) -> list[Element]:
        return [e for e in self.elements.values() if e.parent_eid == 0]

    def descendants(self, eid: int) -> Iterator[Element]:
        stack = list(reversed(self.elements[eid].children))
        while stack:
            el = self.elements[stack.pop()]
            yield el
            stack.extend(reversed(el.children))

    def region_of(self, el: Element) -> Element:
        """Top-level region (child of the database root) containing ``el``."""
        cur = el
        while True:
            parent = self.elements.get(cur.parent_eid)
            if parent is None or parent.parent_eid == 0:
                return cur
            cur = parent


class Catalog:
    """All three databases plus cross-game alias resolution and path lookup."""

    def __init__(self, dbs: dict[str, GameDB]):
        self.dbs = dbs
        self.by_ref: dict[str, Element] = {}
        self.aliases: dict[str, list[Element]] = defaultdict(list)  # canonical ref -> aliasing elements
        self.anomalies: list[str] = []
        for db in dbs.values():
            for el in db.elements.values():
                if el.ref in self.by_ref:
                    other = self.by_ref[el.ref]
                    self.anomalies.append(f"duplicate ref {el.ref}: {other.path!r} vs {el.path!r}")
                    continue
                self.by_ref[el.ref] = el
        if "me3" in dbs:
            self._link_le3_imports(dbs["me3"])
        self._path_index: dict[tuple[str, str], list[Element]] = defaultdict(list)
        for db in dbs.values():
            for el in db.elements.values():
                self._path_index[(db.db, el.path)].append(el)

    # -- construction -------------------------------------------------------------------------
    def _link_le3_imports(self, me3: GameDB) -> None:
        for root in me3.roots():
            for region_eid in root.children:
                region = me3.elements[region_eid]
                spec = LE3_IMPORT_REGIONS.get(region.label)
                if not spec:
                    continue
                src_game, pid_off, eid_off = spec
                src = self.dbs.get(src_game)
                for el in [region, *me3.descendants(region_eid)]:
                    el.import_region = region.label
                    if src is None:
                        continue
                    if el.is_state:
                        target = f"{src_game}.{el.kind}.{el.pid - pid_off}"
                    elif el.kind == "node":
                        target = f"{src_game}.node.{el.eid - eid_off}"
                    else:
                        continue  # conditionals/transitions stay ME3 functions
                    tgt = self.by_ref.get(target)
                    if tgt is None or tgt.label != el.label:
                        if el.is_state:
                            self.anomalies.append(
                                f"{el.ref} ({el.path}) in {region.label}: no matching {target}"
                                + (f" (found label {tgt.label!r})" if tgt else ""))
                        continue
                    el.canonical = target
                    self.aliases[target].append(el)

    # -- lookup -------------------------------------------------------------------------------
    def get(self, ref: str) -> Element | None:
        return self.by_ref.get(ref)

    def canonical(self, ref: str) -> str:
        el = self.by_ref.get(ref)
        return el.canonical if el else ref

    def resolve_path(self, spec: str) -> list[Element]:
        """Resolve ``me1:CH2_Virmire.The_Choice.Rescued_Kaidan`` (optionally ``#<plotid>``)."""
        game, _, path = spec.partition(":")
        pid = None
        if "#" in path:
            path, _, pid_s = path.partition("#")
            pid = int(pid_s)
        hits = self._path_index.get((game, path), [])
        if pid is not None:
            hits = [h for h in hits if h.pid == pid]
        return hits

    def search(self, game: str | None, pattern: str, types: Iterable[str] | None = None) -> list[Element]:
        rx = re.compile(pattern, re.I)
        tset = set(types) if types else None
        out = []
        for db in self.dbs.values():
            if game and db.db != game:
                continue
            for el in db.elements.values():
                if tset and el.type_name not in tset and el.kind not in tset:
                    continue
                if rx.search(el.path):
                    out.append(el)
        return sorted(out, key=lambda e: (e.db, e.path))

    def condition_code(self, el: Element) -> str | None:
        """Conditional code with ``PE{eid}`` rewritten to canonical refs."""
        if el.code is None:
            return None
        db = self.dbs[el.db]

        def sub(m: re.Match) -> str:
            tgt = db.elements.get(int(m.group(1)))
            return tgt.canonical if tgt else f"?{el.db}.eid.{m.group(1)}"

        return " ".join(PE_RE.sub(sub, el.code).split())

    def to_json(self) -> dict:
        out = {}
        for name, db in self.dbs.items():
            items = []
            for el in sorted(db.elements.values(), key=lambda e: e.eid):
                d = el.to_json()
                if el.code is not None:
                    d["code_canonical"] = self.condition_code(el)
                items.append(d)
            out[name] = items
        return out


def load_catalog(plotdb_dir: Path) -> Catalog:
    dbs = {}
    for fname, game in DB_NAMES.items():
        path = plotdb_dir / f"{fname}.json"
        if not path.exists():
            raise FileNotFoundError(f"{path} missing; run `meplot fetch` first")
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
        dbs[game] = GameDB(game, raw)
    return Catalog(dbs)


def parse_ref(ref: str) -> tuple[str, str, int] | None:
    m = REF_RE.match(ref)
    return (m.group(1), m.group(2), int(m.group(3))) if m else None
