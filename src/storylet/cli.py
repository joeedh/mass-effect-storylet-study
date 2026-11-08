"""storylet: validate, simulate and graph the trilogy storylet content.

    storylet validate [--no-catalog] [--runs N]
    storylet simulate [--seed S] [--set name=value ...] [--choose storylet=choice ...]
    storylet explore [--max-states N]
    storylet graph [--format dot|mermaid|json] [--game me1] [-o FILE]
    storylet coverage [-o FILE]
    storylet available [--set ...]           what could fire from a given state
    storylet atlas [-o build/atlas.html]     interactive HTML map of the derived graph
    storylet outcomes [--runs N] [--start me1|me2|me3] [--expr EXPR ...]
                                             distribution of end-of-campaign values
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

DEFAULT_OUTCOMES = [
    ("career reached", "me3.end.made_final_decision ? 'ME3 ending' : (story.me3.refused ? 'refused' : (story.me2.shepard_dead ? 'died in ME2' : 'incomplete'))"),
    ("ending", "me3.end.chose_red ? 'destroy' : (me3.end.chose_blue ? 'control' : (me3.end.chose_green ? 'synthesis' : (story.me3.refused ? 'refuse' : '-')))"),
    ("EMS band", "me3.ems.current_rating < 1750 ? '<1750' : (me3.ems.current_rating < 2350 ? '1750-2349' : (me3.ems.current_rating < 2800 ? '2350-2799' : (me3.ems.current_rating < 4000 ? '2800-3999' : '>=4000')))"),
    ("Earth", "me3.end.earth_ok ? 'ok' : (me3.end.earth_devastated ? 'devastated' : (me3.end.earth_destroyed ? 'destroyed' : '-'))"),
    ("Shepard survives", "me3.end.shepard_alive"),
    ("genophage", "me3.genophage.cure_real ? 'cured' : (me3.genophage.cure_sabotaged ? 'sabotaged' : '-')"),
    ("Rannoch", "me3.rannoch.peace ? 'peace' : (me3.rannoch.quarians_dead ? 'geth won' : (me3.rannoch.geth_destroyed ? 'quarians won' : '-'))"),
    ("Wrex dead by ME3", "me3.fate.wrex_dead"),
    ("ME2 squad deaths", "count(me2.squad.miranda.dead, me2.squad.jacob.dead, me2.squad.jack.dead, me2.squad.legion.dead, me2.squad.kasumi.dead, me2.squad.garrus.dead, me2.squad.thane.dead, me2.squad.tali.dead, me2.squad.mordin.dead, me2.squad.grunt.dead, me2.squad.samara.dead, me2.squad.zaeed.dead)"),
]


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
    p.add_argument("--max-writers", type=int, default=None, help="drop edges via vars with more writers (e.g. 6)")
    p = sub.add_parser("coverage"); p.add_argument("-o", "--output", type=Path)
    p = sub.add_parser("atlas"); p.add_argument("-o", "--output", type=Path, default=ROOT / "build" / "atlas.html")
    p = sub.add_parser("outcomes"); p.add_argument("--runs", type=int, default=500); p.add_argument("--seed", type=int, default=0)
    p.add_argument("--start", choices=["me1", "me2", "me3"]); p.add_argument("--expr", action="append", default=[])
    p.add_argument("--uniform", action="store_true", help="uniform random choices instead of coverage-guided")
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
        edges = g.build(sub_content, a.max_writers)
        text = {"dot": g.to_dot, "mermaid": g.to_mermaid, "json": g.to_json}[a.format](sub_content, edges)
        if a.output:
            a.output.parent.mkdir(parents=True, exist_ok=True)
            a.output.write_text(text, encoding="utf-8")
            print(f"wrote {a.output} ({len(sub_content.storylets)} nodes, {len(edges)} edges)")
        else:
            sys.stdout.write(text)
        return 0

    if a.cmd == "atlas":
        from .atlas import build_atlas
        print(f"wrote {build_atlas(content, a.output)}")
        return 0

    if a.cmd == "outcomes":
        from collections import Counter
        from .engine import coverage as simulate
        from .expr import parse
        exprs = [(x, x) for x in a.expr] or DEFAULT_OUTCOMES
        start = engine.initial()
        if a.start:
            start = engine.fire(start, "campaign.start", a.start)
        _, _, traces = simulate(engine, a.runs, a.seed, [start], guided=not a.uniform)
        for label, src in exprs:
            node = parse(src)
            hist = Counter(engine.eval(node, t.final) for t in traces)
            print(f"{label}:")
            for value, n in sorted(hist.items(), key=lambda kv: (-kv[1], str(kv[0]))):
                print(f"  {str(value):<14} {n:5}  {100 * n / len(traces):5.1f}%")
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
