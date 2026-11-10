# Debugging guide

A running log of problems that were hard to diagnose in this project: what they looked like and
what actually caused them. Add to it whenever something takes more than a quick look to figure out.

## Tools

| Question | Command |
|---|---|
| What can fire from this state? | `pnpm storylet available --set me1.world.therum_done=true` |
| Play one career, forcing some choices | `pnpm storylet simulate --seed 3 --choose me3.rannoch.reaper_base=peace --state` |
| Can a long chain be reached at all? | write a fixed policy as in `tests/trilogy.test.ts` and trace it step by step |
| What does a plot variable mean? | `pnpm meplot show me2.bool.1664` (also lists its aliases in later games) |
| What does a later game read from an earlier one? | the `READ_RE` loop in `docs/porting-guide.md` |
| Where do outcomes land over many careers? | `pnpm storylet outcomes --start me1 --runs 500` |

To evaluate any expression against a traced state:

```ts
import { parse } from "./src/storylet/expr.ts";
engine.eval(parse("me3.rannoch.peace_possible"), state);
```

## Validator messages

**"X is read by [...] but never written."** Something tests a variable no storylet sets. This is
either a real gap, or a variable read only inside a lifted conditional that the model doesn't
drive (for example the squadmate-fired variants of the Citadel II standoff). In the second case,
declare it with `default:` and a `doc` that says it isn't modeled.

**"never fired / never chosen in N simulated playthroughs."** Either the requires can never
hold, or the chain is long and simulation rarely completes it. Simulation is coverage-guided, but
chains such as Rannoch peace (about eight prerequisite decisions across ME2 and ME3) were still
missed until a real bug was fixed. Check with a fixed policy before assuming it's just rare.

**"is an alias; bind me1.bool.N".** You bound an LE3 import-region element. Bind the canonical
ME1/ME2 variable instead.

**"requires reads [...], which X's own effects write" (error).** A choice is offered before its
storylet's effects apply, so the choice tests the old value, usually the default, and is
probably never offered. Test the input the effect is computed from, or set the variable in an
earlier storylet. When the variable is written only by the storylet's traits (morality,
reputation, EMS), this is reported as info: the choice sees the value from before this mission,
which is usually acceptable.

**"auto storylet was available, never fired, then became unavailable".** Another auto beat at
the same or higher priority fired first and closed its window. Give the pre-empted storylet a
higher priority. The info line "auto storylets tied at equal priority" lists the ties behind
such problems. Ties whose effects don't interact are harmless, but any tie means file order is
deciding.

## Cases

### Rannoch peace could never be chosen

- **Symptom:** `me3.rannoch.reaper_base/peace` was never chosen, even on a hand-written "golden" career.
- **Found by:** tracing the golden policy and printing `peace_possible`, `peace_chance` and
  `persuasive` at each step. At the end of the run every condition was true.
- **Cause:** choice `requires` are evaluated before the storylet's own `effects` are applied.
  The ME2-derived peace bonuses were effects of the same storylet, so they never counted
  towards its choices.
- **Fix:** apply the bonuses in an earlier storylet (`me3.rannoch.dreadnought`). **Rule:** state a
  choice depends on must be set before the storylet that offers the choice.
- **Follow-up:** the rule was broken again (next case), so `pnpm storylet validate` now enforces it.
  Changing the engine to evaluate choices after effects was considered and rejected. It would
  shift every persuasion check by one mission's accrual from the mission trait, which makes ME2's
  ratio-based check *harder* for balanced Shepards. It would also invert the trap: a choice
  testing `me3.order.<code> == 0` would see its own mission already counted.

### Mordin could never be talked out of the cure

- **Symptom:** `me3.genophage.shroud/sabotage_persuade: never chosen` in every validation run.
- **Found by:** a script listing choices whose `requires` read what their own storylet writes,
  which is now the validator check above.
- **Cause:** the choice required `me3.genophage.eve_dead`, which only the same storylet's effects
  set. Same mistake as the Rannoch case.
- **Fix:** require the input instead (`!me2.mordin.saved_data`: Maelon's data destroyed in ME2).

### The romance scene depended on file names

- **Symptom:** none yet; found by instrumenting ties in simulation. `me1.normandy.romance_night`
  and `me1.ilos.unlock` are both auto with priority 0 after the Normandy's escape.
- **Cause:** ties among auto storylets go to the first in content order, which is sorted file
  order. `romance.yaml` sorts before `virmire_endgame.yaml`. Renamed, Ilos would open first,
  Vigil would set `enter_archives`, and the scene would silently never play.
- **Fix:** `priority: 10` on the scene (and on the ME2 loyalty conflicts, which tied with
  crit-path beats harmlessly). The validator now warns on pre-emption and lists ties.

### The golden career silently skipped two of its picks

- **Symptom:** none: `test_golden_career` passed while the career shot Kaidan at the Citadel and
  never did the krogan team mission. Caught by a new assertion that every GOLDEN pick is in
  `final.chosen`.
- **Cause:** (1) Genesis's rachni choice wasn't scripted, so the queen was released and the
  scripted `free_breeder` was unavailable. Priority: Tuchanka then closed the mission. (2) The
  policy took scripted picks as soon as they appeared, so in ME3 it rushed the priority missions
  and reached Citadel II without the reputation that `talk_down` needs.
- **Fix:** script the Genesis choice. In ME3 the policy plays optional content first. In ME2 it
  keeps taking scripted picks promptly, because doing optional missions first brings the crew
  abduction forward and closes Legion's reactivation. Any fallback now fails the test.

### A golden-path test made disastrous choices

- **Symptom:** the ME2 golden career lost Legion, Kasumi and Thane; the loyalty missions never ran.
- **Cause:** a test bug. `GOLDEN.get(st.id) == cid` is true for any storylet with no choices
  that is not in the dict (`None == None`), so the policy launched the suicide mission immediately.
- **Fix:** `st.id in GOLDEN and GOLDEN[st.id] == cid`.

### `foreach` produced "unknown variable 'True'"

- **Cause:** template substitution used Python's `str()` on YAML booleans (before the
  TypeScript port).
- **Fix:** the loader substitutes booleans as `true`/`false`.

### `seen(x)` reported "unknown variable x"

- **Cause:** the arguments of `seen()`/`chose()` were parsed as name nodes and checked as
  variables.
- **Fix:** `Node.names()` skips arguments of special forms (`seen`, `chose`, `total`).

### A YAML key `y:` loaded as `true` (TypeScript port)

- **Symptom:** in a test, var `y: me2.bool.2` was unknown ("unknown variable 'y'").
- **Found by:** the engine tests, after a whole-content comparison of PyYAML and `yaml` had
  passed. No content file happened to use `y` or `n`.
- **Cause:** the `yaml` package's YAML 1.1 schema reads `y`/`n` as booleans, `1e5` as a float
  and `09` as an int. PyYAML reads all three as strings, and the content was written against
  PyYAML.
- **Fix:** `YAML_OPTIONS` in `src/storylet/loader.ts` swaps in PyYAML's narrower scalar regexes.
  A test pins the cases.

### `pnpm lint` passed, but the type-aware rules had never run

- **Symptom:** an `any` member access and an `any` assignment were not reported.
- **Cause:** the lintrix npm package lints through a bundled WASM engine when no native binary
  is found. WASM has no TypeScript type server, so it skips every type-aware rule
  (`no-unsafe-*`, `strict-boolean-expressions`, `no-floating-promises`) and says nothing.
- **Fix:** `pnpm lint` passes `--engine native`, which fails with exit code 2 when no native
  `lintrix` is on PATH.

### The derived graph had ME2 → ME1 edges

- **Cause:** Genesis (ME2) writes ME1 variables so that ME3 sees a consistent history, and ME1
  storylets read them. That data flow is real, but campaign gating makes those edges impossible.
- **Fix:** `graph.build` drops edges that run backwards in game order when the content is gated.

### The derived graph was unreadably dense

- **Cause:** "infrastructure" variables (mission counters, morality points, EMS) are written by
  dozens of storylets and connect everything to everything.
- **Fix:** `pnpm storylet graph --max-writers 10` drops edges through such variables. The atlas uses it.

### An optional DLC never ran (Arrival)

- **Cause:** the ME2 → ME3 bridge was `trigger: auto` with high priority, so it fired as soon as
  ME2 ended and pre-empted the post-game content.
- **Fix:** moving to the next game is a player decision, so the bridge is `trigger: player`.

## Plot-database surprises

- Some labels are corrupted by an old find-and-replace (`EndBossUnion` → `Enle1ssUnion`).
  `pnpm meplot build` lists them in `build/anomalies.txt`.
- ME1 has two roster families: `Utility.Henchman.<Race>` and `Utility.Henchman.InParty.<Race>`.
  ME3 treats `InParty` as "recruited", so bind that one.
- `Wrex_is_dead` is not "Wreav leads". LE3's Wreav checks (`Check_Wreav`,
  `Time_for_KroGru_Wreav_*`, `Wreav_in_warroom`) test whether Wrex ended ME1 in the squad
  (`!Utility.Henchmen.ME1.Wrex_is_present`). An ME1 Wrex who was never recruited, a Genesis
  "Wrex died", and a fresh ME3 start all count as not dead but still give Wreav. The model
  derived leadership from `Wrex_is_dead` and had Wrex leading in all three. It now lifts
  `Wrex_is_present`.
- Transition targets are inferred from names and can be wrong; treat a "medium" confidence match
  as a hint, not as fact.
- About half of all `sequence` values are fractional (27,698 of them, such as `193.75`). The
  catalog truncates them to integers, a quirk inherited from the Python version, where
  `int(193.75)` silently gave 193. Children whose sequences truncate to the same integer
  (under 2,163 parents) are then ordered by element id, not by sequence. This affects outlines
  and the order of `descendants`. It was kept through the TypeScript port so outputs could be
  compared byte for byte. Fixing it means using the float in `sequenceOf`
  (`src/meplot/catalog.ts`).
