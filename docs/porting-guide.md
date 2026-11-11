# Porting guide

How to port a piece of a game into storylets: a mission, a side quest or a decision. The
same loop was used for all three games.

## 1. Find the plot structure

```sh
pnpm meplot find me3 'Rannoch|Gth00' --type Plot --native     # where does it live?
pnpm meplot outline 'me3:Geth_Quarian.Gth002' --no-flags       # worksheet: states, conditionals, who writes what
```

Outlines list each state with the transitions that (probably) set it, and each conditional
with its code rewritten to canonical refs. Look for:

- **Critical-path / journal plots** (`*_Critical_Path`, `JournalGoal`/`JournalTask`):
  these are the beats.
- **Decision states with substates** (`Choice_Is_Made` → `Save_the_Council` /
  `Destroy_the_Council`): these are the choices.
- **`Time_for_*`, `*_available`, `Ready_to_open_*` conditionals**: the game's own gating.
  Lift them instead of re-deriving.
- **`*_is_Dead`, `*_is_present`, `Check_*` conditionals in a _later_ game**: they tell you
  which earlier-game variables matter, and are the best evidence for what an earlier
  variable means.

To find what a later game reads from an earlier one:

```sh
node --input-type=module <<'EOF'
import { getCatalog } from "./src/meplot/cli.ts";
import { READ_RE } from "./src/meplot/graph.ts";
const cat = await getCatalog();
for (const el of cat.dbs.get("me3").elements.values()) {
  if (el.kind !== "cond" || el.importRegion) continue;
  for (const r of (cat.conditionCode(el) ?? "").match(READ_RE) ?? [])
    if (r.startsWith("me2.") && cat.get(r)?.path.includes("Loyalty")) console.log(el.path, "->", cat.get(r).path);
}
EOF
```

## 2. Bind

```sh
pnpm meplot bind me3.rannoch.peace=me3.bool.17789 \
                 me3.rannoch.peace_possible=me3:Geth_Quarian.Gth002.Geth_2_Writing.Check_Peace_Possible_in_Theory
```

Paste the output into the area file's `vars:` / `conditions:`. Rules:

- Bind the **canonical** ref. The validator rejects LE3 import-region aliases
  (`me3.bool.13828` → bind `me1.bool.3828`).
- Keep the `path`. The validator checks it still resolves to the ref, which catches typos
  and database drift.
- Lifted `conditions` keep BioWare's code verbatim, and the validator compares it with the
  database. If you need different logic, write a separate, unbound condition.
- When no variable exists or can be found yet, use a `story.*` variable and write in `doc`
  what it stands for and where the real one might be. These are tracked gaps, not fixes.

## 3. Write storylets

- One storylet per plot beat. Use `trigger: auto` for things that happen to Shepard and
  `player` for agency points (choosing a mission, starting a conversation).
- Prefer gating on plot variables (`me1.world.time_for_virmire_open`) over `seen()`. Use
  `seen()` for sequencing inside a mission, where the game has no variable.
- Use `choices` for what the player decides and `outcomes` for what the game decides
  (`resolve: first` for priority lists, `limit: "<expr>"` when the first N matches apply
  and N is computed).
- Shared per-game mechanics go into `traits` (`me2.mission`,
  `{me3.mission: {code: Kro002}}`), and families of similar storylets into `foreach`.
- Write summaries in your own words at the plot-beat level. Don't transcribe dialogue.
- Put every simplification in `notes`.

## 4. Check

```sh
pnpm storylet validate                  # bindings, names, dataflow, coverage-guided reachability
pnpm storylet simulate --seed 3 --choose me3.rannoch.reaper_base=peace
pnpm storylet available --set me1.world.therum_done=true --set me1.world.feros_done=true
pnpm storylet outcomes --start me1      # does the change shift ending/fate distributions sensibly?
pnpm storylet coverage                  # how many of the game's quest plots are now bound
pnpm test
```

`never fired` / `never chosen` warnings mean either a real dead end (a requires that can't
hold) or a long chain that random play doesn't complete. Use `simulate --choose` or a test
policy (see `tests/trilogy.test.ts`) to tell which.

## 5. Evolve the schema only when forced

If a structure can't be expressed without hand-unrolling or misrepresenting it, extend the
schema with the smallest construct that fits. Then record it in
`docs/schema-evolution.md`: what was added, which narrative structure forced it, and what
was considered and rejected.
