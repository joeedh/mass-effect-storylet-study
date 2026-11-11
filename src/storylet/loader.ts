/**
 * Load storylet content from YAML files.
 *
 * File layout (any number of files under `content/`; all files share one namespace):
 *
 *     game: me1                 # default for storylets in this file
 *     area: me1.virmire         # default area
 *     conditions:               # named boolean expressions, typically lifted from the plot DB (`meplot bind`)
 *       me1.world.time_for_virmire_open:
 *         ref: me1.cond.1065
 *         path: me1:Global_Plots.World_Progress.Time_For_Virmire_Open
 *         code: "me1.bool.4104 == false && (...)"
 *     derived:                  # (v2) named numeric expressions
 *       me2.sm.htl_score: "sum(...) / max(1, me2.sm.htl_defenders)"
 *     traits:                   # (v2) reusable requires/effects/tags, applied with `traits: [name]`
 *       me2.mission: {effects: ["me2.progress.missions_total += 1"]}
 *     vars:
 *       me1.virmire.rescued_kaidan: {ref: me1.bool.3828, path: me1:CH2_Virmire.The_Choice.Rescued_Kaidan}
 *       story.me1.paragon_points: {type: int, doc: ...}           # model-local state
 *       story.me2.sm.tech: {type: enum, values: [tali, legion]}   # (v2) enum
 *       me1.virmire.complete: me1.bool.5271                       # shorthand: just the ref
 *     storylets:
 *       - id: me1.virmire.the_choice
 *         requires: "a && b"          # or a list of clauses, ANDed
 *         effects: ["x = true"]
 *         choices:  [{id: ..., requires: ..., effects: [...]}]
 *         outcomes: [{id: ..., when: ..., effects: [...]}]      # (v2) system-resolved
 *         resolve: first                                       # (v2) or 'all' (default); same as limit: 1
 *         limit: "me2.sm.htl_deaths"                           # apply at most N matching outcomes
 *       - foreach: [{who: garrus, code: Garrus}, ...]            # (v2) template: {who}/{code} substituted
 *         id: me2.loyalty.{who}
 *
 * YAML is parsed with the 1.1 schema, as PyYAML's `safe_load` did when this was Python.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { DocumentOptions, ParseOptions, SchemaOptions, Tags } from 'yaml';
import { ExprError, parse, parseEffect } from './expr.ts';
import type { Effect, Node } from './expr.ts';
import { ALWAYS, Content, isVarType, makeCondition } from './model.ts';
import type { Choice, Outcome, Storylet, VarDecl } from './model.ts';
import * as py from './pycompat.ts';
import type { Value } from './pycompat.ts';

type YMap = Record<string, unknown>;

const KIND_TYPE: ReadonlyMap<string, 'bool' | 'int' | 'float'> = new Map([
  ['bool', 'bool'],
  ['int', 'int'],
  ['float', 'float'],
]);
const STORYLET_KEYS = new Set([
  'id',
  'title',
  'game',
  'area',
  'summary',
  'requires',
  'trigger',
  'repeatable',
  'priority',
  'effects',
  'choices',
  'outcomes',
  'resolve',
  'limit',
  'kind',
  'traits',
  'tags',
  'evidence',
  'notes',
]);
const CHOICE_KEYS = new Set(['id', 'label', 'requires', 'effects', 'summary']);
const OUTCOME_KEYS = new Set(['id', 'when', 'effects', 'summary']);
const TRAIT_KEYS = new Set(['requires', 'effects', 'tags', 'doc', 'params']);
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// --- narrowing YAML --------------------------------------------------------------------------
function isMap(v: unknown): v is YMap {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isScalar(v: unknown): v is Value {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** Python's `d.get(k, default)`: a key present with a null value gives null, not the default. */
function get(m: YMap, key: string, dflt: unknown = undefined): unknown {
  return Object.hasOwn(m, key) ? m[key] : dflt;
}

/** Python's `dict.pop(k, default)`. */
function pop(m: YMap, key: string, dflt: unknown = undefined): unknown {
  if (!Object.hasOwn(m, key)) return dflt;
  const v = m[key];
  delete m[key];
  return v;
}

/** The text a scalar contributes when spliced into an expression or a template. */
function text(v: unknown): string {
  if (isScalar(v)) return py.str(v);
  if (v === null || v === undefined) return 'None';
  return JSON.stringify(v);
}

/** A list field: absent or empty gives []; anything other than a list is an error. */
function list(v: unknown, where: string, errors: string[]): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined || v === false || v === '' || v === 0) return [];
  errors.push(`${where}: expected a list, got ${py.repr(text(v))}`);
  return [];
}

function strList(v: unknown, where: string, errors: string[]): string[] {
  return list(v, where, errors).map((x) => text(x));
}

/** A string field, with Python's `get(k, default)` semantics. */
function str(m: YMap, key: string, dflt: string): string {
  const v = get(m, key, dflt);
  return typeof v === 'string' ? v : text(v);
}

function optStr(m: YMap, key: string, where: string, errors: string[]): string | null {
  const v = pop(m, key, null);
  if (v === null || typeof v === 'string') return v;
  errors.push(`${where}: ${key} must be a string`);
  return null;
}

function sortedKeys(keys: Iterable<string>): string {
  return py.repr([...keys].sort());
}

// --- expressions ------------------------------------------------------------------------------
function requiresNode(v: unknown, where: string, errors: string[]): Node {
  if (v === null || v === undefined) return ALWAYS;
  let src: unknown = v;
  if (Array.isArray(v)) src = v.length ? v.map((c) => `(${text(c)})`).join(' && ') : true;
  try {
    if (typeof src === 'string') return parse(py.squash(src));
    if (typeof src === 'boolean' || typeof src === 'number') return parse(src);
    throw new ExprError(`expected an expression, got ${text(src)}`);
  } catch (e) {
    if (!(e instanceof ExprError)) throw e;
    errors.push(`${where}: ${e.message}`);
    return parse(false);
  }
}

function effectList(v: unknown, where: string, errors: string[]): Effect[] {
  const out: Effect[] = [];
  for (const src of list(v, where, errors)) {
    try {
      out.push(parseEffect(py.squash(text(src))));
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      errors.push(`${where}: ${e.message}`);
    }
  }
  return out;
}

// --- templating (v2) ---------------------------------------------------------------------------
function subst(obj: unknown, binding: YMap): unknown {
  if (typeof obj === 'string') {
    return obj.replace(PLACEHOLDER, (whole, k: string) =>
      Object.hasOwn(binding, k) ? text(binding[k]) : whole,
    );
  }
  if (Array.isArray(obj)) return obj.map((x) => subst(x, binding));
  if (isMap(obj)) {
    const out: YMap = {};
    for (const [k, v] of Object.entries(obj)) out[subst(k, binding) as string] = subst(v, binding);
    return out;
  }
  return obj;
}

function bindingOf(b: unknown): YMap {
  return isMap(b) ? b : { item: b };
}

/** Expand `foreach` entries. `foreach` is a list of mappings or of scalars (bound to `item`). */
export function expand(items: unknown, where: string, errors: string[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of list(items, where, errors)) {
    if (!isMap(raw) || !Object.hasOwn(raw, 'foreach')) {
      out.push(raw);
      continue;
    }
    const body = { ...raw };
    delete body['foreach'];
    for (const b of list(raw['foreach'], `${where}: foreach`, errors)) {
      out.push(subst(body, bindingOf(b)));
    }
  }
  return out;
}

/** `name.{who}: {foreach: [...], ...}` -> one entry per binding (v2). */
function expandSection(section: unknown, where: string, errors: string[]): [string, unknown][] {
  if (section === null || section === undefined) return [];
  if (!isMap(section)) {
    errors.push(`${where}: expected a mapping`);
    return [];
  }
  const out = new Map<string, unknown>();
  for (const [name, spec] of Object.entries(section)) {
    if (isMap(spec) && Object.hasOwn(spec, 'foreach')) {
      const body = { ...spec };
      delete body['foreach'];
      for (const b of list(spec['foreach'], `${where} ${name}: foreach`, errors)) {
        const binding = bindingOf(b);
        out.set(subst(name, binding) as string, subst(body, binding));
      }
    } else {
      out.set(name, spec);
    }
  }
  return [...out];
}

// --- declarations ------------------------------------------------------------------------------
function loadVar(name: string, rawSpec: unknown, source: string, errors: string[]): VarDecl | null {
  const where = `${source}: var ${name}`;
  if (typeof rawSpec === 'string') rawSpec = { ref: rawSpec };
  if (rawSpec !== null && rawSpec !== undefined && !isMap(rawSpec)) {
    errors.push(`${where} must be a ref or a mapping`);
    return null;
  }
  const spec: YMap = { ...(rawSpec ?? {}) };
  let ref = pop(spec, 'ref', null);
  if (ref === null) {
    if (!name.startsWith('story.')) {
      errors.push(`${where} needs a ref (or a story.* name)`);
      return null;
    }
    ref = name;
  }
  if (typeof ref !== 'string') {
    errors.push(`${where} has invalid ref ${py.repr(text(ref))}`);
    return null;
  }
  const parts = ref.split('.');
  let vtype: unknown;
  if (ref.startsWith('story.')) {
    vtype = pop(spec, 'type', 'bool');
  } else if (parts.length === 3 && KIND_TYPE.has(parts[1]!)) {
    vtype = KIND_TYPE.get(parts[1]!);
    if (get(spec, 'type', vtype) !== vtype) {
      errors.push(`${where} type ${text(spec['type'])} contradicts ref ${ref}`);
    }
    pop(spec, 'type');
  } else {
    errors.push(`${where} has invalid ref ${py.repr(ref)}`);
    return null;
  }
  if (!isVarType(vtype)) {
    errors.push(`${where} has invalid type ${text(vtype)}`);
    return null;
  }
  const values = list(pop(spec, 'values'), `${where}: values`, errors).filter(isScalar);
  if (vtype === 'enum' && values.length === 0) {
    errors.push(`${source}: enum var ${name} needs values`);
  }
  const dflt = pop(spec, 'default', null);
  if (dflt !== null && !isScalar(dflt)) errors.push(`${where}: default must be a scalar`);
  const decl: VarDecl = {
    name,
    ref,
    type   : vtype,
    path   : optStr(spec, 'path', where, errors),
    default: isScalar(dflt) ? dflt : null,
    doc    : text(pop(spec, 'doc', '')),
    source,
    values,
    tags: strList(pop(spec, 'tags'), `${where}: tags`, errors),
  };
  if (Object.keys(spec).length) {
    errors.push(`${where} has unknown keys ${sortedKeys(Object.keys(spec))}`);
  }
  return decl;
}

function loadDecls(doc: YMap, source: string, content: Content, traits: Map<string, YMap>): void {
  const errors = content.errors;
  for (const [name, spec] of expandSection(get(doc, 'vars'), `${source}: vars`, errors)) {
    const decl = loadVar(name, spec, source, errors);
    if (decl === null) continue;
    const prev = content.vars.get(name);
    if (prev !== undefined) {
      errors.push(`${source}: var ${name} already declared in ${prev.source}`);
      continue;
    }
    const other = content.byRef.get(decl.ref);
    if (other !== undefined && decl.ref !== name) {
      errors.push(
        `${source}: var ${name} binds ${decl.ref}, already bound to ${other.name} (${other.source})`,
      );
    }
    content.vars.set(name, decl);
    if (!content.byRef.has(decl.ref)) content.byRef.set(decl.ref, decl);
  }
  for (const [section, numeric] of [
    ['conditions', false],
    ['derived', true],
  ] as const) {
    for (const [name, rawSpec] of expandSection(
      get(doc, section),
      `${source}: ${section}`,
      errors,
    )) {
      const where = `${source}: ${section} ${name}`;
      const spec: YMap = isMap(rawSpec) ? { ...rawSpec } : { code: rawSpec };
      if (content.conditions.has(name) || content.vars.has(name)) {
        errors.push(`${where}: name already declared`);
        continue;
      }
      if (!Object.hasOwn(spec, 'code')) {
        errors.push(`${where}: 'code'`);
        continue;
      }
      const code = requiresNode(pop(spec, 'code'), where, errors);
      content.conditions.set(
        name,
        makeCondition({
          name,
          code,
          ref : optStr(spec, 'ref', where, errors),
          path: optStr(spec, 'path', where, errors),
          doc : text(pop(spec, 'doc', '')),
          source,
          numeric,
        }),
      );
      if (Object.keys(spec).length) {
        errors.push(`${where}: unknown keys ${sortedKeys(Object.keys(spec))}`);
      }
    }
  }
  const traitSection = get(doc, 'traits') ?? {};
  if (!isMap(traitSection)) {
    errors.push(`${source}: traits: expected a mapping`);
    return;
  }
  for (const [name, spec] of Object.entries(traitSection)) {
    if (traits.has(name)) {
      errors.push(`${source}: trait ${name} already defined`);
      continue;
    }
    if (!isMap(spec)) {
      errors.push(`${source}: trait ${name}: expected a mapping`);
      continue;
    }
    const unknown = Object.keys(spec).filter((k) => !TRAIT_KEYS.has(k));
    if (unknown.length) {
      errors.push(`${source}: trait ${name}: unknown keys ${sortedKeys(unknown)}`);
    }
    traits.set(name, spec);
  }
}

function collectStrings(v: unknown, out: string[]): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (isMap(v)) for (const [k, x] of Object.entries(v)) (out.push(k), collectStrings(x, out));
  return out;
}

function placeholders(v: unknown): string[] {
  const found = new Set<string>();
  for (const s of collectStrings(v, [])) for (const m of s.matchAll(PLACEHOLDER)) found.add(m[1]!);
  return [...found].sort();
}

function idOf(m: YMap): string | null {
  const v = get(m, 'id');
  return v === undefined || v === null ? null : text(v);
}

function loadStorylets(
  doc: YMap,
  source: string,
  content: Content,
  traits: Map<string, YMap>,
): void {
  const errors = content.errors;
  const game = str(doc, 'game', '');
  const area = str(doc, 'area', '');
  for (const raw of expand(get(doc, 'storylets'), `${source}: storylets`, errors)) {
    if (!isMap(raw)) {
      errors.push(`${source}: storylet must be a mapping`);
      continue;
    }
    const rawId = get(raw, 'id');
    if (rawId === undefined || rawId === null || rawId === '' || rawId === false || rawId === 0) {
      errors.push(`${source}: storylet without id`);
      continue;
    }
    const sid = text(rawId);
    const where = `${source}:${sid}`;
    const unknown = Object.keys(raw).filter((k) => !STORYLET_KEYS.has(k));
    if (unknown.length) errors.push(`${where}: unknown keys ${sortedKeys(unknown)}`);

    const req = get(raw, 'requires');
    const requires: unknown[] = Array.isArray(req)
      ? [...(req as unknown[])]
      : req !== undefined && req !== null
        ? [req]
        : [];
    const effectsSrc: unknown[] = [...list(get(raw, 'effects'), `${where}: effects`, errors)];
    const tags = strList(get(raw, 'tags'), `${where}: tags`, errors);
    const traitNames: string[] = [];
    const ownEffectCount = effectsSrc.length;
    for (const tref of list(get(raw, 'traits'), `${where}: traits`, errors)) {
      // (v3) parameterized trait: {me3.mission: {code: Kro001}}
      let tname: string;
      let params: unknown = {};
      if (isMap(tref) && Object.keys(tref).length === 1) {
        const [entry] = Object.entries(tref);
        [tname, params] = entry!;
      } else {
        tname = text(tref);
      }
      traitNames.push(tname);
      const trait = traits.get(tname);
      if (trait === undefined) {
        errors.push(`${where}: unknown trait ${py.repr(tname)}`);
        continue;
      }
      if (params !== null && !isMap(params)) {
        errors.push(`${where}: trait ${tname} parameters must be a mapping`);
        continue;
      }
      const t = subst(trait, params ?? {}) as YMap;
      const missing = placeholders([get(t, 'requires', null), get(t, 'effects', null)]);
      if (missing.length) {
        errors.push(`${where}: trait ${tname} needs parameters ${py.repr(missing)}`);
      }
      const treq = get(t, 'requires', null);
      if (treq !== null) requires.push(treq);
      effectsSrc.push(...list(get(t, 'effects'), `${where}: trait ${tname} effects`, errors));
      const newTags = strList(get(t, 'tags'), `${where}: trait ${tname} tags`, errors).filter(
        (x) => !tags.includes(x),
      );
      tags.push(...newTags);
    }

    const choices: Choice[] = [];
    for (const c of expand(get(raw, 'choices'), `${where}: choices`, errors)) {
      if (!isMap(c)) {
        errors.push(`${where}: choice must be a mapping`);
        continue;
      }
      const cid = idOf(c);
      const cw = `${where}/${cid ?? 'None'}`;
      const bad = Object.keys(c).filter((k) => !CHOICE_KEYS.has(k));
      if (bad.length) errors.push(`${cw}: unknown keys ${sortedKeys(bad)}`);
      if (cid === null) {
        errors.push(`${cw}: choice without id`);
        continue;
      }
      choices.push({
        id      : cid,
        label   : str(c, 'label', ''),
        summary : str(c, 'summary', ''),
        requires: requiresNode(get(c, 'requires'), cw, errors),
        effects : effectList(get(c, 'effects'), cw, errors),
      });
    }
    const outcomes: Outcome[] = [];
    for (const o of expand(get(raw, 'outcomes'), `${where}: outcomes`, errors)) {
      if (!isMap(o)) {
        errors.push(`${where}: outcome must be a mapping`);
        continue;
      }
      const oid = idOf(o);
      const ow = `${where}/${oid ?? 'None'}`;
      const bad = Object.keys(o).filter((k) => !OUTCOME_KEYS.has(k));
      if (bad.length) errors.push(`${ow}: unknown keys ${sortedKeys(bad)}`);
      if (oid === null) {
        errors.push(`${ow}: outcome without id`);
        continue;
      }
      outcomes.push({
        id     : oid,
        when   : requiresNode(get(o, 'when'), ow, errors),
        effects: effectList(get(o, 'effects'), ow, errors),
        summary: str(o, 'summary', ''),
      });
    }
    const ids = [...choices.map((c) => c.id), ...outcomes.map((o) => o.id)];
    if (new Set(ids).size !== ids.length) errors.push(`${where}: duplicate choice/outcome ids`);

    const trigger = get(raw, 'trigger', 'player');
    if (trigger !== 'auto' && trigger !== 'player' && trigger !== 'idle') {
      errors.push(`${where}: trigger must be auto|player|idle`);
    }
    const resolve = get(raw, 'resolve', 'all');
    if (resolve !== 'all' && resolve !== 'first') {
      errors.push(`${where}: resolve must be all|first`);
    }
    let limit: Node | null = null;
    if (Object.hasOwn(raw, 'limit')) {
      if (resolve === 'first') {
        errors.push(`${where}: give either resolve: first or limit, not both`);
      }
      if (!outcomes.length) errors.push(`${where}: limit applies to outcomes, and there are none`);
      const lim = raw['limit'];
      try {
        if (typeof lim === 'string') limit = parse(py.squash(lim));
        else if (typeof lim === 'number' || typeof lim === 'boolean') limit = parse(lim);
        else throw new ExprError(`expected an expression, got ${text(lim)}`);
      } catch (e) {
        if (!(e instanceof ExprError)) throw e;
        errors.push(`${where}: limit: ${e.message}`);
      }
    } else if (resolve === 'first') {
      limit = parse(1);
    }
    const kind = get(raw, 'kind', 'beat');
    if (kind !== 'beat' && kind !== 'bridge') errors.push(`${where}: kind must be beat|bridge`);
    const priority = get(raw, 'priority', 0);
    let prio = 0;
    try {
      prio = isScalar(priority) ? py.toInt(priority) : 0;
    } catch {
      errors.push(`${where}: priority must be an integer`);
    }

    const st: Storylet = {
      id        : sid,
      title     : str(raw, 'title', sid),
      game      : str(raw, 'game', game),
      area      : str(raw, 'area', area),
      summary   : py.squash(text(get(raw, 'summary', ''))),
      requires  : requiresNode(requires.length ? requires : null, where, errors),
      trigger   : trigger === 'auto' || trigger === 'idle' ? trigger : 'player',
      kind      : kind === 'bridge' ? 'bridge' : 'beat',
      repeatable: py.truthy(
        isScalar(get(raw, 'repeatable')) ? (get(raw, 'repeatable') as Value) : false,
      ),
      priority  : prio,
      effects   : effectList(effectsSrc, where, errors),
      choices,
      outcomes,
      limit,
      traits: traitNames,
      tags,
      traitEffects: effectsSrc.length - ownEffectCount,
      evidence    : strList(get(raw, 'evidence'), `${where}: evidence`, errors),
      notes       : str(raw, 'notes', ''),
      source,
    };
    const prev = content.storylets.get(sid);
    if (prev !== undefined) {
      errors.push(`${where}: duplicate storylet id (also in ${prev.source})`);
      continue;
    }
    content.storylets.set(sid, st);
  }
}

/** Load parsed documents: every file's declarations first, then every file's storylets. */
export function loadDocs(docs: readonly (readonly [string, unknown])[]): Content {
  const content = new Content();
  const traits = new Map<string, YMap>();
  const maps: [string, YMap][] = [];
  for (const [source, doc] of docs) {
    if (doc === null || doc === undefined) maps.push([source, {}]);
    else if (isMap(doc)) maps.push([source, doc]);
    else content.errors.push(`${source}: expected a mapping at the top level`);
  }
  for (const [source, doc] of maps) loadDecls(doc, source, content, traits);
  for (const [source, doc] of maps) loadStorylets(doc, source, content, traits);
  return content;
}

/**
 * Files in the order Python's `sorted(root.rglob("*.yaml"))` gave: part by part, and ignoring
 * case on Windows. File order is storylet order, which breaks ties between auto storylets.
 */
export function contentFiles(root: string): string[] {
  const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s);
  return fs
    .readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((f) => f.split(/[\\/]/))
    .filter(
      (parts) =>
        parts.at(-1)?.endsWith('.yaml') === true && fs.statSync(path.join(root, ...parts)).isFile(),
    )
    .sort((a, b) => py.cmpTuple(a.map(fold), b.map(fold)))
    .map((parts) => parts.join('/'));
}

/**
 * PyYAML's implicit scalar rules, where they are narrower than the `yaml` package's 1.1 schema:
 * `y`/`n` stay strings, a float needs a dot and a signed exponent (`1e5` is a string), and a
 * decimal int has no leading zero. Each regex accepts a subset of the one it replaces, so the
 * package's own resolvers still apply.
 */
const PYYAML_TESTS: ReadonlyMap<string, RegExp> = new Map([
  [
    /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/.source,
    /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/,
  ],
  [
    /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/.source,
    /^(?:no|No|NO|false|False|FALSE|off|Off|OFF)$/,
  ],
  [
    /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/.source,
    /^[-+]?(?:[0-9][0-9_]*\.[0-9_]*|\.[0-9_]+)[eE][-+][0-9]+$/,
  ],
  [/^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/.source, /^[-+]?(?:[0-9][0-9_]*\.[0-9_]*|\.[0-9_]+)$/],
  [/^[-+]?[0-9][0-9_]*$/.source, /^[-+]?(?:0|[1-9][0-9_]*)$/],
  [/^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/.source, /^[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+$/],
]);

export const YAML_OPTIONS: ParseOptions & DocumentOptions & SchemaOptions = {
  version   : '1.1',
  customTags: (tags: Tags): Tags =>
    tags.map((t) => {
      if (typeof t === 'string' || 'collection' in t || t.test === undefined) return t;
      const replacement = PYYAML_TESTS.get(t.test.source);
      return replacement === undefined ? t : { ...t, test: replacement };
    }),
};

export function loadContent(root: string): Content {
  const docs = contentFiles(root).map((rel) => {
    const doc: unknown = parseYaml(fs.readFileSync(path.join(root, rel), 'utf8'), YAML_OPTIONS);
    return [rel, doc] as const;
  });
  return loadDocs(docs);
}
