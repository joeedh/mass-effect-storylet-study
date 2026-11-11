/** Build the interactive HTML atlas of the derived storylet graph (`storylet atlas`). */
import fs from 'node:fs';
import path from 'node:path';
import { Engine, coverage } from './engine.ts';
import { show } from './expr.ts';
import { build } from './graph.ts';
import { isPlotVar } from './model.ts';
import type { Content } from './model.ts';
import * as py from './pycompat.ts';

const TEMPLATE = new URL('./atlas_template.html', import.meta.url);

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function atlasData(content: Content, runs = 450, seed = 3, maxWriters = 10) {
  const engine = new Engine(content);
  const s0 = engine.initial();
  const starts = ['me1', 'me2', 'me3'].map((ch) => engine.fire(s0, 'campaign.start', ch));
  const { traces } = coverage(engine, runs, seed, starts);
  const pos = new Map<string, number[]>();
  for (const t of traces) {
    // x = typical position within its own game's playthrough
    const byGame = new Map<string, string[]>();
    for (const st of t.steps) {
      const game = content.storylets.get(st.storylet)?.game ?? '';
      let ids = byGame.get(game);
      if (ids === undefined) byGame.set(game, (ids = []));
      ids.push(st.storylet);
    }
    for (const ids of byGame.values()) {
      ids.forEach((sid, i) => {
        let p = pos.get(sid);
        if (p === undefined) pos.set(sid, (p = []));
        p.push(i / Math.max(1, ids.length - 1));
      });
    }
  }
  const pairs = new Map<string, { s: string; d: string; v: Set<string> }>();
  for (const e of build(content, maxWriters)) {
    const k = JSON.stringify([e.src, e.dst]);
    let p = pairs.get(k);
    if (p === undefined) pairs.set(k, (p = { s: e.src, d: e.dst, v: new Set() }));
    p.v.add(e.via);
  }
  const nodes = [...content.storylets.values()].map((s) => {
    const p = pos.get(s.id) ?? [];
    return {
      id  : s.id,
      t   : s.title,
      g   : s.game || 'campaign',
      a   : s.area,
      tr  : s.trigger,
      k   : s.kind,
      sum : s.summary,
      req : show(s.requires),
      eff : s.effects.map((x) => x.src),
      ch: s.choices.map((c) => ({
        id : c.id,
        l  : c.label,
        req: show(c.requires),
        eff: c.effects.map((y) => y.src),
      })),
      oc  : s.outcomes.map((o) => ({ id: o.id, w: show(o.when) })),
      lim : s.limit === null ? null : show(s.limit),
      tags: s.tags,
      ev  : s.evidence,
      n   : s.notes,
      x   : p.length ? py.round(median(p), 3) : 0,
    };
  });
  const plot = [...content.vars.values()].filter(isPlotVar).length;
  return {
    nodes,
    edges: [...pairs.values()].map(({ s, d, v }) => ({ s, d, v: [...v].sort() })),
    stats: {
      storylets: nodes.length,
      plotvars : plot,
      storyvars: content.vars.size - plot,
      lifted: [...content.conditions.values()].filter((c) => c.ref !== null && c.ref !== '').length,
      edges    : pairs.size,
    },
  };
}

export function buildAtlas(content: Content, out: string): string {
  const data = JSON.stringify(atlasData(content)).replaceAll('</', '<\\/');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  fs.writeFileSync(
    out,
    template.replace('/*DATA*/', () => data),
    'utf8',
  );
  return out;
}
