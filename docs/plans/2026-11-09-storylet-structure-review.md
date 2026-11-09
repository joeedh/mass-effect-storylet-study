# Storylet structure review

## Goal

Re-examine the storylet engine and content after the three ports. For each problem that was
already diagnosed (`docs/debugging.md`, `docs/schema-evolution.md`), the question is whether the
fix removed the cause or only the symptom. Then fix the weak spots, starting with ones that
already produce wrong content.

## How each earlier fix holds up

**Choice `requires` evaluated before the storylet's own effects (Rannoch peace).** The fix moved
the bonuses into an earlier storylet and wrote a rule down for authors to remember. The rule
has already been broken again. `me3.genophage.shroud` sets `me3.genophage.eve_dead` in its
effects, and its choice `sabotage_persuade` requires `me3.genophage.eve_dead`. That choice can
never be offered, which is why the validator reports it as "never chosen". The engine is also
inconsistent with itself: choice *effects* already run after the base effects, and outcomes
run after both, but choice *requires* see the state from before. Verdict: the fix treated a
symptom. The cause is the evaluation order, so the engine should change.

**Golden-path test (`None == None`).** The fix is correct, but the policy still falls back
silently when a GOLDEN entry stops matching (an id renamed, or a choice no longer available).
The final assertions only catch this when the fallback happens to change the ending. Verdict:
needs an assertion that every GOLDEN pick was actually taken.

**`foreach` booleans, `seen()` argument names, backward ME2→ME1 edges, dense graph, Arrival
bridge trigger.** Each fix addresses the cause. No change.

## New findings

1. **Auto-storylet ties are broken by file order.** `step_options` fires the first
   highest-priority auto storylet in load order, and files load in sorted path order. In 300
   guided runs four pairs tied:
   - `me1.normandy.romance_night` / `me1.ilos.unlock` (33 times). The romance scene only happens
     because `romance.yaml` sorts before `virmire_endgame.yaml`. If `ilos.unlock` fired first,
     `ilos.vigil` would compete with it next, and renaming the file would silently drop the scene.
   - `me2.conflict.tali_legion` / `me2.crit.crew_abducted` (69),
     `me2.conflict.miranda_jack` / `me2.crit.crew_abducted` (10),
     `me2.conflict.miranda_jack` / `me2.crit.collector_ship_message` (4).
2. **Who leads Urdnot in ME3 is re-derived instead of lifted, and the derivation is wrong.**
   `me3.genophage.surkesh` sets `story.me3.wreav_leads = me3.fate.wrex_dead`. LE3 never tests
   `Wrex_is_dead` for this. Every Wreav check (`Check_Wreav`, `Wreav_in_warroom`,
   `Time_for_KroGru_Wreav_*`) uses `Krogan_conundrum.Failure || !InParty.Krogan`, which is the
   negation of the lifted-able `me3:Utility.Henchmen.ME1.Wrex_is_present` (`me3.cond.194`). If
   Wrex was never recruited in ME1, ME2's import marks him dead but this model has him leading
   Urdnot in ME3. The `story.*` variable isn't needed at all.
3. **18 non-repeatable storylets guard on `!seen(self)`.** The engine already refuses to re-fire
   them, so the guard is noise. It does no harm. *Not changing*: it is churn without a behavior
   change.

## Steps

1. **Engine: a storylet plays out in phases** (`src/storylet/engine.py`). Base effects (including
   trait effects), then the choice, then outcomes. Each phase sees the state left by the one before.
   `choices()` evaluates choice `requires` against the post-effect state, with the same `fired`
   set the effects see (including the storylet itself). `is_available` needs at least one choice
   to hold in that state. `fire()` is restructured to apply the phases in that order.
   Impact (checked with a script): `shroud/sabotage_persuade` becomes reachable. Persuasion checks
   in `me2.loyalty.tali`, `me3.rannoch.reaper_base`, `me3.thessia`, `me3.monastery` and
   `me3.earth.illusive_man` now include the mission's own reputation/morality accrual from its
   trait. `me3.earth.catalyst/synthesis` sees the EMS refreshed by its own trait. No choice
   `requires` uses `seen()`.
2. **Engine + validator: report auto ties.** `Engine.run` records sets of auto storylets that
   were available together at the top priority (`Trace.ties`). `validate` warns once per tied
   set, telling the author to give them distinct priorities.
3. **Content: resolve the four ties.** `me1.normandy.romance_night` gets `priority: 10` (the
   scene belongs before Ilos). Both `me2.conflict.*` get `priority: 10`: they fire straight
   after the loyalty mission that triggers them, ahead of crit-path messages.
4. **Content: lift `Wrex_is_present`.** Add it to `content/me3/_world.yaml` as
   `me3.fate.wrex_present`. Add an unbound condition `me3.genophage.wreav_leads:
   "!me3.fate.wrex_present"`. Delete `story.me3.wreav_leads` and the effect that set it, and point
   the shroud choices at the condition.
5. **Tests.** Engine: a choice can depend on its own storylet's effects; ties are recorded.
   Trilogy: assert every GOLDEN pick was taken; a never-recruited ME1 Wrex means Wreav leads in
   ME3; `sabotage_persuade` is offered when Wreav leads and Eve is dead.
6. **Docs.** `docs/debugging.md`: rewrite the Rannoch entry (the rule is now enforced by the
   engine), add the shroud case, the tie case and the Wreav derivation. `docs/schema-evolution.md`:
   record the evaluation-order change and the tie warning as v3 revisions. Update the counts in
   `README.md`.

## Deferred (proposed, not done here)

- **`limit:` on outcomes instead of the hold-the-line loop.** `me2.sm.hold_the_line` is a
  repeatable auto storylet decrementing `story.me2.sm.htl_deaths_pending`, with a `nobody_left`
  outcome and a `pending == 0` guard on the next storylet. `resolve: first` is the special case
  `limit: 1`. A `limit: "<expr>"` would turn the loop into one storylet. This is a schema change
  for a structure the existing schema already expresses, so per CLAUDE.md it waits until another
  "N computed casualties/rewards" structure needs it too (ME3's war-asset losses are a candidate).
- **Remove redundant `!seen(self)` guards** (finding 3).

## Risks / open questions

- Evaluating choices after effects means `is_available` now applies effects speculatively for
  storylets that have choices. An effect that raises (an invalid enum assignment) would now
  surface during availability checks rather than at fire time. That is acceptable: it is a
  content error either way.
- The persuasion checks get slightly easier (one mission's accrual). The golden career must
  still pass. Distribution shifts show up in `storylet outcomes`.

## Review

_Pending: fresh-context review of this plan._

## Status

- [ ] 1 engine phases
- [ ] 2 tie reporting
- [ ] 3 tie priorities
- [ ] 4 lift Wrex_is_present
- [ ] 5 tests
- [ ] 6 docs
