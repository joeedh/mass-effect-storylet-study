/**
 * Porting progress: how much of each game's extracted plot structure the storylets bind to.
 *
 * What counts as a *quest plot* follows each game's own organization:
 *
 * - ME1: Plot nodes that directly own journal entries (JournalGoal); ME1 files quests that way.
 * - ME2: the mission plots under the mission regions (Act_1-3, Acquisition/Legacy/Loyalty/N7
 *   missions); ME2 keeps its journal in Global.Journals.
 * - ME3: plots named by a mission code in Global.Game_Progress.Mission_Completion_Order (Kro002,
 *   Gth001, ...); ME3 keeps journals in Global.Critpath_Journals/Side_Journals.
 *
 * A quest plot is *bound* when a storylet variable or evidence entry points into its subtree.
 */
import type { Catalog, Element } from '../meplot/catalog.ts';
import { isPlotVar } from './model.ts';
import type { Content } from './model.ts';
import * as py from './pycompat.ts';

const ME2_MISSION_REGIONS = new Set([
  'Act_1',
  'Act_2',
  'Act_3',
  'Acquisition_Missions',
  'Legacy_Missions',
  'Loyalty_Missions',
  'N7_Missions',
]);

export interface PlotCoverage {
  readonly game: string;
  readonly ref: string;
  readonly path: string;
  readonly goals: readonly string[];
  readonly boundBy: ReadonlySet<string>;
}

/** Every Plot ancestor (in the owning game's DB) of the element with `ref`. */
function ownerPlots(catalog: Catalog, ref: string): Element[] {
  const el = catalog.get(ref);
  if (el === undefined) return [];
  const db = catalog.dbs.get(el.db)!;
  const out: Element[] = [];
  for (let cur: Element | undefined = el; cur !== undefined; cur = db.elements.get(cur.parentEid)) {
    if (cur.typeName === 'Plot') out.push(cur);
  }
  return out;
}

export function questCoverage(content: Content, catalog: Catalog): Map<string, PlotCoverage[]> {
  const touched = new Map<string, Set<string>>(); // plot ref -> storylets/vars touching it
  const touch = (ref: string, by: string): void => {
    let s = touched.get(ref);
    if (s === undefined) touched.set(ref, (s = new Set()));
    s.add(by);
  };
  for (const decl of content.vars.values()) {
    if (isPlotVar(decl)) {
      for (const p of ownerPlots(catalog, decl.ref)) touch(p.ref, `var:${decl.name}`);
    }
  }
  for (const st of content.storylets.values()) {
    for (const ev of st.evidence) {
      const els = ev.includes(':') ? catalog.resolvePath(ev) : [catalog.get(ev)];
      for (const el of els) {
        if (el === undefined) continue;
        for (const p of [
          ...ownerPlots(catalog, el.canonical),
          ...(el.typeName === 'Plot' ? [el] : []),
        ]) {
          touch(p.ref, st.id);
        }
      }
    }
  }
  let me3Codes = new Set<string>();
  const me3 = catalog.dbs.get('me3');
  if (me3 !== undefined) {
    for (const el of catalog.resolvePath('me3:Global.Game_Progress.Mission_Completion_Order')) {
      me3Codes = new Set(el.children.map((c) => me3.elements.get(c)!.label));
    }
  }
  const out = new Map<string, PlotCoverage[]>();
  for (const [game, db] of catalog.dbs) {
    const rows: PlotCoverage[] = [];
    for (const el of db.elements.values()) {
      if (el.typeName !== 'Plot' || el.importRegion !== null) continue;
      const goals = el.children
        .map((c) => db.elements.get(c)!)
        .filter((c) => c.typeName === 'JournalGoal')
        .map((c) => c.label);
      const region = db.regionOf(el);
      if (game === 'me2') {
        const parent = db.elements.get(el.parentEid);
        if (!(parent === region && ME2_MISSION_REGIONS.has(region.label))) continue;
      } else if (game === 'me3') {
        if (!me3Codes.has(el.label) || el.label.startsWith('MP')) continue;
      } else if (!goals.length) {
        continue;
      }
      if (['TEST', 'DELETED', 'DEBUG', 'SANDBOX'].some((t) => el.path.toUpperCase().includes(t))) {
        continue;
      }
      rows.push({
        game,
        ref : el.ref,
        path: el.path,
        goals,
        boundBy: touched.get(el.ref) ?? new Set(),
      });
    }
    out.set(
      game,
      py.sortedBy(rows, (r) => [r.path]),
    );
  }
  return out;
}

export function coverageMarkdown(cov: ReadonlyMap<string, readonly PlotCoverage[]>): string {
  const lines = ['# Porting coverage (quest plots bound by storylets)', ''];
  for (const [game, rows] of cov) {
    const bound = rows.filter((r) => r.boundBy.size).length;
    lines.push(`## ${game}: ${bound}/${rows.length} quest plots bound`, '');
    for (const r of rows) {
      const mark = r.boundBy.size ? 'x' : ' ';
      const extra = r.goals.length ? ` (${r.goals.length} journal goals)` : '';
      lines.push(`- [${mark}] \`${r.path}\`${extra}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
