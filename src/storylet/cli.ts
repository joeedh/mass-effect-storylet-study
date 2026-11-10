/**
 * storylet: validate, simulate and graph the trilogy storylet content.
 *
 *     storylet validate [--no-catalog] [--runs N]
 *     storylet simulate [--seed S] [--set name=value ...] [--choose storylet=choice ...]
 *     storylet explore [--max-states N]
 *     storylet graph [--format dot|mermaid|json] [--game me1] [-o FILE]
 *     storylet coverage [-o FILE]
 *     storylet available [--set ...]           what could fire from a given state
 *     storylet atlas [-o build/atlas.html]     interactive HTML map of the derived graph
 *     storylet outcomes [--runs N] [--start me1|me2|me3] [--expr EXPR ...]
 *                                              distribution of end-of-campaign values
 */
import fs from "node:fs";
import path from "node:path";
import { Option as CliOption } from "commander";
import type { Command } from "commander";
import { BUILD, CONTENT, collect, int, program, runCli, userPath } from "../cli-common.ts";
import type { Catalog } from "../meplot/catalog.ts";
import { getCatalog } from "../meplot/cli.ts";
import { buildAtlas } from "./atlas.ts";
import { Engine, coverage } from "./engine.ts";
import type { Policy } from "./engine.ts";
import { parse } from "./expr.ts";
import * as graph from "./graph.ts";
import { loadContent } from "./loader.ts";
import type { Content } from "./model.ts";
import { coverageMarkdown, questCoverage } from "./porting.ts";
import { PyRandom } from "./pyrandom.ts";
import * as py from "./pycompat.ts";
import type { Value } from "./pycompat.ts";
import { validate } from "./validate.ts";

const DEFAULT_OUTCOMES: readonly (readonly [string, string])[] = [
  ["career reached", "me3.end.made_final_decision ? 'ME3 ending' : (story.me3.refused ? 'refused' : (story.me2.shepard_dead ? 'died in ME2' : 'incomplete'))"],
  ["ending", "me3.end.chose_red ? 'destroy' : (me3.end.chose_blue ? 'control' : (me3.end.chose_green ? 'synthesis' : (story.me3.refused ? 'refuse' : '-')))"],
  ["EMS band", "me3.ems.current_rating < 1750 ? '<1750' : (me3.ems.current_rating < 2350 ? '1750-2349' : (me3.ems.current_rating < 2800 ? '2350-2799' : (me3.ems.current_rating < 4000 ? '2800-3999' : '>=4000')))"],
  ["Earth", "me3.end.earth_ok ? 'ok' : (me3.end.earth_devastated ? 'devastated' : (me3.end.earth_destroyed ? 'destroyed' : '-'))"],
  ["Shepard survives", "me3.end.shepard_alive"],
  ["genophage", "me3.genophage.cure_real ? 'cured' : (me3.genophage.cure_sabotaged ? 'sabotaged' : '-')"],
  ["Rannoch", "me3.rannoch.peace ? 'peace' : (me3.rannoch.quarians_dead ? 'geth won' : (me3.rannoch.geth_destroyed ? 'quarians won' : '-'))"],
  ["Wrex dead by ME3", "me3.fate.wrex_dead"],
  ["Urdnot leader", "me3.genophage.wreav_leads ? 'Wreav' : 'Wrex'"],
  ["ME2 squad deaths", "count(me2.squad.miranda.dead, me2.squad.jacob.dead, me2.squad.jack.dead, me2.squad.legion.dead, me2.squad.kasumi.dead, me2.squad.garrus.dead, me2.squad.thane.dead, me2.squad.tali.dead, me2.squad.mordin.dead, me2.squad.grunt.dead, me2.squad.samara.dead, me2.squad.zaeed.dead)"],
];

async function catalogFor(required: boolean): Promise<Catalog | null> {
  try {
    return await getCatalog();
  } catch (e) {
    // network unavailable etc.
    if (required) throw e;
    console.error(`(plot catalog unavailable: ${e instanceof Error ? e.message : String(e)}; skipping binding checks)`);
    return null;
  }
}

function parseValue(v: string): Value {
  if (v === "true" || v === "false") return v === "true";
  if (/^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10);
  return py.toFloat(v);
}

function splitPair(s: string): [string, string] {
  const i = s.indexOf("=");
  if (i < 0) throw new Error(`expected NAME=VALUE, got '${s}'`);
  return [s.slice(0, i), s.slice(i + 1)];
}

function filterGame(content: Content, game: string | undefined): Content {
  return py.nonEmpty(game) ? content.filtered((st) => st.game === game) : content;
}

/** Load content, or report its errors and return null. */
function loaded(cmd: Command): Content | null {
  const content = loadContent(cmd.optsWithGlobals<{ content: string }>().content);
  if (!content.errors.length) return content;
  for (const e of content.errors) console.error("ERROR   " + e);
  process.exitCode = 1;
  return null;
}

/** Python's `Counter` key: `true`, `1` and `1.0` count as the same value. */
function counterKey(v: Value): string {
  return typeof v === "string" ? `s:${v}` : `n:${Number(v)}`;
}

function build(): Command {
  const cli = program("storylet", "Validate, simulate and graph the trilogy storylet content.");
  cli.option("--content <dir>", "content directory", (p) => userPath(p), CONTENT);

  cli
    .command("validate")
    .option("--no-catalog", "skip checks against the plot databases")
    .option("--runs <n>", "simulated playthroughs", int, 300)
    .option("-v, --verbose", "print info lines too")
    .action(async (o: { catalog: boolean; runs: number; verbose?: true }, cmd: Command) => {
      const content = loadContent(cmd.optsWithGlobals<{ content: string }>().content);
      const rep = validate(content, o.catalog ? await catalogFor(false) : null, o.runs);
      for (const e of rep.errors) console.log("ERROR   " + e);
      for (const w of rep.warnings) console.log("warning " + w);
      for (const i of rep.info) if (o.verbose || i.startsWith("simulated")) console.log("info    " + i);
      console.log(`${content.storylets.size} storylets, ${content.vars.size} vars: ${rep.errors.length} errors, ${rep.warnings.length} warnings`);
      process.exitCode = rep.ok ? 0 : 1;
    });

  for (const name of ["simulate", "available"] as const) {
    cli
      .command(name)
      .option("--seed <n>", "random seed", int)
      .option("--set <NAME=VALUE>", "override a variable in the starting state", collect, [])
      .option("--choose <STORYLET=CHOICE>", "force a choice whenever that storylet fires", collect, [])
      .option("--state", "print final state")
      .action((o: { seed?: number; set: string[]; choose: string[]; state?: true }, cmd: Command) => {
        const content = loaded(cmd);
        if (content === null) return;
        const engine = new Engine(content);
        const overrides = Object.fromEntries(o.set.map((s) => splitPair(s)).map(([k, v]) => [k, parseValue(v)]));
        const state = engine.initial(overrides);
        if (name === "available") {
          for (const st of engine.available(state)) {
            const cs = engine.choices(st, state).map((c) => c.id);
            console.log(`${st.trigger.padEnd(6)} ${st.id}  ${cs.length ? py.repr(cs) : ""}`);
          }
          return;
        }
        const forced = new Map(o.choose.map((s) => splitPair(s)));
        const rng = new PyRandom(o.seed);
        const policy: Policy = (_state, opts) => {
          for (const opt of opts) if (forced.get(opt[0].id) === opt[1]) return opt;
          const filtered = opts.filter(([s, c]) => !forced.has(s.id) || c === forced.get(s.id));
          return rng.choice(filtered.length ? filtered : opts);
        };
        const trace = engine.run(state, rng, undefined, policy);
        let curGame: string | null = null;
        trace.steps.forEach((step, i) => {
          const st = content.storylets.get(step.storylet)!;
          if ((st.game || "campaign") !== curGame) {
            curGame = st.game || "campaign";
            console.log(`=== ${curGame} ===`);
          }
          const ch = py.nonEmpty(step.choice) ? `  -> ${step.choice}` : "";
          console.log(`${String(i + 1).padStart(4)} ${st.title}${ch}`);
        });
        if (o.state) {
          for (const [ref, v] of trace.final.values) console.log(`  ${content.byRef.get(ref)?.name ?? ref} = ${py.str(v)}`);
        }
      });
  }

  cli
    .command("explore")
    .option("--max-states <n>", "stop after this many distinct states", int, 200_000)
    .option("--game <game>", "only this game's storylets")
    .action((o: { maxStates: number; game?: string }, cmd: Command) => {
      const content = loaded(cmd);
      if (content === null) return;
      const ex = new Engine(filterGame(content, o.game)).explore(undefined, o.maxStates);
      console.log(`states=${ex.states} terminals=${ex.terminals.size} fired=${ex.fired.size} choices=${ex.chosen.size} truncated=${ex.truncated}`);
    });

  cli
    .command("graph")
    .addOption(new CliOption("--format <format>").choices(["dot", "mermaid", "json"]).default("dot"))
    .option("--game <game>", "only this game's storylets")
    .option("-o, --output <file>", "write to a file instead of stdout", (p) => userPath(p))
    .option("--max-writers <n>", "drop edges via vars with more writers (e.g. 6)", int)
    .action((o: { format: "dot" | "mermaid" | "json"; game?: string; output?: string; maxWriters?: number }, cmd: Command) => {
      const content = loaded(cmd);
      if (content === null) return;
      const sub = filterGame(content, o.game);
      const edges = graph.build(sub, o.maxWriters ?? null);
      const render = { dot: graph.toDot, mermaid: graph.toMermaid, json: graph.toJson }[o.format];
      const text = render(sub, edges);
      if (o.output !== undefined) {
        fs.mkdirSync(path.dirname(o.output), { recursive: true });
        fs.writeFileSync(o.output, text, "utf8");
        console.log(`wrote ${o.output} (${sub.storylets.size} nodes, ${edges.length} edges)`);
      } else {
        process.stdout.write(text);
      }
    });

  cli
    .command("coverage")
    .option("-o, --output <file>", "write to a file instead of stdout", (p) => userPath(p))
    .action(async (o: { output?: string }, cmd: Command) => {
      const content = loaded(cmd);
      if (content === null) return;
      const md = coverageMarkdown(questCoverage(content, (await catalogFor(true))!));
      if (o.output !== undefined) {
        fs.writeFileSync(o.output, md, "utf8");
        console.log(`wrote ${o.output}`);
      } else {
        console.log(md);
      }
    });

  cli
    .command("atlas")
    .option("-o, --output <file>", "where to write the page", (p) => userPath(p), path.join(BUILD, "atlas.html"))
    .action((o: { output: string }, cmd: Command) => {
      const content = loaded(cmd);
      if (content === null) return;
      console.log(`wrote ${buildAtlas(content, o.output)}`);
    });

  cli
    .command("outcomes")
    .option("--runs <n>", "simulated playthroughs", int, 500)
    .option("--seed <n>", "random seed", int, 0)
    .addOption(new CliOption("--start <game>", "start the career in this game").choices(["me1", "me2", "me3"]))
    .option("--expr <expr>", "an expression to tabulate (repeatable)", collect, [])
    .option("--uniform", "uniform random choices instead of coverage-guided")
    .action((o: { runs: number; seed: number; start?: string; expr: string[]; uniform?: true }, cmd: Command) => {
      const content = loaded(cmd);
      if (content === null) return;
      const engine = new Engine(content);
      const exprs = o.expr.length ? o.expr.map((x) => [x, x] as const) : DEFAULT_OUTCOMES;
      let start = engine.initial();
      if (o.start !== undefined) start = engine.fire(start, "campaign.start", o.start);
      const { traces } = coverage(engine, o.runs, o.seed, [start], !o.uniform);
      for (const [label, src] of exprs) {
        const node = parse(src);
        const hist = new Map<string, { value: Value; n: number }>();
        for (const t of traces) {
          const v = engine.eval(node, t.final);
          const entry = hist.get(counterKey(v));
          if (entry === undefined) hist.set(counterKey(v), { value: v, n: 1 });
          else entry.n++;
        }
        console.log(`${label}:`);
        for (const { value, n } of py.sortedBy(hist.values(), (h) => [-h.n, py.str(h.value)])) {
          console.log(`  ${py.str(value).padEnd(14)} ${String(n).padStart(5)}  ${py.fixed((100 * n) / traces.length, 1).padStart(5)}%`);
        }
      }
    });

  return cli;
}

if (import.meta.main) await runCli(build(), process.argv.slice(2));
