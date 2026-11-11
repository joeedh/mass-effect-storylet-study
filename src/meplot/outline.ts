/** Porting worksheets: a readable dump of one region/plot subtree with refs, conditions and writes. */
import type { Catalog, Element } from './catalog.ts';
import * as py from '../storylet/pycompat.ts';
import { inferTransitionTarget } from './graph.ts';

const ICON: Readonly<Record<string, string>> = {
  Region     : '▣',
  Plot       : '▸',
  FlagGroup  : '◇',
  Flag       : '·',
  State      : '●',
  SubState   : '○',
  Conditional: '?',
  Consequence: '⇒',
  Transition : '→',
  JournalGoal: 'J',
  JournalTask: 'j',
  JournalItem: 'i',
  Integer    : '#',
  Float      : '~',
  Category   : '▸',
};

/** A Python f-string of an optional string: `None` when absent. */
function fmt(v: string | null): string {
  return v ?? 'None';
}

export function writersIndex(cat: Catalog, db: string): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const el of cat.dbs.get(db)!.elements.values()) {
    if (el.kind !== 'trans') continue;
    const hit = inferTransitionTarget(cat, el);
    if (hit === null) continue;
    const entry = `${el.ref}=${py.nonEmpty(hit.value) ? hit.value : '?'}`;
    const list = idx.get(hit.state.canonical);
    if (list === undefined) idx.set(hit.state.canonical, [entry]);
    else list.push(entry);
  }
  return idx;
}

export function outline(cat: Catalog, root: Element, maxDepth = 99, skipFlags = false): string {
  const db = cat.dbs.get(root.db)!;
  const writers = writersIndex(cat, root.db);
  const lines = [`# ${root.db}:${root.path || root.label}  (${root.ref})`, ''];

  const walk = (el: Element, depth: number): void => {
    if (depth > maxDepth) return;
    if (skipFlags && el.typeName === 'Flag' && !el.children.length) return;
    const ref = el.canonical !== el.ref ? el.canonical : el.ref;
    let note = '';
    const written = writers.get(el.canonical);
    if (el.kind === 'cond') {
      note = `  := ${fmt(cat.conditionCode(el))}`;
    } else if (el.kind === 'trans') {
      const hit = inferTransitionTarget(cat, el);
      note = hit
        ? `  sets ${hit.state.canonical}=${fmt(hit.value)} [${hit.confidence}]`
        : `  arg=${fmt(el.argument)}`;
    } else if (el.isState && written !== undefined && written.length > 0) {
      note = `  ← ${written.slice(0, 4).join(', ')}`;
    }
    const alias = el.canonical !== el.ref ? ` (alias of ${el.canonical})` : '';
    lines.push(
      `${'  '.repeat(depth)}${ICON[el.typeName] ?? '?'} ${el.label}  \`${ref}\`${alias}${note}`,
    );
    for (const c of el.children) walk(db.elements.get(c)!, depth + 1);
  };

  walk(root, 0);
  return lines.join('\n') + '\n';
}
