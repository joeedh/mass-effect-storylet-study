// Tests against the real plot databases. Skipped unless `pnpm meplot fetch` has been run.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { loadCatalog } from "../src/meplot/catalog.ts";
import { haveDatabases } from "../src/meplot/fetch.ts";
import { inferTransitionTarget } from "../src/meplot/graph.ts";
import { ROOT } from "./helpers.ts";

const PLOTDB = path.join(ROOT, "build", "plotdb");
const skip = haveDatabases(PLOTDB) ? false : "run `pnpm meplot fetch` to enable plot-database tests";

describe("catalog", { skip }, () => {
  const cat = skip === false ? loadCatalog(PLOTDB) : null;
  const c = () => cat!;

  it("resolves paths", () => {
    assert.deepEqual(c().resolvePath("me1:CH2_Virmire.The_Choice.Rescued_Kaidan").map((h) => h.ref), ["me1.bool.3828"]);
  });

  it("finds the ME1 table inside LE3 at an offset", () => {
    const el = c().get("me3.bool.13828")!;
    assert.equal(el.canonical, "me1.bool.3828");
    assert.equal(el.importRegion, "ME1_Plots_for_ME3");
  });

  it("finds the ME2 table inside LE3 unchanged", () => {
    const hits = c().resolvePath("me3:ME2_Plots_for_ME3.Act_3.Final_Decision.Destroy_Base");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.canonical, "me2.bool.1831");
  });

  it("keeps LE2's import region native", () => {
    const [hit] = c().resolvePath("me2:ME1_Plots_for_ME2.CH2_Virmire.Ash_died");
    assert.equal(hit!.canonical, hit!.ref); // ME2's own variable, set by the importer
  });

  it("rewrites conditionals to canonical refs", () => {
    const [el] = c().resolvePath("me1:Global_Plots.World_Progress.Time_For_Virmire_Open");
    const code = c().conditionCode(el!)!;
    assert.ok(code.includes("me1.bool.4104 == false"));
    assert.ok(!code.includes("PE{"));
  });

  it("infers transition targets", () => {
    const [tr] = c().resolvePath("me1:CH2_Virmire.The_Choice.Set_Rescued_Kaidan_True");
    const hit = inferTransitionTarget(c(), tr!)!;
    assert.deepEqual([hit.state.ref, hit.confidence, hit.value], ["me1.bool.3828", "high", "true"]);
  });

  it("has few alias anomalies", () => {
    assert.ok(c().anomalies.length < 50);
  });
});
