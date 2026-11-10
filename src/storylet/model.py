"""Storylet data model (schema v1; see docs/schema-evolution.md for later additions)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .expr import Effect, Node, parse

STATE_TYPES = ("bool", "int", "float", "enum")
DEFAULTS = {"bool": False, "int": 0, "float": 0.0, "enum": ""}
GAME_INDEX = {"me1": 1, "me2": 2, "me3": 3}
CAMPAIGN_VAR = "story.game"  # declaring it turns on per-game gating (schema v2)


@dataclass
class VarDecl:
    """A named state variable.

    ``ref`` is either a canonical plot-table ref (``me1.bool.3828``) - meaning the variable is
    the game's own state - or a ``story.*`` ref for state the games keep somewhere the plot
    databases don't show (or that this model abstracts).
    """
    name: str
    ref: str
    type: str
    path: str | None = None
    default: Any = None
    doc: str = ""
    source: str = ""
    values: tuple[str, ...] = ()  # enum members (v2)
    tags: tuple[str, ...] = ()    # (v3) aggregated with total('tag')

    @property
    def is_plot(self) -> bool:
        return not self.ref.startswith("story.")

    @property
    def initial(self) -> Any:
        return DEFAULTS[self.type] if self.default is None else self.default


@dataclass
class ConditionDecl:
    """A named boolean expression, usually lifted verbatim from a plot-database conditional.

    ``code`` is written in canonical refs (``me1.bool.2506``); ``meplot lift`` produces it and
    the validator checks it still matches the database. Conditions whose code uses BioWare's
    ``argument`` are called like functions: ``me1.world.completed_at_least(2)``.
    """
    name: str
    code: Node
    ref: str | None = None
    path: str | None = None
    doc: str = ""
    source: str = ""
    numeric: bool = False  # `derived:` values (v2) are not coerced to bool

    @property
    def takes_argument(self) -> bool:
        return "argument" in set(self.code.names())


@dataclass
class Choice:
    id: str
    label: str = ""
    requires: Node = field(default_factory=lambda: parse(True))
    effects: list[Effect] = field(default_factory=list)
    summary: str = ""


@dataclass
class Outcome:
    """A system-resolved branch (v2): applied when ``when`` holds, no player involvement."""
    id: str
    when: Node
    effects: list[Effect] = field(default_factory=list)
    summary: str = ""


@dataclass
class Storylet:
    id: str
    title: str
    game: str
    area: str
    summary: str = ""
    requires: Node = field(default_factory=lambda: parse(True))
    trigger: str = "player"          # 'auto' fires as soon as available; 'player' is an agency point;
                                     # 'idle' (v2) fires only when nothing else is available
    kind: str = "beat"               # 'beat' | 'bridge' (v2: exempt from per-game gating)
    repeatable: bool = False
    priority: int = 0
    effects: list[Effect] = field(default_factory=list)
    choices: list[Choice] = field(default_factory=list)
    outcomes: list[Outcome] = field(default_factory=list)
    limit: Node | None = None        # outcomes: stop after this many have applied (None: all matches).
                                     # `resolve: first` (v2) loads as limit 1.
    traits: list[str] = field(default_factory=list)
    trait_effects: int = 0           # how many of `effects` (the last ones) came from traits
    tags: list[str] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)  # plot-db refs/paths grounding this storylet
    notes: str = ""
    source: str = ""

    @property
    def own_effects(self) -> list[Effect]:
        """Effects written on the storylet itself, excluding those its traits contribute."""
        return self.effects[:len(self.effects) - self.trait_effects]

    def choice(self, cid: str) -> Choice:
        for c in self.choices:
            if c.id == cid:
                return c
        raise KeyError(f"{self.id} has no choice {cid!r}")


@dataclass
class Content:
    vars: dict[str, VarDecl] = field(default_factory=dict)
    conditions: dict[str, ConditionDecl] = field(default_factory=dict)
    storylets: dict[str, Storylet] = field(default_factory=dict)
    by_ref: dict[str, VarDecl] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)

    def ordered(self) -> list[Storylet]:
        return list(self.storylets.values())

    @property
    def gated(self) -> bool:
        return CAMPAIGN_VAR in self.vars
