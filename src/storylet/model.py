"""Storylet data model (schema v1; see docs/schema-evolution.md for later additions)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .expr import Effect, Node, parse

STATE_TYPES = ("bool", "int", "float")
DEFAULTS = {"bool": False, "int": 0, "float": 0.0}


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
class Storylet:
    id: str
    title: str
    game: str
    area: str
    summary: str = ""
    requires: Node = field(default_factory=lambda: parse(True))
    trigger: str = "player"          # 'auto' fires as soon as available; 'player' is an agency point
    repeatable: bool = False
    priority: int = 0
    effects: list[Effect] = field(default_factory=list)
    choices: list[Choice] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)  # plot-db refs/paths grounding this storylet
    notes: str = ""
    source: str = ""

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
