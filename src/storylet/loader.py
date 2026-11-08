"""Load storylet content from YAML files.

File layout (any number of files under ``content/``)::

    game: me1                 # default for storylets in this file
    area: me1.virmire         # default area
    conditions:                # named expressions, typically lifted from the plot DB (`meplot lift`)
      me1.world.time_for_virmire_open:
        ref: me1.cond.1234
        path: me1:Global_Plots.World_Progress.Time_For_Virmire_Open
        code: "me1.bool.4104 == false && (...)"
    vars:
      me1.virmire.rescued_kaidan:
        ref: me1.bool.3828
        path: me1:CH2_Virmire.The_Choice.Rescued_Kaidan
      story.me1.paragon_points: {type: int, doc: ...}   # model-local state
      me1.virmire.complete: me1.bool.5271                # shorthand: just the ref
    storylets:
      - id: me1.virmire.the_choice
        title: ...
        requires: "a && b"          # or a list of clauses, ANDed
        effects: ["x = true"]
        choices:
          - id: save_kaidan
            effects: [...]
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .expr import ExprError, Node, parse, parse_effect
from .model import STATE_TYPES, Choice, ConditionDecl, Content, Storylet, VarDecl

KIND_TYPE = {"bool": "bool", "int": "int", "float": "float"}


def _requires(v: Any, where: str, errors: list[str]) -> Node:
    if v is None:
        return parse(True)
    if isinstance(v, list):
        v = " && ".join(f"({c})" for c in v) if v else True
    try:
        return parse(v)
    except ExprError as e:
        errors.append(f"{where}: {e}")
        return parse(False)


def _effects(v: Any, where: str, errors: list[str]) -> list:
    out = []
    for src in v or []:
        try:
            out.append(parse_effect(str(src)))
        except ExprError as e:
            errors.append(f"{where}: {e}")
    return out


def _var(name: str, spec: Any, source: str, errors: list[str]) -> VarDecl | None:
    if isinstance(spec, str):
        spec = {"ref": spec}
    spec = dict(spec or {})
    ref = spec.pop("ref", None)
    if ref is None:
        if not name.startswith("story."):
            errors.append(f"{source}: var {name} needs a ref (or a story.* name)")
            return None
        ref = name
    parts = ref.split(".")
    if ref.startswith("story."):
        vtype = spec.pop("type", "bool")
    elif len(parts) == 3 and parts[1] in KIND_TYPE:
        vtype = KIND_TYPE[parts[1]]
        if spec.get("type", vtype) != vtype:
            errors.append(f"{source}: var {name} type {spec['type']} contradicts ref {ref}")
        spec.pop("type", None)
    else:
        errors.append(f"{source}: var {name} has invalid ref {ref!r}")
        return None
    if vtype not in STATE_TYPES:
        errors.append(f"{source}: var {name} has invalid type {vtype}")
        return None
    decl = VarDecl(name=name, ref=ref, type=vtype, path=spec.pop("path", None), default=spec.pop("default", None),
                   doc=spec.pop("doc", ""), source=source)
    if spec:
        errors.append(f"{source}: var {name} has unknown keys {sorted(spec)}")
    return decl


STORYLET_KEYS = {"id", "title", "game", "area", "summary", "requires", "trigger", "repeatable", "priority",
                 "effects", "choices", "tags", "evidence", "notes"}
CHOICE_KEYS = {"id", "label", "requires", "effects", "summary"}


def load_file(path: Path, content: Content, root: Path | None = None) -> None:
    source = str(path.relative_to(root)) if root else str(path)
    errors = content.errors
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    game = doc.get("game", "")
    area = doc.get("area", "")
    for name, spec in (doc.get("vars") or {}).items():
        decl = _var(name, spec, source, errors)
        if decl is None:
            continue
        if name in content.vars:
            errors.append(f"{source}: var {name} already declared in {content.vars[name].source}")
            continue
        if decl.ref in content.by_ref and decl.ref != name:
            other = content.by_ref[decl.ref]
            errors.append(f"{source}: var {name} binds {decl.ref}, already bound to {other.name} ({other.source})")
        content.vars[name] = decl
        content.by_ref.setdefault(decl.ref, decl)
    for name, spec in (doc.get("conditions") or {}).items():
        if isinstance(spec, str):
            spec = {"code": spec}
        spec = dict(spec or {})
        where = f"{source}: condition {name}"
        if name in content.conditions or name in content.vars:
            errors.append(f"{where}: name already declared")
            continue
        try:
            code = parse(" ".join(str(spec.pop("code")).split()))
        except (ExprError, KeyError) as e:
            errors.append(f"{where}: {e}")
            continue
        content.conditions[name] = ConditionDecl(name=name, code=code, ref=spec.pop("ref", None),
                                                 path=spec.pop("path", None), doc=spec.pop("doc", ""), source=source)
        if spec:
            errors.append(f"{where}: unknown keys {sorted(spec)}")
    for raw in doc.get("storylets") or []:
        sid = raw.get("id")
        where = f"{source}:{sid}"
        if not sid:
            errors.append(f"{source}: storylet without id")
            continue
        unknown = set(raw) - STORYLET_KEYS
        if unknown:
            errors.append(f"{where}: unknown keys {sorted(unknown)}")
        choices = []
        for c in raw.get("choices") or []:
            cw = f"{where}/{c.get('id')}"
            if set(c) - CHOICE_KEYS:
                errors.append(f"{cw}: unknown keys {sorted(set(c) - CHOICE_KEYS)}")
            choices.append(Choice(id=str(c["id"]), label=c.get("label", ""), summary=c.get("summary", ""),
                                  requires=_requires(c.get("requires"), cw, errors),
                                  effects=_effects(c.get("effects"), cw, errors)))
        if len({c.id for c in choices}) != len(choices):
            errors.append(f"{where}: duplicate choice ids")
        trigger = raw.get("trigger", "player")
        if trigger not in ("auto", "player"):
            errors.append(f"{where}: trigger must be auto|player")
        st = Storylet(
            id=sid, title=raw.get("title", sid), game=raw.get("game", game), area=raw.get("area", area),
            summary=raw.get("summary", ""), requires=_requires(raw.get("requires"), where, errors),
            trigger=trigger, repeatable=bool(raw.get("repeatable", False)), priority=int(raw.get("priority", 0)),
            effects=_effects(raw.get("effects"), where, errors), choices=choices, tags=list(raw.get("tags") or []),
            evidence=list(raw.get("evidence") or []), notes=raw.get("notes", ""), source=source,
        )
        if sid in content.storylets:
            errors.append(f"{where}: duplicate storylet id (also in {content.storylets[sid].source})")
            continue
        content.storylets[sid] = st


def load_content(root: Path) -> Content:
    content = Content()
    for path in sorted(root.rglob("*.yaml")):
        load_file(path, content, root)
    return content
