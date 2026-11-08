"""storylet: validate, simulate and graph the trilogy storylet content.

    storylet validate [--no-catalog] [--runs N]
    storylet simulate [--seed S] [--set name=value ...] [--choose storylet=choice ...]
    storylet explore [--max-states N]
    storylet graph [--format dot|mermaid|json] [--game me1] [-o FILE]
    storylet coverage [-o FILE]
    storylet available [--set ...]           what could fire from a given state
"""
from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

from .engine import Engine
from .loader import load_content
from .model import Content

ROOT = Path(__file__).resolve().parents[2]
CONTENT = ROOT / "content"


def _catalog(required: bool):
    try:
        from meplot.cli import get_catalog
        return get_catalog()
    except Exception as e:  # network unavailable etc.
        if required:
            raise
        print(f"(plot catalog unavailable: {e}; skipping binding checks)", file=sys.stderr)
        return None


def _parse_value(v: str):
    if v in ("true", "false"):
        return v == "true"
    try:
        return int(v)
    except ValueError:
        return float(v)


def _filter(content: Content, game: str | None) -> Content:
    if not game:
        return content
    sub = Content(vars=content.vars, by_ref=content.by_ref, errors=content.errors)
    sub.storylets = {k: v for k, v in content.storylets.items() if v.game == game}
    return sub


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="storylet", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--content", type=Path, default=CONTENT)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("validate"); p.add_argument("--no-catalog", action="store_true"); p.add_argument("--runs", type=int, default=300)
    p.add_argument("-v", "--verbose", action="store_true")
    for name in ("simulate", "available"):
        p = sub.add_parser(name)
        p.add_argument("--seed", type=int, default=None)
        p.add_argument("--set", action="append", default=[], metavar="NAME=VALUE")
        p.add_argument("--choose", action="append", default=[], metavar="STORYLET=CHOICE",
                       help="force a choice whenever that storylet fires")
        p.add_argument("--state", action="store_true", help="print final state")
    p = sub.add_parser("explore"); p.add_argument("--max-states", type=int, default=200_000); p.add_argument("--game")
    p = sub.add_parser("graph"); p.add_argument("--format", choices=["dot", "mermaid", "json"], default="dot")
    p.add_argument("--game"); p.add_argument("-o", "--output", type=Path)
    p = sub.add_parser("coverage"); p.add_argument("-o", "--output", type=Path)
    a = ap.parse_args(argv)

    content = load_content(a.content)
    if a.cmd == "validate":
        from .validate import validate
        rep = validate(content, None if a.no_catalog else _catalog(False), sim_runs=a.runs)
        for e in rep.errors:
            print("ERROR  ", e)
        for w in rep.warnings:
            print("warning", w)
        if a.verbose:
            for i in rep.info:
                print("info   ", i)
        else:
            for i in rep.info:
                if i.startswith("simulated"):
                    print("info   ", i)
        print(f"{len(content.storylets)} storylets, {len(content.vars)} vars: "
              f"{len(rep.errors)} errors, {len(rep.warnings)} warnings")
        return 0 if rep.ok else 1

    if content.errors:
        for e in content.errors:
            print("ERROR  ", e, file=sys.stderr)
        return 1
    engine = Engine(content)

    if a.cmd in ("simulate", "available"):
        overrides = dict((k, _parse_value(v)) for k, v in (s.split("=", 1) for s in a.set))
        state = engine.initial(overrides)
        if a.cmd == "available":
            for st in engine.available(state):
                cs = [c.id for c in engine.choices(st, state)]
                print(f"{st.trigger:<6} {st.id}  {cs if cs else ''}")
            return 0
        forced = dict(s.split("=", 1) for s in a.choose)
        rng = random.Random(a.seed)

        def policy(state, opts):
            for st, cid in opts:
                if st.id in forced and cid == forced[st.id]:
                    return st, cid
            filtered = [(s, c) for s, c in opts if s.id not in forced or c == forced[s.id]]
            return rng.choice(filtered or opts)

        trace = engine.run(state, rng, policy=policy)
        cur_game = None
        for i, step in enumerate(trace.steps, 1):
            st = content.storylets[step.storylet]
            if (st.game or "campaign") != cur_game:
                cur_game = st.game or "campaign"
                print(f"=== {cur_game} ===")
            ch = f"  -> {step.choice}" if step.choice else ""
            print(f"{i:4} {st.title}{ch}")
        if a.state:
            for ref, v in trace.final.values:
                decl = content.by_ref.get(ref)
                print(f"  {decl.name if decl else ref} = {v}")
        return 0

    if a.cmd == "explore":
        eng = Engine(_filter(content, a.game))
        ex = eng.explore(max_states=a.max_states)
        print(f"states={ex.states} terminals={len(ex.terminals)} fired={len(ex.fired)} "
              f"choices={len(ex.chosen)} truncated={ex.truncated}")
        return 0

    if a.cmd == "graph":
        from . import graph as g
        sub_content = _filter(content, a.game)
        edges = g.build(sub_content)
        text = {"dot": g.to_dot, "mermaid": g.to_mermaid, "json": g.to_json}[a.format](sub_content, edges)
        if a.output:
            a.output.parent.mkdir(parents=True, exist_ok=True)
            a.output.write_text(text, encoding="utf-8")
            print(f"wrote {a.output} ({len(sub_content.storylets)} nodes, {len(edges)} edges)")
        else:
            sys.stdout.write(text)
        return 0

    if a.cmd == "coverage":
        from .porting import coverage_markdown, quest_coverage
        md = coverage_markdown(quest_coverage(content, _catalog(True)))
        if a.output:
            a.output.write_text(md, encoding="utf-8")
            print(f"wrote {a.output}")
        else:
            print(md)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
