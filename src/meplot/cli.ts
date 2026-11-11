/**
 * meplot: extract and inspect the Mass Effect trilogy plot databases.
 *
 *     meplot fetch                     download the pinned plot databases into build/plotdb
 *     meplot build                     write build/catalog.json, build/plotgraph.json, build/outlines/
 *     meplot find me1 'Virmire.*Kaidan' [--type State]
 *     meplot show me1.bool.3828        one element (+ aliases in later games)
 *     meplot resolve 'me1:CH2_Virmire.The_Choice.Rescued_Kaidan'
 *     meplot outline 'me1:CH2_Virmire.The_Choice'
 *     meplot bind NAME=SPEC ...        print storylet `vars:`/`conditions:` YAML for plot elements
 *                                      (SPEC is a ref or a path; conditionals are lifted with their code)
 */
import fs from 'node:fs';
import path from 'node:path';
import { Argument } from 'commander';
import { BUILD, PLOTDB, collect, int, program, runCli } from '../cli-common.ts';
import * as py from '../storylet/pycompat.ts';
import { loadCatalog } from './catalog.ts';
import type { Catalog, Element } from './catalog.ts';
import { fetchPlotDb, haveDatabases } from './fetch.ts';
import { graphJson } from './graph.ts';
import { outline } from './outline.ts';

/** The catalog, fetching the plot databases first if they are missing. */
export async function getCatalog(plotdb: string = PLOTDB): Promise<Catalog> {
  if (!haveDatabases(plotdb)) await fetchPlotDb(plotdb);
  return loadCatalog(plotdb);
}

function fmt(cat: Catalog, el: Element): string {
  let extra = '';
  if (el.kind === 'cond') extra = `  := ${cat.conditionCode(el) ?? 'None'}`;
  else if (el.argument !== null) extra = `  arg=${el.argument}`;
  const canon = el.canonical !== el.ref ? ` -> ${el.canonical}` : '';
  return `${el.ref.padEnd(18)}${canon} ${el.typeName.padEnd(12)} ${el.db}:${el.path}${extra}`;
}

/** A Python dict repr of string -> number, as `meplot build` printed its stats. */
function dictRepr(d: Readonly<Record<string, number>>): string {
  return `{${Object.entries(d)
    .map(([k, v]) => `${py.repr(k)}: ${v}`)
    .join(', ')}}`;
}

function lookup(cat: Catalog, spec: string): Element[] {
  if (spec.includes(':')) return cat.resolvePath(spec);
  const el = cat.get(spec);
  return el === undefined ? [] : [el];
}

function build() {
  const cli = program('meplot', 'Extract and inspect the Mass Effect trilogy plot databases.');

  cli
    .command('fetch')
    .option('--force', 'download even if the databases are present')
    .action(async (o: { force?: true }) => {
      for (const p of await fetchPlotDb(PLOTDB, o.force === true)) console.log(p);
    });

  cli.command('build').action(async () => {
    const cat = await getCatalog();
    fs.mkdirSync(BUILD, { recursive: true });
    fs.writeFileSync(path.join(BUILD, 'catalog.json'), JSON.stringify(cat.toJson()), 'utf8');
    const g = graphJson(cat);
    fs.writeFileSync(path.join(BUILD, 'plotgraph.json'), JSON.stringify(g), 'utf8');
    let n = 0;
    for (const db of cat.dbs.values()) {
      for (const root of db.roots()) {
        for (const rid of root.children) {
          const region = db.elements.get(rid)!;
          const dir = path.join(BUILD, 'outlines', db.db);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${region.label}.md`), outline(cat, region), 'utf8');
          n++;
        }
      }
    }
    fs.writeFileSync(path.join(BUILD, 'anomalies.txt'), cat.anomalies.join('\n') + '\n', 'utf8');
    const elements = [...cat.dbs.values()].reduce((sum, d) => sum + d.elements.size, 0);
    console.log(
      `catalog: ${elements} elements; graph: ${g.edges.length} edges ${dictRepr(g.stats)}; outlines: ${n}; anomalies: ${cat.anomalies.length}`,
    );
  });

  cli
    .command('find')
    .addArgument(new Argument('<game>').choices(['me1', 'me2', 'me3', 'any']))
    .argument('<pattern>', 'a regular expression matched against element paths')
    .option(
      '--type <type>',
      'element type or kind filter (State, bool, Conditional, ...)',
      collect,
      [],
    )
    .option('--native', 'hide LE3 import-region aliases')
    .action(async (game: string, pattern: string, o: { type: string[]; native?: true }) => {
      const cat = await getCatalog();
      let hits = cat.search(game === 'any' ? null : game, pattern, o.type);
      if (o.native) hits = hits.filter((h) => h.importRegion === null);
      for (const el of hits) console.log(fmt(cat, el));
      process.exitCode = hits.length ? 0 : 1;
    });

  cli
    .command('show')
    .argument('<ref>')
    .action(async (ref: string) => {
      const cat = await getCatalog();
      const el = cat.get(ref);
      if (el === undefined) {
        console.error(`unknown ref ${ref}`);
        process.exitCode = 1;
        return;
      }
      console.log(fmt(cat, el));
      for (const al of cat.aliases.get(el.canonical) ?? []) console.log('  alias: ' + fmt(cat, al));
    });

  cli
    .command('resolve')
    .argument('<spec>')
    .action(async (spec: string) => {
      const cat = await getCatalog();
      const hits = cat.resolvePath(spec);
      for (const el of hits) console.log(fmt(cat, el));
      if (hits.length > 1) console.error('ambiguous: append #<plotid> to disambiguate');
      process.exitCode = hits.length === 1 ? 0 : 1;
    });

  cli
    .command('outline')
    .argument('<spec>')
    .option('--depth <n>', 'maximum depth', int, 99)
    .option('--no-flags', 'omit leaf conversation flags')
    .action(async (spec: string, o: { depth: number; flags: boolean }) => {
      const cat = await getCatalog();
      const hits = lookup(cat, spec);
      if (!hits.length) {
        console.error('not found');
        process.exitCode = 1;
        return;
      }
      for (const h of hits) console.log(outline(cat, h, o.depth, !o.flags));
    });

  cli
    .command('bind')
    .argument('<pairs...>', 'NAME=SPEC')
    .action(async (pairs: string[]) => {
      const cat = await getCatalog();
      const varsOut: string[] = [];
      const condsOut: string[] = [];
      let rc = 0;
      for (const pair of pairs) {
        const i = pair.indexOf('=');
        const [name, spec] = i < 0 ? [pair, ''] : [pair.slice(0, i), pair.slice(i + 1)];
        const hits = lookup(cat, spec);
        if (hits.length !== 1) {
          console.error(`# ${name}: ${spec} -> ${hits.length} matches`);
          rc = 1;
          continue;
        }
        const el = hits[0]!;
        const canon = cat.get(el.canonical) ?? el;
        if (el.kind === 'cond') {
          condsOut.push(
            `  ${name}:\n    ref: ${el.ref}\n    path: "${el.db}:${el.path}"\n    code: "${cat.conditionCode(el) ?? 'None'}"`,
          );
        } else if (el.isState) {
          varsOut.push(`  ${name}: {ref: ${canon.ref}, path: "${canon.db}:${canon.path}"}`);
        } else {
          console.error(`# ${name}: ${el.ref} is a ${el.typeName}, not bindable`);
          rc = 1;
        }
      }
      if (condsOut.length) console.log('conditions:\n' + condsOut.join('\n'));
      if (varsOut.length) console.log('vars:\n' + varsOut.join('\n'));
      process.exitCode = rc;
    });

  return cli;
}

if (import.meta.main) await runCli(build(), process.argv.slice(2));
