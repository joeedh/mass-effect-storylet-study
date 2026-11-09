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
storylet atlas               # build/atlas.html: interactive map of the derived graph
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
| ME1  | 40: critical path, squad, romance, cross-game decisions | v1 |
| ME2  | 67: ME1 import + Genesis, recruitment, loyalty, crit path, the rule-driven suicide mission, LotSB, Arrival | v2 |
| ME3  | 37: ME2 import, genophage arc, Cerberus coup, Rannoch, Thessia, Horizon, Cronos, Earth + EMS endings, side ops | v3 |

Across the trilogy: 145 storylets bound to 314 plot variables, 51 conditionals lifted verbatim from
the plot databases (mission gating, crew survival, cross-game fates, the Tuchanka bomb timer, the
Illusive Man persuasion formula), and 49 documented `story.*` variables for state the plot
tables don't hold or that hasn't been located yet.

## Docs

- [docs/schema-evolution.md](docs/schema-evolution.md): what each game forced the schema to add
  (v1 ME1, v2 ME2, v3 ME3), and how porting ME3 corrected ME1/ME2 bindings.
- [docs/porting-guide.md](docs/porting-guide.md): the find → bind → write → check loop.
- [docs/data-sources.md](docs/data-sources.md): provenance, licensing, cross-game table structure,
  and what the plot data doesn't contain.

## Roadmap

- **Breadth.** Quest/mission plots bound: ME1 19/89, ME2 22/54, ME3 24/33 (`storylet coverage`).
  ME1's count includes many small side quests. Side quests, N7 missions, ME3 romances and the Citadel/Omega DLCs are
  next. They are mostly content work on the existing schema.
- **Close the `story.*` gaps.** Shiala, Fist, Sidonis, Kasumi's graybox, Shepard's sex in ME1. Look
  for later-game conditionals that read them, as was done for Legion and Mordin.
- **Who calls what.** The plot databases don't record which conversation or Kismet sequence
  evaluates a conditional or fires a transition. With the game files, LegendaryExplorer's
  package APIs could extract that and give dialogue-level edges below each storylet. An
  importer would slot in beside `meplot`.
- **Transition semantics.** Replace naming-based transition-target inference with the real state
  maps (BioWare's state event maps live in the game packages).
- **Tighter rules.** Hold-the-line casualty tables, peace-chance accrual and the final ending
  thresholds are approximations; each is marked in `notes`.
