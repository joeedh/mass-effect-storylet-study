"""Porting worksheets: a readable dump of one region/plot subtree with refs, conditions and writes."""
from __future__ import annotations

from collections import defaultdict

from .catalog import Catalog, Element
from .graph import infer_transition_target

ICON = {
    "Region": "▣", "Plot": "▸", "FlagGroup": "◇", "Flag": "·", "State": "●", "SubState": "○",
    "Conditional": "?", "Consequence": "⇒", "Transition": "→", "JournalGoal": "J", "JournalTask": "j",
    "JournalItem": "i", "Integer": "#", "Float": "~", "Category": "▸",
}


def writers_index(cat: Catalog, db: str) -> dict[str, list[str]]:
    idx: dict[str, list[str]] = defaultdict(list)
    for el in cat.dbs[db].elements.values():
        if el.kind == "trans":
            hit = infer_transition_target(cat, el)
            if hit:
                idx[hit[0].canonical].append(f"{el.ref}={hit[2] or '?'}")
    return idx


def outline(cat: Catalog, root: Element, *, max_depth: int = 99, skip_flags: bool = False) -> str:
    db = cat.dbs[root.db]
    writers = writers_index(cat, root.db)
    lines = [f"# {root.db}:{root.path or root.label}  ({root.ref})", ""]

    def walk(el: Element, depth: int) -> None:
        if depth > max_depth:
            return
        if skip_flags and el.type_name == "Flag" and not el.children:
            return
        ref = el.canonical if el.canonical != el.ref else el.ref
        note = ""
        if el.kind == "cond":
            note = f"  := {cat.condition_code(el)}"
        elif el.kind == "trans":
            hit = infer_transition_target(cat, el)
            note = f"  sets {hit[0].canonical}={hit[2]} [{hit[1]}]" if hit else f"  arg={el.argument}"
        elif el.is_state and writers.get(el.canonical):
            note = f"  ← {', '.join(writers[el.canonical][:4])}"
        alias = f" (alias of {el.canonical})" if el.canonical != el.ref else ""
        lines.append(f"{'  ' * depth}{ICON.get(el.type_name, '?')} {el.label}  `{ref}`{alias}{note}")
        for c in el.children:
            walk(db.elements[c], depth + 1)

    walk(root, 0)
    return "\n".join(lines) + "\n"
