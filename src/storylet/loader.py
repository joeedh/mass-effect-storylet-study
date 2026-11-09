"""Load storylet content from YAML files.

File layout (any number of files under ``content/``; all files share one namespace)::

    game: me1                 # default for storylets in this file
    area: me1.virmire         # default area
    conditions:               # named boolean expressions, typically lifted from the plot DB (`meplot bind`)
      me1.world.time_for_virmire_open:
        ref: me1.cond.1065
        path: me1:Global_Plots.World_Progress.Time_For_Virmire_Open
        code: "me1.bool.4104 == false && (...)"
    derived:                  # (v2) named numeric expressions
      me2.sm.htl_score: "sum(...) / max(1, me2.sm.htl_defenders)"
    traits:                   # (v2) reusable requires/effects/tags, applied with `traits: [name]`
      me2.mission: {effects: ["me2.progress.missions_total += 1"]}
    vars:
      me1.virmire.rescued_kaidan: {ref: me1.bool.3828, path: me1:CH2_Virmire.The_Choice.Rescued_Kaidan}
      story.me1.paragon_points: {type: int, doc: ...}           # model-local state
      story.me2.sm.tech: {type: enum, values: [tali, legion]}   # (v2) enum
      me1.virmire.complete: me1.bool.5271                       # shorthand: just the ref
    storylets:
      - id: me1.virmire.the_choice
        requires: "a && b"          # or a list of clauses, ANDed
        effects: ["x = true"]
        choices:  [{id: ..., requires: ..., effects: [...]}]
        outcomes: [{id: ..., when: ..., effects: [...]}]      # (v2) system-resolved
        resolve: first                                       # (v2) or 'all' (default)
      - foreach: [{who: garrus, code: Garrus}, ...]            # (v2) template: {who}/{code} substituted
        id: me2.loyalty.{who}
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

from .expr import ExprError, Node, parse, parse_effect
from .model import STATE_TYPES, Choice, ConditionDecl, Content, Outcome, Storylet, VarDecl

KIND_TYPE = {"bool": "bool", "int": "int", "float": "float"}
STORYLET_KEYS = {"id", "title", "game", "area", "summary", "requires", "trigger", "repeatable", "priority",
                 "effects", "choices", "outcomes", "resolve", "kind", "traits", "tags", "evidence", "notes"}
CHOICE_KEYS = {"id", "label", "requires", "effects", "summary"}
OUTCOME_KEYS = {"id", "when", "effects", "summary"}
TRAIT_KEYS = {"requires", "effects", "tags", "doc", "params"}
PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _requires(v: Any, where: str, errors: list[str]) -> Node:
    if v is None:
        return parse(True)
    if isinstance(v, list):
        v = " && ".join(f"({c})" for c in v) if v else True
    try:
        return parse(" ".join(v.split()) if isinstance(v, str) else v)
    except ExprError as e:
        errors.append(f"{where}: {e}")
        return parse(False)


def _effects(v: Any, where: str, errors: list[str]) -> list:
    out = []
    for src in v or []:
        try:
            out.append(parse_effect(" ".join(str(src).split())))
        except ExprError as e:
            errors.append(f"{where}: {e}")
    return out


# --- templating (v2) ---------------------------------------------------------------------------
def _subst(obj: Any, binding: dict[str, Any]) -> Any:
    if isinstance(obj, str):
        def rep(m: re.Match) -> str:
            k = m.group(1)
            if k not in binding:
                return m.group(0)
            v = binding[k]
            return ("true" if v else "false") if isinstance(v, bool) else str(v)
        return PLACEHOLDER.sub(rep, obj)
    if isinstance(obj, list):
        return [_subst(x, binding) for x in obj]
    if isinstance(obj, dict):
        return {_subst(k, binding): _subst(v, binding) for k, v in obj.items()}
    return obj


def expand(items: list | None) -> list:
    """Expand ``foreach`` entries. ``foreach`` is a list of dicts or of scalars (bound to ``item``)."""
    out = []
    for raw in items or []:
        if not isinstance(raw, dict) or "foreach" not in raw:
            out.append(raw)
            continue
        body = {k: v for k, v in raw.items() if k != "foreach"}
        for b in raw["foreach"]:
            binding = b if isinstance(b, dict) else {"item": b}
            out.append(_subst(body, binding))
    return out


# --- declarations ------------------------------------------------------------------------------
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
    values = tuple(spec.pop("values", ()) or ())
    if vtype == "enum" and not values:
        errors.append(f"{source}: enum var {name} needs values")
    decl = VarDecl(name=name, ref=ref, type=vtype, path=spec.pop("path", None), default=spec.pop("default", None),
                   doc=spec.pop("doc", ""), source=source, values=values, tags=tuple(spec.pop("tags", ()) or ()))
    if spec:
        errors.append(f"{source}: var {name} has unknown keys {sorted(spec)}")
    return decl


def _expand_section(section: dict | None) -> dict:
    """``name.{who}: {foreach: [...], ...}`` -> one entry per binding (v2)."""
    out: dict = {}
    for name, spec in (section or {}).items():
        if isinstance(spec, dict) and "foreach" in spec:
            body = {k: v for k, v in spec.items() if k != "foreach"}
            for b in spec["foreach"]:
                binding = b if isinstance(b, dict) else {"item": b}
                out[_subst(name, binding)] = _subst(body, binding)
        else:
            out[name] = spec
    return out


def _load_decls(doc: dict, source: str, content: Content, traits: dict[str, dict]) -> None:
    errors = content.errors
    for name, spec in _expand_section(doc.get("vars")).items():
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
    for section, numeric in (("conditions", False), ("derived", True)):
        for name, spec in _expand_section(doc.get(section)).items():
            if isinstance(spec, str):
                spec = {"code": spec}
            spec = dict(spec or {})
            where = f"{source}: {section} {name}"
            if name in content.conditions or name in content.vars:
                errors.append(f"{where}: name already declared")
                continue
            try:
                code = parse(" ".join(str(spec.pop("code")).split()))
            except (ExprError, KeyError) as e:
                errors.append(f"{where}: {e}")
                continue
            content.conditions[name] = ConditionDecl(name=name, code=code, ref=spec.pop("ref", None),
                                                     path=spec.pop("path", None), doc=spec.pop("doc", ""),
                                                     source=source, numeric=numeric)
            if spec:
                errors.append(f"{where}: unknown keys {sorted(spec)}")
    for name, spec in (doc.get("traits") or {}).items():
        if name in traits:
            errors.append(f"{source}: trait {name} already defined")
            continue
        if set(spec) - TRAIT_KEYS:
            errors.append(f"{source}: trait {name}: unknown keys {sorted(set(spec) - TRAIT_KEYS)}")
        traits[name] = spec


def _load_storylets(doc: dict, source: str, content: Content, traits: dict[str, dict]) -> None:
    errors = content.errors
    game = doc.get("game", "")
    area = doc.get("area", "")
    for raw in expand(doc.get("storylets")):
        sid = raw.get("id")
        where = f"{source}:{sid}"
        if not sid:
            errors.append(f"{source}: storylet without id")
            continue
        unknown = set(raw) - STORYLET_KEYS
        if unknown:
            errors.append(f"{where}: unknown keys {sorted(unknown)}")
        requires = raw.get("requires")
        requires = list(requires) if isinstance(requires, list) else ([requires] if requires is not None else [])
        effects_src = list(raw.get("effects") or [])
        tags = list(raw.get("tags") or [])
        trait_names = []
        own_effect_count = len(effects_src)
        for tref in raw.get("traits") or []:
            # (v3) parameterized trait: {me3.mission: {code: Kro001}}
            if isinstance(tref, dict) and len(tref) == 1:
                tname, params = next(iter(tref.items()))
            else:
                tname, params = tref, {}
            trait_names.append(tname)
            t = traits.get(tname)
            if t is None:
                errors.append(f"{where}: unknown trait {tname!r}")
                continue
            t = _subst(t, params or {})
            missing = sorted(set(PLACEHOLDER.findall(str([t.get("requires"), t.get("effects")]))))
            if missing:
                errors.append(f"{where}: trait {tname} needs parameters {missing}")
            if t.get("requires") is not None:
                requires.append(t["requires"])
            effects_src += list(t.get("effects") or [])
            tags += [x for x in t.get("tags") or [] if x not in tags]
        choices = []
        for c in expand(raw.get("choices")):
            cw = f"{where}/{c.get('id')}"
            if set(c) - CHOICE_KEYS:
                errors.append(f"{cw}: unknown keys {sorted(set(c) - CHOICE_KEYS)}")
            choices.append(Choice(id=str(c["id"]), label=c.get("label", ""), summary=c.get("summary", ""),
                                  requires=_requires(c.get("requires"), cw, errors),
                                  effects=_effects(c.get("effects"), cw, errors)))
        outcomes = []
        for o in expand(raw.get("outcomes")):
            ow = f"{where}/{o.get('id')}"
            if set(o) - OUTCOME_KEYS:
                errors.append(f"{ow}: unknown keys {sorted(set(o) - OUTCOME_KEYS)}")
            outcomes.append(Outcome(id=str(o["id"]), when=_requires(o.get("when"), ow, errors),
                                    effects=_effects(o.get("effects"), ow, errors), summary=o.get("summary", "")))
        ids = [c.id for c in choices] + [o.id for o in outcomes]
        if len(set(ids)) != len(ids):
            errors.append(f"{where}: duplicate choice/outcome ids")
        trigger = raw.get("trigger", "player")
        if trigger not in ("auto", "player", "idle"):
            errors.append(f"{where}: trigger must be auto|player|idle")
        resolve = raw.get("resolve", "all")
        if resolve not in ("all", "first"):
            errors.append(f"{where}: resolve must be all|first")
        kind = raw.get("kind", "beat")
        if kind not in ("beat", "bridge"):
            errors.append(f"{where}: kind must be beat|bridge")
        st = Storylet(
            id=sid, title=raw.get("title", sid), game=raw.get("game", game), area=raw.get("area", area),
            summary=" ".join(str(raw.get("summary", "")).split()), requires=_requires(requires or None, where, errors),
            trigger=trigger, kind=kind, repeatable=bool(raw.get("repeatable", False)),
            priority=int(raw.get("priority", 0)), effects=_effects(effects_src, where, errors), choices=choices,
            outcomes=outcomes, resolve=resolve, traits=trait_names, tags=tags,
            trait_effects=len(effects_src) - own_effect_count,
            evidence=list(raw.get("evidence") or []), notes=raw.get("notes", ""), source=source,
        )
        if sid in content.storylets:
            errors.append(f"{where}: duplicate storylet id (also in {content.storylets[sid].source})")
            continue
        content.storylets[sid] = st


def load_docs(docs: list[tuple[str, dict]]) -> Content:
    content = Content()
    traits: dict[str, dict] = {}
    for source, doc in docs:
        _load_decls(doc, source, content, traits)
    for source, doc in docs:
        _load_storylets(doc, source, content, traits)
    return content


def load_content(root: Path) -> Content:
    docs = []
    for path in sorted(root.rglob("*.yaml")):
        docs.append((str(path.relative_to(root)), yaml.safe_load(path.read_text(encoding="utf-8")) or {}))
    return load_docs(docs)
