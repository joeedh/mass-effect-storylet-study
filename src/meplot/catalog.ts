/**
 * Normalize the three BioWare plot databases into one cross-game catalog.
 *
 * Identity model
 * --------------
 * Every in-game plot element gets a *local ref* `<db>.<kind>.<plotid>` (e.g. `me1.bool.3828`),
 * where `db` is the database it was read from. Elements that are not runtime state (regions,
 * plots, flag groups, journal entries) get `<db>.node.<elementid>`.
 *
 * The trilogy carries plot tables forward between games, which the databases make visible:
 *
 * - LE3's `ME2_Plots_for_ME3` region is the ME2 plot table, at the *same* plot ids.
 * - LE3's `ME1_Plots_for_ME3` region is the ME1 plot table at plot id `+10000`
 *   (element ids `+25000`).
 *
 * Such elements are aliases: their *canonical ref* is the ref in the game that owns the variable
 * (`me3.bool.13828` -> `me1.bool.3828`). A storylet that reads ME1 state from ME3 therefore reads
 * the same variable that the ME1 storylet wrote.
 *
 * LE2's `ME1_Plots_for_ME2` region is different: those are ME2-native variables populated by the
 * save importer, so they stay `me2.*` and must be bridged explicitly by content.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as py from '../storylet/pycompat.ts';

export const DB_NAMES: ReadonlyMap<string, string> = new Map([
  ['le1', 'me1'],
  ['le2', 'me2'],
  ['le3', 'me3'],
]);

const TYPE_NAMES: ReadonlyMap<number, string> = new Map([
  [-1, 'None'],
  [1, 'Region'],
  [2, 'Plot'],
  [3, 'FlagGroup'],
  [4, 'Flag'],
  [5, 'State'],
  [6, 'SubState'],
  [7, 'Conditional'],
  [8, 'Consequence'],
  [9, 'Transition'],
  [10, 'JournalGoal'],
  [11, 'JournalTask'],
  [12, 'JournalItem'],
  [13, 'Integer'],
  [14, 'Float'],
  [15, 'Mod'],
  [16, 'Category'],
]);
const SECTION_KIND: ReadonlyMap<string, string> = new Map([
  ['bools', 'bool'],
  ['ints', 'int'],
  ['floats', 'float'],
  ['conditionals', 'cond'],
  ['transitions', 'trans'],
]);
const STATE_KINDS: ReadonlySet<string> = new Set(['bool', 'int', 'float']);
const JOURNAL_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

// Import regions inside LE3 (see the module comment): source game, plot id offset, element id offset.
const LE3_IMPORT_REGIONS: ReadonlyMap<string, readonly [string, number, number]> = new Map([
  ['ME1_Plots_for_ME3', ['me1', 10000, 25000]],
  ['ME2_Plots_for_ME3', ['me2', 0, 0]],
]);

const PE_RE = /PE\{(\d+)\}/g;
const REF_RE = /^(me[123])\.(bool|int|float|cond|trans|node)\.(\d+)$/;

export class Element {
  readonly db: string;
  readonly eid: number;
  readonly pid: number;
  readonly type: number;
  readonly label: string;
  readonly parentEid: number;
  readonly section: string;
  readonly sequence: number;
  readonly subtype: number | null;
  readonly code: string | null;
  readonly argument: string | null;
  path = '';
  ref = '';
  canonical = '';
  importRegion: string | null = null;
  readonly children: number[] = [];

  constructor(
    init: Pick<
      Element,
      | 'db'
      | 'eid'
      | 'pid'
      | 'type'
      | 'label'
      | 'parentEid'
      | 'section'
      | 'sequence'
      | 'subtype'
      | 'code'
      | 'argument'
    >,
  ) {
    this.db = init.db;
    this.eid = init.eid;
    this.pid = init.pid;
    this.type = init.type;
    this.label = init.label;
    this.parentEid = init.parentEid;
    this.section = init.section;
    this.sequence = init.sequence;
    this.subtype = init.subtype;
    this.code = init.code;
    this.argument = init.argument;
  }

  get typeName(): string {
    return TYPE_NAMES.get(this.type) ?? String(this.type);
  }

  get kind(): string {
    return this.ref.split('.')[1] ?? '';
  }

  get isState(): boolean {
    return STATE_KINDS.has(this.kind);
  }

  get isJournal(): boolean {
    return JOURNAL_TYPES.has(this.type);
  }

  toJson(): Record<string, string | number> {
    const d: Record<string, string | number> = {
      ref   : this.ref,
      eid   : this.eid,
      pid   : this.pid,
      type  : this.typeName,
      label : this.label,
      path  : this.path,
      parent: this.parentEid,
    };
    if (this.canonical !== this.ref) d['canonical'] = this.canonical;
    if (py.nonEmpty(this.importRegion)) d['import_region'] = this.importRegion;
    if (this.subtype !== null) d['subtype'] = this.subtype;
    if (this.code !== null) d['code'] = this.code;
    if (this.argument !== null) d['argument'] = this.argument;
    return d;
  }
}

/** Python's `int(v)` on a JSON value: numbers truncate, integer strings parse. */
function int(v: unknown, field: string): number {
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return py.toInt(v);
  throw new TypeError(`${field}: expected an integer, got ${JSON.stringify(v)}`);
}

/**
 * A sibling sort key. Keep the fraction: the editor inserts by halving the gap to 200, so
 * siblings differ only after the decimal point (see docs/debugging.md).
 */
function sequenceOf(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return py.toFloat(v);
  throw new TypeError(`sequence: unexpected ${JSON.stringify(v)}`);
}

type RawElement = Record<string, unknown>;

/** Python's `v or 0` on a JSON value. */
function orZero(v: unknown): unknown {
  return v === null || v === undefined || v === '' || v === 0 || v === false ? 0 : v;
}

/** One plot database (LE1, LE2 or LE3). */
export class GameDB {
  readonly db: string;
  readonly elements = new Map<number, Element>();

  constructor(db: string, raw: Readonly<Record<string, readonly RawElement[]>>) {
    this.db = db;
    for (const [section, items] of Object.entries(raw)) {
      for (const e of items) {
        const el = new Element({
          db,
          eid      : int(e['elementid'], 'elementid'),
          pid      : int(e['plotid'] ?? -1, 'plotid'),
          type     : int(e['type'], 'type'),
          label    : typeof e['label'] === 'string' ? e['label'] : '',
          parentEid: int(orZero(e['parentelementid']), 'parentelementid'),
          section,
          sequence: sequenceOf(e['sequence']),
          subtype:
            e['subtype'] === null || e['subtype'] === undefined
              ? null
              : int(e['subtype'], 'subtype'),
          code    : typeof e['code'] === 'string' ? e['code'] : null,
          argument:
            e['argument'] === null || e['argument'] === undefined ? null : String(e['argument']),
        });
        this.elements.set(el.eid, el);
      }
    }
    for (const el of this.elements.values()) this.elements.get(el.parentEid)?.children.push(el.eid);
    for (const el of this.elements.values()) {
      el.children.sort((a, b) =>
        py.cmpTuple([this.elements.get(a)!.sequence, a], [this.elements.get(b)!.sequence, b]),
      );
      el.path = this.pathOf(el);
      const kind = SECTION_KIND.get(el.section);
      el.ref =
        kind !== undefined && el.pid >= 0 ? `${db}.${kind}.${el.pid}` : `${db}.node.${el.eid}`;
      el.canonical = el.ref;
    }
  }

  private pathOf(el: Element): string {
    const parts: string[] = [];
    const seen = new Set<number>();
    let cur: Element | undefined = el;
    while (cur !== undefined && cur.parentEid > 0 && !seen.has(cur.eid)) {
      seen.add(cur.eid);
      parts.push(cur.label);
      cur = this.elements.get(cur.parentEid);
    }
    return parts.reverse().join('.');
  }

  roots(): Element[] {
    return [...this.elements.values()].filter((e) => e.parentEid === 0);
  }

  *descendants(eid: number): Generator<Element> {
    const stack = [...this.elements.get(eid)!.children].reverse();
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      const el = this.elements.get(id)!;
      yield el;
      stack.push(...[...el.children].reverse());
    }
  }

  /** Top-level region (child of the database root) containing `el`. */
  regionOf(el: Element): Element {
    let cur = el;
    for (;;) {
      const parent = this.elements.get(cur.parentEid);
      if (parent === undefined || parent.parentEid === 0) return cur;
      cur = parent;
    }
  }
}

/** All three databases plus cross-game alias resolution and path lookup. */
export class Catalog {
  readonly dbs: ReadonlyMap<string, GameDB>;
  readonly byRef = new Map<string, Element>();
  /** canonical ref -> the elements in later games that alias it */
  readonly aliases = new Map<string, Element[]>();
  readonly anomalies: string[] = [];
  private readonly pathIndex = new Map<string, Element[]>();

  constructor(dbs: ReadonlyMap<string, GameDB>) {
    this.dbs = dbs;
    for (const db of dbs.values()) {
      for (const el of db.elements.values()) {
        const other = this.byRef.get(el.ref);
        if (other !== undefined) {
          this.anomalies.push(
            `duplicate ref ${el.ref}: ${py.repr(other.path)} vs ${py.repr(el.path)}`,
          );
          continue;
        }
        this.byRef.set(el.ref, el);
      }
    }
    const me3 = dbs.get('me3');
    if (me3 !== undefined) this.linkLe3Imports(me3);
    for (const db of dbs.values()) {
      for (const el of db.elements.values()) {
        const k = Catalog.pathKey(db.db, el.path);
        const list = this.pathIndex.get(k);
        if (list === undefined) this.pathIndex.set(k, [el]);
        else list.push(el);
      }
    }
  }

  private static pathKey(game: string, p: string): string {
    return `${game}\u0000${p}`;
  }

  // -- construction -------------------------------------------------------------------------------
  private linkLe3Imports(me3: GameDB): void {
    for (const root of me3.roots()) {
      for (const regionEid of root.children) {
        const region = me3.elements.get(regionEid)!;
        const spec = LE3_IMPORT_REGIONS.get(region.label);
        if (spec === undefined) continue;
        const [srcGame, pidOff, eidOff] = spec;
        const src = this.dbs.get(srcGame);
        for (const el of [region, ...me3.descendants(regionEid)]) {
          el.importRegion = region.label;
          if (src === undefined) continue;
          let target: string;
          if (el.isState) target = `${srcGame}.${el.kind}.${el.pid - pidOff}`;
          else if (el.kind === 'node') target = `${srcGame}.node.${el.eid - eidOff}`;
          else continue; // conditionals/transitions stay ME3 functions
          const tgt = this.byRef.get(target);
          if (tgt === undefined || tgt.label !== el.label) {
            if (el.isState) {
              this.anomalies.push(
                `${el.ref} (${el.path}) in ${region.label}: no matching ${target}` +
                  (tgt ? ` (found label ${py.repr(tgt.label)})` : ''),
              );
            }
            continue;
          }
          el.canonical = target;
          const list = this.aliases.get(target);
          if (list === undefined) this.aliases.set(target, [el]);
          else list.push(el);
        }
      }
    }
  }

  // -- lookup -------------------------------------------------------------------------------------
  get(ref: string): Element | undefined {
    return this.byRef.get(ref);
  }

  canonical(ref: string): string {
    return this.byRef.get(ref)?.canonical ?? ref;
  }

  /** Resolve `me1:CH2_Virmire.The_Choice.Rescued_Kaidan` (optionally `#<plotid>`). */
  resolvePath(spec: string): Element[] {
    const [game, rest] = partition(spec, ':');
    let p = rest;
    let pid: number | null = null;
    if (p.includes('#')) {
      const [before, pidS] = partition(p, '#');
      p = before;
      pid = py.toInt(pidS);
    }
    const hits = this.pathIndex.get(Catalog.pathKey(game, p)) ?? [];
    return pid === null ? [...hits] : hits.filter((h) => h.pid === pid);
  }

  search(game: string | null, pattern: string, types: readonly string[] | null = null): Element[] {
    const rx = new RegExp(pattern, 'i');
    const tset = types !== null && types.length > 0 ? new Set(types) : null;
    const out: Element[] = [];
    for (const db of this.dbs.values()) {
      if (py.nonEmpty(game) && db.db !== game) continue;
      for (const el of db.elements.values()) {
        if (tset && !tset.has(el.typeName) && !tset.has(el.kind)) continue;
        if (rx.test(el.path)) out.push(el);
      }
    }
    return py.sortedBy(out, (e) => [e.db, e.path]);
  }

  /** Conditional code with `PE{eid}` rewritten to canonical refs. */
  conditionCode(el: Element): string | null {
    if (el.code === null) return null;
    const db = this.dbs.get(el.db)!;
    const code = el.code.replace(
      PE_RE,
      (_m, eid: string) => db.elements.get(Number(eid))?.canonical ?? `?${el.db}.eid.${eid}`,
    );
    return py.squash(code);
  }

  toJson(): Record<string, Record<string, string | number | null>[]> {
    const out: Record<string, Record<string, string | number | null>[]> = {};
    for (const [name, db] of this.dbs) {
      out[name] = py
        .sortedBy(db.elements.values(), (e) => [e.eid])
        .map((el) => {
          const d: Record<string, string | number | null> = el.toJson();
          if (el.code !== null) d['code_canonical'] = this.conditionCode(el);
          return d;
        });
    }
    return out;
  }
}

/** Python's `str.partition(sep)`, without the separator. */
function partition(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + sep.length)];
}

export function loadCatalog(plotdbDir: string): Catalog {
  const dbs = new Map<string, GameDB>();
  for (const [fname, game] of DB_NAMES) {
    const file = path.join(plotdbDir, `${fname}.json`);
    if (!fs.existsSync(file)) throw new Error(`${file} missing; run \`meplot fetch\` first`);
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // utf-8-sig
    dbs.set(game, new GameDB(game, JSON.parse(text) as Record<string, RawElement[]>));
  }
  return new Catalog(dbs);
}

export function parseRef(ref: string): [string, string, number] | null {
  const m = REF_RE.exec(ref);
  return m ? [m[1]!, m[2]!, Number(m[3])] : null;
}
