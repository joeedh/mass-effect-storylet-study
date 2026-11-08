"""meplot: extract and inspect the Mass Effect trilogy plot databases.

    meplot fetch                     download the pinned plot databases into build/plotdb
    meplot build                     write build/catalog.json, build/plotgraph.json, build/outlines/
    meplot find me1 'Virmire.*Kaidan' [--type State]
    meplot show me1.bool.3828        one element (+ aliases in later games)
    meplot resolve 'me1:CH2_Virmire.The_Choice.Rescued_Kaidan'
    meplot outline 'me1:CH2_Virmire.The_Choice'
    meplot bind NAME=SPEC ...        print storylet `vars:`/`conditions:` YAML for plot elements
                                     (SPEC is a ref or a path; conditionals are lifted with their code)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .catalog import Catalog, load_catalog
from .fetch import fetch
from .graph import graph_json
from .outline import outline

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "build"
PLOTDB = BUILD / "plotdb"


def get_catalog(plotdb: Path = PLOTDB) -> Catalog:
    if not all((plotdb / f).exists() for f in ("le1.json", "le2.json", "le3.json")):
        fetch(plotdb)
    return load_catalog(plotdb)


def _fmt(cat: Catalog, el) -> str:
    extra = ""
    if el.kind == "cond":
        extra = f"  := {cat.condition_code(el)}"
    elif el.argument is not None:
        extra = f"  arg={el.argument}"
    canon = f" -> {el.canonical}" if el.canonical != el.ref else ""
    return f"{el.ref:<18}{canon} {el.type_name:<12} {el.db}:{el.path}{extra}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="meplot", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("fetch"); p.add_argument("--force", action="store_true")
    sub.add_parser("build")
    p = sub.add_parser("find"); p.add_argument("game", choices=["me1", "me2", "me3", "any"]); p.add_argument("pattern")
    p.add_argument("--type", action="append", help="element type or kind filter (State, bool, Conditional, ...)")
    p.add_argument("--native", action="store_true", help="hide LE3 import-region aliases")
    p = sub.add_parser("show"); p.add_argument("ref")
    p = sub.add_parser("resolve"); p.add_argument("spec")
    p = sub.add_parser("outline"); p.add_argument("spec"); p.add_argument("--depth", type=int, default=99)
    p.add_argument("--no-flags", action="store_true", help="omit leaf conversation flags")
    p = sub.add_parser("bind"); p.add_argument("pairs", nargs="+", metavar="NAME=SPEC")
    a = ap.parse_args(argv)

    if a.cmd == "fetch":
        for path in fetch(PLOTDB, force=a.force):
            print(path)
        return 0
    cat = get_catalog()
    if a.cmd == "build":
        BUILD.mkdir(exist_ok=True)
        (BUILD / "catalog.json").write_text(json.dumps(cat.to_json(), indent=0), encoding="utf-8")
        g = graph_json(cat)
        (BUILD / "plotgraph.json").write_text(json.dumps(g), encoding="utf-8")
        outdir = BUILD / "outlines"
        n = 0
        for db in cat.dbs.values():
            for root in db.roots():
                for rid in root.children:
                    region = db.elements[rid]
                    d = outdir / db.db
                    d.mkdir(parents=True, exist_ok=True)
                    (d / f"{region.label}.md").write_text(outline(cat, region), encoding="utf-8")
                    n += 1
        (BUILD / "anomalies.txt").write_text("\n".join(cat.anomalies) + "\n", encoding="utf-8")
        print(f"catalog: {sum(len(d.elements) for d in cat.dbs.values())} elements; "
              f"graph: {len(g['edges'])} edges {g['stats']}; outlines: {n}; anomalies: {len(cat.anomalies)}")
        return 0
    if a.cmd == "find":
        hits = cat.search(None if a.game == "any" else a.game, a.pattern, a.type)
        if a.native:
            hits = [h for h in hits if not h.import_region]
        for el in hits:
            print(_fmt(cat, el))
        return 0 if hits else 1
    if a.cmd == "show":
        el = cat.get(a.ref)
        if el is None:
            print(f"unknown ref {a.ref}", file=sys.stderr)
            return 1
        print(_fmt(cat, el))
        for al in cat.aliases.get(el.canonical, []):
            print("  alias:", _fmt(cat, al))
        return 0
    if a.cmd == "resolve":
        hits = cat.resolve_path(a.spec)
        for el in hits:
            print(_fmt(cat, el))
        if len(hits) > 1:
            print(f"ambiguous: append #<plotid> to disambiguate", file=sys.stderr)
        return 0 if len(hits) == 1 else 1
    if a.cmd == "bind":
        vars_out, conds_out, rc = [], [], 0
        for pair in a.pairs:
            name, _, spec = pair.partition("=")
            hits = cat.resolve_path(spec) if ":" in spec else [h for h in [cat.get(spec)] if h]
            if len(hits) != 1:
                print(f"# {name}: {spec} -> {len(hits)} matches", file=sys.stderr)
                rc = 1
                continue
            el = hits[0]
            canon = cat.get(el.canonical) or el
            path = f"{canon.db}:{canon.path}"
            if el.kind == "cond":
                conds_out.append(f"  {name}:\n    ref: {el.ref}\n    path: \"{el.db}:{el.path}\"\n"
                                 f"    code: \"{cat.condition_code(el)}\"")
            elif el.is_state:
                vars_out.append(f"  {name}: {{ref: {canon.ref}, path: \"{path}\"}}")
            else:
                print(f"# {name}: {el.ref} is a {el.type_name}, not bindable", file=sys.stderr)
                rc = 1
        if conds_out:
            print("conditions:\n" + "\n".join(conds_out))
        if vars_out:
            print("vars:\n" + "\n".join(vars_out))
        return rc
    if a.cmd == "outline":
        hits = cat.resolve_path(a.spec) if ":" in a.spec else [cat.get(a.spec)]
        hits = [h for h in hits if h]
        if not hits:
            print("not found", file=sys.stderr)
            return 1
        for h in hits:
            print(outline(cat, h, max_depth=a.depth, skip_flags=a.no_flags))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
