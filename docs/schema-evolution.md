# Storylet schema evolution

The storylet system is grown game by game: each game's port adds only the features that game's
narrative structure demands. Each entry records what was added, the narrative evidence that forced
it, and what was considered and rejected.

## v1: Mass Effect 1

**Core model.** A *storylet* is a self-contained narrative beat with
- `requires`: a boolean expression over world state (when it can happen),
- `effects`: state assignments applied when it fires,
- `choices`: optional player decisions, each with its own `requires` and `effects`,
- `trigger`: `auto` (a forced beat, such as a cutscene or a critical-path consequence) or
  `player` (an agency point, such as picking the next mission from the galaxy map),
- `priority`, `repeatable`, `tags`, `evidence`, `notes`.

There are no "next" pointers. The narrative graph is derived from data flow (A writes what B
reads), which is what makes ME1's open middle act (Therum, Feros and Noveria in any order)
representable without special cases.

**State is the game's own plot table.** Variables bind to canonical plot refs
(`me1.bool.3828` = `CH2_Virmire.The_Choice.Rescued_Kaidan`) with the database path kept alongside
and checked by the validator. `story.*` variables cover state the plot tables don't expose
(Shepard's sex) or that hasn't been located yet (Shiala, Fist). Each such variable is documented
as a gap to close.

**Lifted conditions.** ME1's mission gating is already encoded as conditionals in BioWare's plot
database (`Time_For_Virmire_Open`: any two of Therum/Feros/Noveria). Rather than re-deriving
those rules, `conditions:` lift them verbatim, rewritten from `PE{elementid}` to canonical refs,
and the validator re-checks them against the database. BioWare's parameterized conditionals
(`argument`) become one-argument functions: `me1.world.completed_at_least(2)`.

**Expression language.** It is a superset of BioWare's conditional syntax (`&& || ! == != < <= > >=`,
arithmetic, `?:`), plus `count/any/all/min/max` and the engine forms `seen(storylet)` and
`chose(storylet, choice)`. `seen()` is for structural sequencing where the game has no variable
(the beats inside a mission).

**Abstractions** (documented in `notes`/`doc`): Charm/Intimidate skill checks become the
`me1.player.persuasive` condition over paragon/renegade points; multi-step romance conversations
become commit + consummation; per-colonist kill tracking becomes all-or-nothing.

Rejected for v1:
- Explicit act/phase state machines: lifted world-progress conditionals already gate acts.
- Per-line dialogue modeling: the plot databases don't record which conversation calls which
  conditional/transition (that lives in the game packages), so storylets work at the plot-beat
  level.

## v2: Mass Effect 2

ME2's narrative is organized very differently from ME1's: it is roster-driven (twelve
squadmates with identical recruit/loyalty/death flag families), counter-driven (critical-path
events fire after N missions), and ends in a rule system that kills or spares each squadmate. Each
v2 feature below is the smallest addition that let that structure be ported without hand-unrolling it.

| Feature | Forced by | Shape |
|---|---|---|
| **Campaign gating + `kind: bridge`** | ME2 can be reached by importing an ME1 save *or* starting fresh with the Genesis comic | Declaring `story.game` gates every `game: meN` storylet on `story.game == N`. Bridge storylets are exempt and move the campaign (`campaign.start`, `me2.import.me1_save`). |
| **Explicit import mapping** | LE2's `ME1_Plots_for_ME2` variables are ME2-native, filled by the importer (unlike LE3's aliased tables) | The bridge's effects copy ME1 state into them (`me2.import.ash_died = me1.virmire.rescued_kaidan`). Genesis writes the same variables *and* the ME1 table, because ME3 reads ME1 decisions from the ME1 table (224 reads, zero from the ME2 copies). |
| **`traits`** | Every ME2 mission advances `Missions_Total`, `Missions_Since_Last_Event` and `Missions_Count_Before_EndGame`, which the lifted `Time_for_CR2_message` / `Time_for_CR3` / crew-survival conditionals read | Named bundles of `requires`/`effects`/`tags` applied with `traits: [me2.mission]`. |
| **`foreach` templates** | Twelve squadmates × the same loyalty-mission pattern and suicide-mission role checks | Storylets, choices, outcomes and declaration entries (`me2.sm.alive.{who}: {foreach: ...}`) expand at load time; `{key}` placeholders are substituted, booleans as `true`/`false`. YAML anchors (`*roster`) share the binding table. |
| **`outcomes` + `resolve: all\|first`** | Suicide-mission deaths are computed by the game, not chosen by the player | System-resolved branches, evaluated in order against the post-choice state. `first` gives priority lists ("the first living squadmate in this order dies"). Resolved outcomes are recorded like choices, so `chose(storylet, outcome)` works. |
| **`derived` numeric values** | Hold-the-line casualties come from an averaged defence score | Named numeric expressions (conditions are coerced to bool; derived values aren't). New builtin `sum()`. |
| **`enum` story variables** | Specialist / fireteam-leader / escort assignments | `{type: enum, values: [...]}`, compared with string literals and validated on assignment. |
| **`trigger: idle`** | `Available_Missions_Complete`: when nothing else is left, the game forces the crew-abduction event | Idle storylets fire only when no auto or player storylet is available. |
| **Repeatable outcome loops** *(superseded by `limit`, see below)* | "N defenders die", with N computed | `me2.sm.hold_the_line` is `repeatable`, decrementing a pending-casualty counter until 0. |

**Lifted gating, again.** 25 conditionals were lifted verbatim, including all twelve
`Ready_to_open_<Codename>` loyalty gates, Horizon (`Time_for_CR1_message`: Mordin, Garrus and
Jack recruited and Grunt's tank retrieved), the Collector Ship (party size ≥ 8 and ≥ 5 missions
since the last event) and crew survival (`Missions_Count_Before_EndGame == 0 / 1..3 / > 3`).

**Morality.** ME2 gates persuasion on Paragon/Renegade relative to `*_Potential`, which grows with
progress. Hundreds of dialogue choices sit below storylet granularity, so the model takes a
declared `story.shepard.style` and lets the mission trait accrue points accordingly.

**Known gaps** (tracked as `story.*` vars with docs): Legion's heretic decision, Mordin's
genophage data, Sidonis, Kasumi's graybox and Morinth. ME3 reads these from ME2 variables, so the
ME3 port should reveal which ones (see v3).

## v3: Mass Effect 3

ME3 is where the trilogy's state converges. Its plot table *contains* the earlier games' tables,
its key rules are cross-game fate conditions, and its ending is a numeric threshold over a war
effort assembled from every arc. v3 is deliberately small, because most of what ME3 needs was
already expressible:

| Feature | Forced by | Shape |
|---|---|---|
| **Parameterized traits** | Every ME3 mission stamps its own `Mission_Completion_Order.<Code>` and bumps `Mission_Count`, and LE3's timing rules read those (`Tuchanka_bomb_exploded`: KroN7a done, KroN7b not, `Mission_Count >= order(KroN7a) + 3`) | `traits: [{me3.mission: {code: Kro002}}]`; trait bodies use `{code}`. A missing parameter is a load error. |
| **Tagged aggregates: `total('tag')`** | EMS (`Ending_Options.Current_Rating`) is the sum of war assets contributed by every arc, several conditional on earlier games (the Destiny Ascension exists only if ME1's Council was saved) | Vars may carry `tags: [war_asset]`. `total('war_asset')` sums them, and dataflow analysis expands it to every tagged var. |
| **Import without copying** | LE3 aliases ME2's table (same ids) and ME1's table (+10000) | The ME2→ME3 bridge only sets `story.game = 3` and the import flags. ME3 storylets read `me1.*`/`me2.*` directly, and the validator rejects binding an LE3 alias instead of its canonical variable. |

What did **not** need new schema:

- **Cross-game fates** are lifted verbatim. `Wrex_is_dead` reads ME1's `Krogan_conundrum`
  failure flags and ME3's confrontation; `Kaiden_Is_Dead` reads ME1's `Rescued_Kaidan`;
  `Legion_is_Dead` reads ME2's roster and ME3's Rannoch progress. 23 LE3 conditionals in all.
- **Expiring opportunities** (the Tuchanka bomb, side ops closing at Cronos) are ordinary
  `requires` over completion-order ints and lifted conditions. A dedicated "expires" construct was
  considered and rejected.
- **The Illusive Man persuasion** lifts the exact formula
  (`(Reputation + Paragon + Renegade) × (1 + PersuadeMultiplier) > ReputationValues.Level5`).
  Only its inputs are modeled.
- **Endings** are `outcomes` over EMS, using LE3's `Rating_Level_*` boundaries plus community-
  documented Extended Cut thresholds (the final ending logic is native code, not plot data).

### Porting ME3 corrected ME1 and ME2

Reading what LE3's conditionals reference turned up better bindings for earlier ports, which
were fixed in place:

| Earlier binding | Evidence from LE3 | Fix |
|---|---|---|
| ME1 roster bound to `Utility.Henchman.<Race>` | `Wrex_is_present` / `Check_Wreav` test `Utility.Henchman.InParty.Krogan` as "Wrex was recruited" | rebound the roster to `InParty.*` |
| ME1 Kirrahe survival as `Incursion_40.Kirrahe_Dead` | `Kirrahe_is_Dead := !GethFlyers_Disabled \|\| !GethFlyers_Reported` | Virmire's support choice now sets those two flags |
| ME1 Wrex death set only the specific failure substate | `Wrex_is_present` tests the parent `Krogan_conundrum.Failure` | both are set |
| ME2 placeholders `story.me2.legion.heretics`, `story.me2.mordin.kept_maelon_data`, `story.me2.morinth` | ME3 reads `Heretic_Resolution.Rewrite_Them/Blow_Them_Up`, `Professor_Loyalty...Saved_Data/Destroyed_Data`, `In_Party.Morinth_not_Samara` | rebound to the real variables |
| ME2 Legion handed to Cerberus not recorded | `Check_Is_Legion_Hologram` reads `Geth_Acquisition.Gave_Geth` | bound |
| ME2 Tali's trial generic | `Check_Tali_Admiral` reads the three `Trial_Resolution` outcomes | written out as three choices |
| ME2 LotSB / Arrival completion via early-level flags | ME3 reads `LiaraDLC_Completed`, `ArvLvl5.MissionComplete` | rebound |

The general lesson: **a later game's conditionals are the best documentation of an earlier
game's variables.** For each ME1/ME2 decision, the variable ME3 actually tests is the authoritative
binding.

### Tooling added alongside v3

- Coverage-guided simulation: the validator weights options towards rarely-taken branches,
  like a fuzzer. Uniform random play essentially never completed chains such as Rannoch peace
  (ME2 Legion activated, loyal, heretics rewritten, Tali loyal, both alive, Koris saved, the
  Consensus mission done, enough reputation). Guided play reaches them.
- `storylet outcomes`: end-of-campaign distributions (ending, EMS band, Earth, cross-game
  fates) over many simulated careers.
- `tests/test_trilogy.py`: a golden ME2→ME3 career that must reach peace, persuade the Illusive
  Man and get EMS ≥ 4000, plus checks that ME3's fate conditions read ME1/ME2 state.

## Post-v3 review: rules the validator now enforces

A review of the three ports (`docs/plans/2026-11-09-storylet-structure-review.md`) found that two
engine behaviours were documented as rules for authors to follow rather than checked. Content had
broken both. The schema is unchanged. The engine semantics are kept, and the validator now checks
them:

- **Choices are offered before the storylet's own effects apply.** A choice whose `requires` reads
  a variable the storylet itself writes is now an error. The engine change that would remove the
  need for the check (evaluate choices after effects) was rejected. Mission traits write
  morality and counters on every mission, so it would have shifted every persuasion check, and
  a choice testing its own mission's `me3.order.<code> == 0` would have flipped. To tell trait
  writes apart, the loader records how many of a storylet's effects came from traits.
- **Equal-priority auto storylets fire in file order.** Simulation now records pre-empted auto
  storylets (available, never fired, then unavailable) as warnings, and ties as info.
  Priorities express order. A tie-break rule in the engine was not added: any rule would be
  as arbitrary as file order.

The same review replaced the derived `story.me3.wreav_leads` with LE3's lifted `Wrex_is_present`
(`me3.me1.wrex_present`). It is another instance of the v3 lesson: the later game's conditional
is the authority.

## Post-v3: `limit` on outcomes

Hold the line kills "the first N defenders in this priority list" (disloyal first), with N
computed from the defence score. v2 expressed this as a loop. `hold_the_line` was a
`repeatable` auto storylet that applied the first matching outcome and decremented a
pending-casualty counter. The loop needed:

- the counter variable;
- a `-= 1` in every outcome;
- a catch-all outcome for running out of defenders;
- a counter guard on the next storylet.

`limit: "<expr>"` states the rule directly: outcomes are evaluated in order, each against the
state the previous ones left, and evaluation stops once `limit` of them have applied. The limit
is evaluated once, before the first outcome (after the storylet's and the choice's effects),
then truncated to an int and floored at 0. `resolve: first` is now loaded as `limit: 1`, so the
engine has a single code path.

A single limited pass gives the same result as the loop as long as applying an outcome never
makes an *earlier* outcome start matching. Here outcomes only kill defenders, so that holds.
This was checked on 20,000 constructed pre-battle states (0–3 deaths, including passes that run
out of disloyal defenders): deaths and Shepard's fate were identical.

The 2026-11-09 review had deferred this, because the loop already expressed the structure and
CLAUDE.md asks for schema changes only when a game forces them. It was added at the user's
request. `repeatable` is kept as a general feature (with an engine test), although no content
uses it now.
