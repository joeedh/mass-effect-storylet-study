"""Storylet runtime: availability, firing, simulation and exhaustive exploration."""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any, Iterable

from .expr import FUNCTIONS, SPECIAL_FORMS, ExprError, Node, evaluate
from .model import CAMPAIGN_VAR, DEFAULTS, GAME_INDEX, Choice, Content, Storylet

REF_KINDS = {"bool", "int", "float"}


@dataclass(frozen=True)
class State:
    values: tuple[tuple[str, Any], ...] = ()       # sorted (ref, value), defaults omitted
    fired: frozenset[str] = frozenset()
    chosen: frozenset[tuple[str, str]] = frozenset()

    def as_dict(self) -> dict[str, Any]:
        return dict(self.values)


@dataclass
class Step:
    storylet: str
    choice: str | None


@dataclass
class Trace:
    steps: list[Step] = field(default_factory=list)
    final: State = field(default_factory=State)
    stuck: bool = False


class Engine:
    def __init__(self, content: Content):
        self.content = content
        self.storylets = content.ordered()

    # -- names ------------------------------------------------------------------------------
    def ref_of(self, name: str) -> tuple[str, str]:
        """Return (ref, type) for a variable name or raw ref."""
        decl = self.content.vars.get(name)
        if decl is not None:
            return decl.ref, decl.type
        parts = name.split(".")
        if len(parts) == 3 and parts[0] in ("me1", "me2", "me3") and parts[1] in REF_KINDS and parts[2].isdigit():
            return name, parts[1]
        raise ExprError(f"unknown variable {name!r}")

    def expand_names(self, node: Node, _seen: frozenset = frozenset()) -> set[str]:
        """Variable names an expression depends on, looking through named conditions."""
        out: set[str] = set()
        cond_names = [n for n in node.names()] + [c.value for c in node.calls()]
        for name in cond_names:
            cond = self.content.conditions.get(name)
            if cond is not None:
                if name not in _seen:
                    out |= self.expand_names(cond.code, _seen | {name})
            elif name != "argument" and name not in FUNCTIONS and name not in SPECIAL_FORMS:
                out.add(name)
        return out

    def default(self, ref: str, vtype: str) -> Any:
        decl = self.content.by_ref.get(ref)
        return decl.initial if decl is not None else DEFAULTS[vtype]

    def get(self, state: State | dict, name: str) -> Any:
        ref, vtype = self.ref_of(name)
        values = state if isinstance(state, dict) else state.as_dict()
        return values.get(ref, self.default(ref, vtype))

    # -- evaluation ---------------------------------------------------------------------------
    def eval(self, node: Node, state: State, values: dict | None = None, _bound: dict | None = None,
             _depth: int = 0) -> Any:
        values = state.as_dict() if values is None else values
        if _depth > 32:
            raise ExprError("condition recursion too deep")

        def env(name: str) -> Any:
            if _bound and name in _bound:
                return _bound[name]
            cond = self.content.conditions.get(name)
            if cond is not None:
                if cond.takes_argument:
                    raise ExprError(f"condition {name} takes an argument: call it as {name}(...)")
                v = self.eval(cond.code, state, values, None, _depth + 1)
                return v if cond.numeric else bool(v)
            ref, vtype = self.ref_of(name)
            return values.get(ref, self.default(ref, vtype))

        def special(call: Node) -> Any:
            if call.value == "seen":
                return all(a.value in state.fired for a in call.args)
            if call.value == "chose":
                return (call.args[0].value, call.args[1].value) in state.chosen
            cond = self.content.conditions.get(call.value)
            if cond is not None and len(call.args) == 1:
                arg = evaluate(call.args[0], env, special)
                v = self.eval(cond.code, state, values, {"argument": arg}, _depth + 1)
                return v if cond.numeric else bool(v)
            raise ExprError(f"unknown function {call.value}()")

        return evaluate(node, env, special)

    def in_current_game(self, st: Storylet, values: dict) -> bool:
        """v2 campaign gating: a game's storylets only run while that game is being played."""
        if not self.content.gated or st.kind == "bridge" or st.game not in GAME_INDEX:
            return True
        return values.get(CAMPAIGN_VAR, self.default(CAMPAIGN_VAR, "int")) == GAME_INDEX[st.game]

    def choices(self, st: Storylet, state: State, values: dict | None = None) -> list[Choice]:
        values = state.as_dict() if values is None else values
        return [c for c in st.choices if self.eval(c.requires, state, values)]

    def is_available(self, st: Storylet, state: State, values: dict | None = None) -> bool:
        if not st.repeatable and st.id in state.fired:
            return False
        values = state.as_dict() if values is None else values
        if not self.in_current_game(st, values):
            return False
        if not self.eval(st.requires, state, values):
            return False
        return not st.choices or bool(self.choices(st, state, values))

    def available(self, state: State) -> list[Storylet]:
        values = state.as_dict()
        return [s for s in self.storylets if self.is_available(s, state, values)]

    def _assign(self, values: dict, ref: str, vtype: str, op: str, rhs: Any, target: str) -> None:
        if op == "+=":
            rhs = values.get(ref, self.default(ref, vtype)) + rhs
        elif op == "-=":
            rhs = values.get(ref, self.default(ref, vtype)) - rhs
        if vtype == "bool":
            rhs = bool(rhs)
        elif vtype == "int":
            rhs = int(rhs)
        elif vtype == "float":
            rhs = float(rhs)
        else:  # enum
            decl = self.content.by_ref[ref]
            if rhs != "" and rhs not in decl.values:
                raise ValueError(f"{target}: {rhs!r} is not one of {list(decl.values)}")
        values[ref] = rhs

    def fire(self, state: State, st: Storylet | str, choice: str | None = None) -> State:
        if isinstance(st, str):
            st = self.content.storylets[st]
        if not self.is_available(st, state):
            raise ValueError(f"storylet {st.id} is not available")
        effects = list(st.effects)
        chosen = state.chosen
        if st.choices:
            opts = self.choices(st, state)
            if choice is None:
                if len(opts) != 1:
                    raise ValueError(f"{st.id}: choose one of {[c.id for c in opts]}")
                choice = opts[0].id
            c = st.choice(choice)
            if c not in opts:
                raise ValueError(f"{st.id}/{choice} is not available")
            effects += c.effects
            chosen = chosen | {(st.id, c.id)}
        elif choice is not None:
            raise ValueError(f"{st.id} has no choices")
        values = state.as_dict()
        mid = State(state.values, state.fired | {st.id}, chosen)
        for eff in effects:
            ref, vtype = self.ref_of(eff.target)
            self._assign(values, ref, vtype, eff.op, self.eval(eff.expr, mid, values), eff.target)
        # v2: system-resolved outcomes, evaluated in order against the updated state
        for o in st.outcomes:
            mid = State(mid.values, mid.fired, chosen)
            if self.eval(o.when, mid, values):
                chosen = chosen | {(st.id, o.id)}
                mid = State(mid.values, mid.fired, chosen)
                for eff in o.effects:
                    ref, vtype = self.ref_of(eff.target)
                    self._assign(values, ref, vtype, eff.op, self.eval(eff.expr, mid, values), eff.target)
                if st.resolve == "first":
                    break
        return self._pack(values, mid.fired, chosen)

    def _pack(self, values: dict, fired: frozenset, chosen: frozenset) -> State:
        items = []
        for ref, v in values.items():
            decl = self.content.by_ref.get(ref)
            vtype = decl.type if decl else ref.split(".")[1]
            if v != self.default(ref, vtype):
                items.append((ref, v))
        return State(tuple(sorted(items)), fired, chosen)

    def initial(self, overrides: dict[str, Any] | None = None) -> State:
        values = {}
        for name, v in (overrides or {}).items():
            ref, _ = self.ref_of(name)
            values[ref] = v
        return self._pack(values, frozenset(), frozenset())

    # -- simulation ---------------------------------------------------------------------------
    def step_options(self, state: State) -> list[tuple[Storylet, str | None]]:
        """What can happen next: forced (auto) beats pre-empt player agency."""
        avail = self.available(state)
        autos = [s for s in avail if s.trigger == "auto"]
        if autos:
            top = max(s.priority for s in autos)
            pool = [next(s for s in autos if s.priority == top)]
        else:
            # v2: 'idle' storylets fire only when the player has nothing else to do
            pool = [s for s in avail if s.trigger == "player"] or [s for s in avail if s.trigger == "idle"]
        out = []
        values = state.as_dict()
        for s in pool:
            if s.choices:
                out.extend((s, c.id) for c in self.choices(s, state, values))
            else:
                out.append((s, None))
        return out

    def run(self, state: State | None = None, rng: random.Random | None = None, max_steps: int = 2000,
            policy=None) -> Trace:
        rng = rng or random.Random()
        state = state or self.initial()
        trace = Trace()
        for _ in range(max_steps):
            opts = self.step_options(state)
            if not opts:
                break
            st, cid = policy(state, opts) if policy else rng.choice(opts)
            state = self.fire(state, st, cid)
            trace.steps.append(Step(st.id, cid))
        else:
            trace.stuck = True
        trace.final = state
        return trace

    def explore(self, state: State | None = None, max_states: int = 200_000) -> "Exploration":
        """Exhaustive search over distinct states (memoized). May be truncated by ``max_states``."""
        start = state or self.initial()
        seen: set[State] = {start}
        stack = [start]
        ex = Exploration()
        while stack:
            s = stack.pop()
            opts = self.step_options(s)
            if not opts:
                ex.terminals.add(s)
                continue
            for st, cid in opts:
                ex.fired.add(st.id)
                if cid:
                    ex.chosen.add((st.id, cid))
                n = self.fire(s, st, cid)
                if n not in seen:
                    if len(seen) >= max_states:
                        ex.truncated = True
                        continue
                    seen.add(n)
                    stack.append(n)
        ex.states = len(seen)
        return ex


@dataclass
class Exploration:
    states: int = 0
    terminals: set[State] = field(default_factory=set)
    fired: set[str] = field(default_factory=set)
    chosen: set[tuple[str, str]] = field(default_factory=set)
    truncated: bool = False


def coverage(engine: Engine, runs: int, seed: int = 0, starts: Iterable[State] | None = None) -> tuple[set, set, list[Trace]]:
    rng = random.Random(seed)
    fired: set[str] = set()
    chosen: set[tuple[str, str]] = set()
    traces = []
    starts = list(starts or [engine.initial()])
    for i in range(runs):
        t = engine.run(starts[i % len(starts)], rng)
        traces.append(t)
        for step in t.steps:
            fired.add(step.storylet)
        chosen |= t.final.chosen
    return fired, chosen, traces
