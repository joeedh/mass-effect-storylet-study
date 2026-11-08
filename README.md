# Mass Effect storylet study

Extract the narrative graph of the Mass Effect Legendary Edition trilogy from BioWare's own plot
data, and port it, one game at a time, to a storylet system that is evolved to represent it.

```
 BioWare plot databases (LE1/LE2/LE3)          content/me{1,2,3}/*.yaml
 ── bools, ints, floats, conditionals,          ── storylets bound to plot variables
    transitions, journal quests                    (requires / effects / choices)
            │  meplot (extraction)                        │  storylet (engine)
            ▼                                             ▼
 Layer 0: extracted plot graph  ◀── validated against ── Layer 1: storylet graph
 (state skeleton, cross-game aliases)                     (emergent narrative graph, simulation)
```

- **Layer 0** (`src/meplot`): the *extracted* graph. 58k plot elements from the three games'
  plot databases, with conditionals (what reads state), transitions (what writes state) and the
  save-carryover aliases between games.
- **Layer 1** (`src/storylet`): the *curated* graph. Storylets whose preconditions and effects
  are expressed over the extracted variables, so every narrative beat is grounded in, and
  validated against, the real game state.

## Quick start

```sh
pip install -e .
meplot fetch                 # download the pinned plot databases into build/plotdb (not vendored)
meplot build                 # build/catalog.json, build/plotgraph.json, build/outlines/<game>/<region>.md
storylet validate            # content vs. plot DB + 300 simulated playthroughs
storylet simulate --seed 4   # one random playthrough
storylet graph --format dot -o build/storylets.dot
storylet coverage            # which quest plots are bound by storylets
storylet outcomes --start me1 --runs 500   # ending / EMS / cross-game fate distributions
python -m unittest discover -s tests
```

Inspecting the plot data while porting:

```sh
meplot find me1 'Virmire.*Kaidan' --type State
meplot outline 'me1:CH2_Virmire.The_Choice'          # porting worksheet: states, conditions, writers
meplot show me1.bool.3828                            # + its aliases in later games
meplot bind me1.virmire.rescued_kaidan=me1:CH2_Virmire.The_Choice.Rescued_Kaidan \
            me1.world.time_for_virmire_open=me1:Global_Plots.World_Progress.Time_For_Virmire_Open
```

## Status

| Game | Storylets | Notes |
|------|-----------|-------|
| ME1  | 40: critical path + cross-game decisions | schema v1 |
| ME2  | 68: ME1 import + Genesis, recruitment, loyalty, crit path, suicide mission, LotSB, Arrival | schema v2 |
| ME3  | 37: ME2 import, prologue, genophage arc, Cerberus coup, Rannoch, Thessia, Horizon, Cronos, Earth + EMS endings, side ops | schema v3 |

See [docs/schema-evolution.md](docs/schema-evolution.md) for how the schema changes per game, and
[docs/data-sources.md](docs/data-sources.md) for provenance and what the plot data does and doesn't
contain.
