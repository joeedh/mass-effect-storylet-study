# Data sources

## BioWare plot databases (via LegendaryExplorer)

`pnpm meplot fetch` downloads `PlotDatabases.zip` from
[ME3Tweaks/LegendaryExplorer](https://github.com/ME3Tweaks/LegendaryExplorer), pinned to commit
`b8869f92c7b80be7818447b5079f65c99b4a97b8` and verified by SHA-256 (`src/meplot/fetch.ts`). It
contains `le1.json`, `le2.json` and `le3.json`, LegendaryExplorer's export of BioWare's internal
plot databases for the Legendary Edition.

LegendaryExplorer is GPL-3.0, and the plot data originates from BioWare's games. This repository
does **not** vendor the databases or anything derived wholesale from them (`build/` is
gitignored). Storylet content references individual variables by id and path.

### What each database contains

| section        | meaning                                                                 |
|----------------|-------------------------------------------------------------------------|
| bools/ints/floats | runtime plot variables (`plotid` = index in the save's plot table)   |
| conditionals   | boolean functions over plot state; `code` uses `PE{elementid}` references |
| transitions    | functions that set state (`argument`); consequences are a subtype      |
| organizational | regions, plots, flag groups, journal goals/tasks/items                 |

Element types and substate subtypes are documented in LegendaryExplorer's `PlotElementType.cs`.

### Cross-game structure (verified by `tests/catalog.test.ts`)

- LE3's `ME2_Plots_for_ME3` region **is** the ME2 plot table at identical plot ids (5,545 bools
  match by id and label).
- LE3's `ME1_Plots_for_ME3` region is the ME1 table at **plot id +10000** (element id +25000);
  3,952 bools, 111 ints and 34 floats match.
- LE2's `ME1_Plots_for_ME2` region is **not** an alias. It holds ME2-native variables populated by
  the save importer, so content must bridge them explicitly.
- `pnpm meplot build` writes `build/anomalies.txt`: the 18 imported elements whose label differs from the
  source (DB editing artifacts such as `EndBossUnion` → `Enle1ssUnion`).

### What the databases do not contain

- **Who calls what.** Which conversation node, Kismet sequence or script evaluates a conditional
  or fires a transition lives in the `.pcc` game packages. Extracting that needs the game files
  plus LegendaryExplorer's package APIs, and is a natural future importer (see the roadmap in
  the README).
- **What a transition sets.** Transitions carry only a label and an argument. `meplot` infers the
  target from naming conventions (`Set_Rescued_Kaidan_True` → sibling state `Rescued_Kaidan`):
  12,363 high-confidence and 2,043 medium-confidence matches out of 16,443 transitions.
- **Dialogue text and cutscenes.** Storylet summaries are written fresh for this project and
  stay at the plot-beat level.
