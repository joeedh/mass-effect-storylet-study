# Debugging guide

A running log of problems that were hard to diagnose in this project: what they looked like and
what actually caused them. Add to it whenever something takes more than a quick look to figure out.

## Tools

| Question | Command |
|---|---|
| What can fire from this state? | `storylet available --set me1.world.therum_done=true` |
| Play one career, forcing some choices | `storylet simulate --seed 3 --choose me3.rannoch.reaper_base=peace --state` |
| Can a long chain be reached at all? | write a fixed policy as in `tests/test_trilogy.py` and trace it step by step |
| What does a plot variable mean? | `meplot show me2.bool.1664` (also lists its aliases in later games) |
| What does a later game read from an earlier one? | the `READ_RE` loop in `docs/porting-guide.md` |
| Where do outcomes land over many careers? | `storylet outcomes --start me1 --runs 500` |

To evaluate any expression against a traced state:

```python
from storylet.expr import parse
engine.eval(parse("me3.rannoch.peace_possible"), state)
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

### A golden-path test made disastrous choices

- **Symptom:** the ME2 golden career lost Legion, Kasumi and Thane; the loyalty missions never ran.
- **Cause:** a test bug. `GOLDEN.get(st.id) == cid` is true for any storylet with no choices
  that is not in the dict (`None == None`), so the policy launched the suicide mission immediately.
- **Fix:** `st.id in GOLDEN and GOLDEN[st.id] == cid`.

### `foreach` produced "unknown variable 'True'"

- **Cause:** template substitution used Python's `str()` on YAML booleans.
- **Fix:** the loader substitutes booleans as `true`/`false`.

### `seen(x)` reported "unknown variable x"

- **Cause:** the arguments of `seen()`/`chose()` were parsed as name nodes and checked as
  variables.
- **Fix:** `Node.names()` skips arguments of special forms (`seen`, `chose`, `total`).

### The derived graph had ME2 → ME1 edges

- **Cause:** Genesis (ME2) writes ME1 variables so that ME3 sees a consistent history, and ME1
  storylets read them. That data flow is real, but campaign gating makes those edges impossible.
- **Fix:** `graph.build` drops edges that run backwards in game order when the content is gated.

### The derived graph was unreadably dense

- **Cause:** "infrastructure" variables (mission counters, morality points, EMS) are written by
  dozens of storylets and connect everything to everything.
- **Fix:** `storylet graph --max-writers 10` drops edges through such variables. The atlas uses it.

### An optional DLC never ran (Arrival)

- **Cause:** the ME2 → ME3 bridge was `trigger: auto` with high priority, so it fired as soon as
  ME2 ended and pre-empted the post-game content.
- **Fix:** moving to the next game is a player decision, so the bridge is `trigger: player`.

## Plot-database surprises

- Some labels are corrupted by an old find-and-replace (`EndBossUnion` → `Enle1ssUnion`).
  `meplot build` lists them in `build/anomalies.txt`.
- ME1 has two roster families: `Utility.Henchman.<Race>` and `Utility.Henchman.InParty.<Race>`.
  ME3 treats `InParty` as "recruited", so bind that one.
- Transition targets are inferred from names and can be wrong; treat a "medium" confidence match
  as a hint, not as fact.
