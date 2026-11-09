"""Static and dynamic checks for storylet content, optionally against the extracted plot catalog."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from .engine import Engine, coverage
from .expr import FUNCTIONS, ExprError, Node, parse
from .model import Content


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    info: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def _iter_exprs(content: Content):
    """Yield (where, node, kind) for every expression; kind is 'read' or a write target."""
    for st in content.storylets.values():
        yield st.id, st.requires, "read"
        for e in st.effects:
            yield st.id, e.expr, "read"
            yield st.id, e, "write"
        for c in st.choices:
            w = f"{st.id}/{c.id}"
            yield w, c.requires, "read"
            for e in c.effects:
                yield w, e.expr, "read"
                yield w, e, "write"
        for o in st.outcomes:
            w = f"{st.id}/{o.id}"
            yield w, o.when, "read"
            for e in o.effects:
                yield w, e.expr, "read"
                yield w, e, "write"


def reads_writes(content: Content, engine: Engine) -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    """ref -> set of storylet(/choice) ids that read / write it."""
    reads: dict[str, set[str]] = defaultdict(set)
    writes: dict[str, set[str]] = defaultdict(set)
    for where, node, kind in _iter_exprs(content):
        if kind == "write":
            try:
                writes[engine.ref_of(node.target)[0]].add(where)
            except ExprError:
                pass
            continue
        for name in engine.expand_names(node):
            try:
                reads[engine.ref_of(name)[0]].add(where)
            except ExprError:
                pass
    return reads, writes


def choice_reads_own_effects(content: Content, engine: Engine):
    """Yield (where, message, is_error) for choice ``requires`` that read a variable the same
    storylet's effects write. Choices are offered before the storylet's effects apply, so such a
    choice sees the old value. An error when the storylet writes the variable itself; info when
    only its traits do (shared counters such as morality or mission count)."""
    for st in content.storylets.values():
        if not st.choices:
            continue
        own = {engine.ref_of(e.target)[0] for e in st.own_effects}
        from_traits = {engine.ref_of(e.target)[0] for e in st.effects[len(st.own_effects):]} - own
        for c in st.choices:
            read = set()
            for name in engine.expand_names(c.requires):
                try:
                    read.add(engine.ref_of(name)[0])
                except ExprError:
                    pass
            names = lambda refs: sorted(content.by_ref[x].name if x in content.by_ref else x for x in refs)
            if read & own:
                yield (f"{st.id}/{c.id}", f"requires reads {names(read & own)}, which {st.id}'s own effects "
                       "write; choices are offered before effects apply, so it sees the old value", True)
            elif read & from_traits:
                yield (f"{st.id}/{c.id}", f"requires reads {names(read & from_traits)}, which this storylet's "
                       "traits also write; it sees the value from before this storylet", False)


def validate(content: Content, catalog=None, sim_runs: int = 300, seed: int = 0) -> Report:
    r = Report(errors=list(content.errors))
    engine = Engine(content)
    ids = set(content.storylets)

    # names, special forms
    for where, node, kind in _iter_exprs(content):
        if kind == "write":
            try:
                engine.ref_of(node.target)
            except ExprError as e:
                r.errors.append(f"{where}: effect target: {e}")
            continue
        for name in node.names():
            if name in content.conditions:
                if content.conditions[name].takes_argument:
                    r.errors.append(f"{where}: condition {name} takes an argument; call it as {name}(...)")
                continue
            try:
                engine.ref_of(name)
            except ExprError as e:
                r.errors.append(f"{where}: {e}")
        for call in node.calls():
            if call.value in content.conditions:
                if not content.conditions[call.value].takes_argument or len(call.args) != 1:
                    r.errors.append(f"{where}: {call.value}(...) is not a one-argument condition")
                continue
            if call.value == "total":
                if len(call.args) != 1 or call.args[0].op != "lit" or not engine.tagged(call.args[0].value):
                    r.errors.append(f"{where}: total() takes one string tag carried by at least one var")
                continue
            if call.value not in ("seen", "chose") and call.value not in FUNCTIONS:
                r.errors.append(f"{where}: unknown function {call.value}()")
            if call.value in ("seen", "chose"):
                args = [a.value for a in call.args]
                if not args or any(a.op not in ("name", "lit") for a in call.args):
                    r.errors.append(f"{where}: {call.value}() takes storylet ids")
                    continue
                if args[0] not in ids:
                    r.errors.append(f"{where}: {call.value}() unknown storylet {args[0]!r}")
                elif call.value == "chose":
                    st = content.storylets[args[0]]
                    if len(args) != 2 or args[1] not in {c.id for c in st.choices} | {o.id for o in st.outcomes}:
                        r.errors.append(f"{where}: chose() unknown choice {args[1:]!r} of {args[0]}")
                else:
                    for a in args[1:]:
                        if a not in ids:
                            r.errors.append(f"{where}: seen() unknown storylet {a!r}")

    # condition bodies
    for cond in content.conditions.values():
        for name in cond.code.names():
            if name == "argument" or name in content.conditions:
                continue
            try:
                engine.ref_of(name)
            except ExprError as e:
                r.errors.append(f"{cond.source}: condition {cond.name}: {e}")

    # choice requires are evaluated before the storylet's own effects apply (see docs/debugging.md)
    if not r.errors:
        for where, msg, is_error in choice_reads_own_effects(content, engine):
            (r.errors if is_error else r.info).append(f"{where}: {msg}")

    # catalog binding
    if catalog is not None:
        for cond in content.conditions.values():
            if not cond.ref:
                continue
            el = catalog.get(cond.ref)
            if el is None or el.kind != "cond":
                r.errors.append(f"{cond.source}: condition {cond.name}: {cond.ref} is not a plot-database conditional")
                continue
            if cond.path and not any(h.ref == cond.ref for h in catalog.resolve_path(cond.path)):
                r.errors.append(f"{cond.source}: condition {cond.name}: path {cond.path} does not resolve to {cond.ref}")
            try:
                db_code = parse(catalog.condition_code(el) or "false")
            except ExprError as e:
                r.errors.append(f"{cond.source}: condition {cond.name}: database code for {cond.ref} not liftable: {e}")
                continue
            if str(db_code) != str(cond.code):
                r.errors.append(f"{cond.source}: condition {cond.name}: code differs from {cond.ref} in database:"
                                f"\n    content: {cond.code}\n    database: {db_code}")
        for decl in content.vars.values():
            if not decl.is_plot:
                continue
            el = catalog.get(decl.ref)
            if el is None:
                r.errors.append(f"{decl.source}: var {decl.name}: {decl.ref} not in plot database")
                continue
            if el.canonical != el.ref:
                r.errors.append(f"{decl.source}: var {decl.name}: {decl.ref} is an alias; bind {el.canonical}")
            if decl.path:
                hits = catalog.resolve_path(decl.path)
                if not any(h.canonical == decl.ref for h in hits):
                    r.errors.append(f"{decl.source}: var {decl.name}: path {decl.path} does not resolve to {decl.ref}"
                                    f" (resolves to {[h.ref for h in hits] or 'nothing'}; {decl.ref} is {el.db}:{el.path})")
            else:
                r.warnings.append(f"{decl.source}: var {decl.name}: no path given ({decl.ref} is {el.db}:{el.path})")
        for st in content.storylets.values():
            for ev in st.evidence:
                ok = catalog.get(ev) is not None if ":" not in ev else bool(catalog.resolve_path(ev))
                if not ok:
                    r.errors.append(f"{st.source}:{st.id}: evidence {ev!r} not found in plot database")

    # dataflow
    reads, writes = reads_writes(content, engine)
    for ref, readers in sorted(reads.items()):
        decl = content.by_ref.get(ref)
        if ref not in writes and not (decl and decl.default is not None):
            r.warnings.append(f"{ref} ({decl.name if decl else '?'}) is read by {sorted(readers)[:3]} but never written")
    for name, decl in content.vars.items():
        if decl.ref not in reads and decl.ref not in writes:
            r.info.append(f"var {name} is declared but unused")
    for ref, writers in sorted(writes.items()):
        if ref not in reads:
            decl = content.by_ref.get(ref)
            r.info.append(f"{decl.name if decl else ref} is written but never read (record-only)")

    # dynamic reachability
    if sim_runs and not r.errors:
        fired, chosen, traces = coverage(engine, sim_runs, seed)
        for st in content.storylets.values():
            if st.id not in fired:
                r.warnings.append(f"{st.id}: never fired in {sim_runs} simulated playthroughs")
            for c in st.choices:
                if st.id in fired and (st.id, c.id) not in chosen:
                    r.warnings.append(f"{st.id}/{c.id}: never chosen in {sim_runs} simulated playthroughs")
            for o in st.outcomes:
                if st.id in fired and (st.id, o.id) not in chosen:
                    r.info.append(f"{st.id}/{o.id}: outcome never resolved in {sim_runs} simulated playthroughs")
        for sid in sorted(set().union(*(t.preempted for t in traces))):
            r.warnings.append(f"{sid}: auto storylet was available, never fired, then became unavailable "
                              "(pre-empted by another auto beat; give it a higher priority?)")
        for tied in sorted(set().union(*(t.ties for t in traces))):
            r.info.append(f"auto storylets tied at equal priority, so file order decided which fired first: "
                          f"{', '.join(tied)}")
        stuck = sum(t.stuck for t in traces)
        if stuck:
            r.warnings.append(f"{stuck} simulated playthroughs hit the step limit (repeatable loop?)")
        lengths = sorted(len(t.steps) for t in traces)
        r.info.append(f"simulated {sim_runs} playthroughs: {len(fired)}/{len(content.storylets)} storylets fired; "
                      f"length min/median/max = {lengths[0]}/{lengths[len(lengths) // 2]}/{lengths[-1]}")
    return r
