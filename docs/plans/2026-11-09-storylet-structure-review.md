# Storylet structure review

## Goal

Re-examine the storylet engine and content after the three ports. For each problem that
was already diagnosed (`docs/debugging.md`, `docs/schema-evolution.md`), the question is
whether the fix removed the cause or only the symptom. Then fix the weak spots, starting
with ones that already produce wrong content.

## How each earlier fix holds up

**Choice `requires` evaluated before the storylet's own effects (Rannoch peace).** The fix
moved the bonuses into an earlier storylet and wrote a rule down for authors to remember.
The rule has already been broken again. `me3.genophage.shroud` sets
`me3.genophage.eve_dead` in its effects, and its choice `sabotage_persuade` requires
`me3.genophage.eve_dead`. That choice can never be offered, which is why the validator
reports it as "never chosen". Verdict: the evaluation order is fine (see Review), but a
rule nobody checks gets broken. The validator should enforce it.

**Golden-path test (`None == None`).** The fix is correct, but the policy still falls back
silently when a GOLDEN entry stops matching (an id renamed, or a choice no longer
available). The final assertions only catch this when the fallback happens to change the
ending. Verdict: needs an assertion that every GOLDEN pick was actually taken.

**`foreach` booleans, `seen()` argument names, backward ME2→ME1 edges, dense graph,
Arrival bridge trigger.** Each fix addresses the cause. No change.

## New findings

1. **Auto-storylet ties are broken by file order.** `step_options` fires the first
   highest-priority auto storylet in load order, and files load in sorted path order. In
   300 guided runs four pairs tied:
    - `me1.normandy.romance_night` / `me1.ilos.unlock` (33 times). This one is harmful.
      The romance scene only happens because `romance.yaml` sorts before
      `virmire_endgame.yaml`. If `ilos.unlock` fired first, `ilos.vigil` would set
      `enter_archives` and the scene would be lost without any warning.
    - `me2.conflict.tali_legion` / `me2.crit.crew_abducted` (69),
      `me2.conflict.miranda_jack` / `me2.crit.crew_abducted` (10),
      `me2.conflict.miranda_jack` / `me2.crit.collector_ship_message` (4). These commute:
      the effects don't overlap and both fire before the player acts.
2. **Who leads Urdnot in ME3 is re-derived instead of lifted, and the derivation is
   wrong.** `me3.genophage.surkesh` sets `story.me3.wreav_leads = me3.fate.wrex_dead`.
   LE3's Wreav checks (`Check_Wreav`, `Time_for_KroGru_Wreav_*`, and `Wreav_in_warroom` in
   a reduced form) test whether Wrex was on Shepard's squad at the end of ME1, which is
   the negation of `me3:Utility.Henchmen.ME1.Wrex_is_present` (`me3.cond.194`). They never
   test `Wrex_is_dead`. The current model gets three careers wrong: Wrex never recruited
   in ME1, Genesis "Wrex dies", and a fresh ME3 start. In all three it has Wrex leading
   Urdnot, which also inflates the krogan war asset (350 instead of 250).
3. **18 non-repeatable storylets guard on `!seen(self)`.** The engine already refuses to
   re-fire them, so the guard is noise. It does no harm. _Not changing_: it is churn
   without a behavior change.

## Steps

1. **Validator: choice reads own effect.** If a choice's `requires` reads a variable that
   the storylet's own `effects` write, that is an error, because the choice sees the value
   from before the effect. Variables written only by the storylet's traits (mission
   counters, morality, EMS) are reported as info. The loader records how many of a
   storylet's effects came from traits (`Storylet.trait_effects`).
2. **Content: fix `sabotage_persuade`.** Require the input the effect is computed from
   (`!me2.mordin.saved_data`) instead of `me3.genophage.eve_dead`. The Rannoch dreadnought
   workaround stays: it is the correct structure.
3. **Engine + validator: report pre-empted autos and ties.** `Engine.run` records, in the
   trace, the auto storylets that were available and then became unavailable without
   firing (pre-empted), and the sets of autos tied at top priority. `validate` warns on
   pre-emption and lists ties as info.
4. **Content: order the ties explicitly.** `me1.normandy.romance_night` gets
   `priority: 10`. Both `me2.conflict.*` get `priority: 10`: they fire straight after the
   loyalty mission that triggers them. Re-run tie detection with more than one seed.
5. **Content: lift `Wrex_is_present`** into `content/me3/_world.yaml` as
   `me3.me1.wrex_present`. Add an unbound condition
   `me3.genophage.wreav_leads: "!me3.me1.wrex_present"`. Delete `story.me3.wreav_leads`
   and its effect, and update the Sur'Kesh summary and notes. `me3.fate.wrex_dead` stays
   (CLI outcomes and tests use it). Add a "Wreav leads" line to `storylet outcomes`.
6. **Tests.** The validator lint. Pre-emption detection. Every GOLDEN pick is in
   `final.chosen`. Wreav leads for never-recruited, Genesis wrex_dies and fresh-ME3
   careers, and Wrex leads when he was talked down. `sabotage_persuade` is offered when
   Wreav leads and Maelon's data was destroyed.
7. **Docs.** `docs/debugging.md`: rewrite the Rannoch entry (the validator now enforces
   the rule), add the shroud case, the pre-emption case, and a plot-database surprise
   (`Wrex_is_dead` ≠ "Wreav leads"). `docs/schema-evolution.md`: note the new validator
   checks. `README.md` counts: lifted conditionals 50 → 51, `story.*` 50 → 49.

## Deferred (proposed, not done here)

- **Done (2026-11-10, at the user's request; see `2026-11-10-outcome-limit.md`).**
  **`limit:` on outcomes instead of the hold-the-line loop.** `me2.sm.hold_the_line` is a
  repeatable auto storylet decrementing `story.me2.sm.htl_deaths_pending`, with a
  `nobody_left` outcome and a `pending == 0` guard on the next storylet. `resolve: first`
  is the special case `limit: 1`. A `limit: "<expr>"` would turn the loop into one
  storylet. This is a schema change for a structure the existing schema already expresses,
  so per CLAUDE.md it waits until another "N computed casualties/rewards" structure needs
  it too (ME3's war-asset losses are a candidate).
- **Remove redundant `!seen(self)` guards** (finding 3).

## Risks / open questions

- The pre-emption check could be noisy if some autos are meant to be mutually exclusive.
  Measure before making it a warning.
- The Wreav fix lowers EMS in three career families, so `storylet outcomes` distributions
  shift. That is intended.

## Review

A fresh-context agent read only this plan and the code it points to. Findings and
resolutions:

- **Changing the evaluation order isn't needed (should-fix).** The first draft proposed
  evaluating choice `requires` after the storylet's effects. The reviewer showed it would
  shift balance silently (7 of 8 affected choices only read trait counters; ME2's
  persuasion is a ratio, so balanced careers would get _harder_, not easier as the draft
  said). It would also create the opposite trap: `me3.order.<code> == 0` in a choice would
  see its own mission already counted. _Resolved:_ dropped. The content fix plus a
  validator lint replaces it (steps 1 and 2).
- **The engine-change details** (shared `values` dict, repeated computation, enum errors
  raised during availability checks). _Resolved:_ moot once the engine change was dropped.
- **The tie warning was too broad (should-fix).** Three of the four ties commute. Only the
  romance tie loses content. _Resolved:_ warn on pre-emption (an auto that becomes
  unavailable without firing), and list ties as info (step 3). The reviewer confirmed that
  priority 10 cannot pre-empt anything else: only setup steps rank higher.
- **The Wreav fix covers more than the draft said (should-fix).** The reviewer traced
  every career path. Genesis wrex_dies and fresh ME3 starts are also wrong today, and the
  krogan asset changes. `Wreav_in_warroom` uses a reduced form. The name
  `me3.fate.wrex_present` would be confused with End_Game's `Wrex_is_present`. _Resolved:_
  findings and step 5 updated, and the condition is named `me3.me1.wrex_present`.
- **Missing steps (should-fix):** the CLI outcomes line, more career tests, the Sur'Kesh
  text, README counts, the debugging entry, keeping `wrex_dead` deliberately. _Resolved:_
  added to steps 5–7.
- **Golden assertion (nit):** assert against `final.chosen`. _Resolved:_ step 6.

## Status

Done. All steps are complete. `python -m unittest` passes (28 tests). `storylet validate`
reports 0 errors and 1 warning (`me2.sm.choose_party2/none`, a rare branch that existed
before this work).

- [x] 1 validator lint. It flags `sabotage_persuade` as an error and seven trait-counter
      reads as info.
- [x] 2 `sabotage_persuade` fixed. It is now chosen in simulation.
- [x] 3 pre-emption and tie reporting (`Trace.preempted`, `Trace.ties`).
- [x] 4 tie priorities. No ties or pre-emptions in 300 runs for seeds 0–4.
- [x] 5 `Wrex_is_present` lifted. `storylet outcomes --start me1`: Wrex is dead in 29.5%
      of careers, but Wreav leads in 89.5%. The old derivation would have given Wrex about
      70%.
- [x] 6 tests.
- [x] 7 docs.

Changed along the way: the GOLDEN assertion found that the golden career had been silently
skipping two picks before this work (it shot Kaidan at the Citadel and never did the
krogan team mission). The reviewer had assumed it held. `free_breeder` was impossible
because Genesis released the queen, and the policy rushed ME3's priority missions before
reputation was high enough to talk anyone down. Fixed in the test: Genesis's rachni pick
is now scripted (and `free_queen` replaces `free_breeder`), and in ME3 the policy plays
optional content first. See the `docs/debugging.md` entry.
