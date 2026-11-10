# `limit:` on outcomes (hold the line)

## Goal

Replace the suicide mission's hold-the-line loop with a storylet-level `limit:` on outcomes.
Today `me2.sm.hold_the_line` is a `repeatable` auto storylet that kills one defender per firing.
It needs four supporting pieces:

- a counter variable, `story.me2.sm.htl_deaths_pending`, set by `me2.sm.final_battle`;
- a `-= 1` in every outcome;
- a `nobody_left` outcome that zeroes the counter when no defenders remain;
- a `pending == 0` guard on `me2.sm.shepard_fate`.

What the rule actually says is "the first N matches in this priority list die", with N computed.
`resolve: first` is already the N = 1 case. The 2026-11-09 review deferred this change because
CLAUDE.md says to extend the schema only when a game's structure forces it. The user has now
asked for it, which overrides that deferral.

## Semantics

- `limit: "<expr>"` sits on the storylet, next to `outcomes`. It is evaluated once, after the
  base effects and the choice's effects, and before any outcome. That is the same state the
  first outcome's `when` sees.
- Outcomes are then evaluated in order, as now, each against the state the previous ones left.
  Evaluation stops once `limit` outcomes have applied. Outcomes that don't match don't count.
- `limit` takes an expression or a YAML int. The value is truncated with `int()`, and anything
  below zero counts as 0. A non-numeric value is an error that names the storylet.
- `resolve: first` is still accepted. The loader turns it into `limit: 1`, so the engine,
  validator, graph and atlas only ever deal with `limit`. Giving both is a load error, and so is
  `limit` on a storylet without outcomes.

**Why the loop and a single limited pass are equivalent.** Each loop iteration applies the first
outcome that matches in the current state. A single pass never goes back to an outcome it has
already passed. So the two agree as long as applying an outcome never makes an *earlier*
outcome start matching. That holds here: outcomes only kill, which can only make
`me2.sm.defending.*` false, and loyalty doesn't change during the pass. So "disloyal in
priority order, then everyone in priority order" comes out the same both ways.

`nobody_left` never fired. `htl_deaths` is at most `htl_defenders`, and `final_battle` only kills
party members, who are never defenders.

**When `htl_deaths` is evaluated.** The new storylet evaluates it when `hold_the_line` fires, not
in `final_battle`. Nothing can happen between the two: the only autos ranked above priority 0
are the `me2.conflict.*` (10) and setup steps (≥ 90), and none can become available in that
window. A future auto beat placed in that window would break this.

## Steps

1. **Model/loader**:
   - Replace `Storylet.resolve` with `Storylet.limit: Node | None`. `resolve: first` becomes
     `parse(1)`.
   - Add the `limit` key and the load errors above.
   - Update the loader docstring.
2. **Engine** (`fire`): `cap = int(eval(limit))` when there is a limit, clamped at 0. Stop the
   outcome loop once `cap` outcomes have applied.
3. **Static analysis and exports**:
   - The limit expression is a read. Add it to `_iter_exprs` (`validate.py`) and `_reads`
     (`graph.py`).
   - Export it in `graph.to_json` and in `atlas.atlas_data`, which builds its own node dicts.
   - The atlas outcomes heading says "first N" when there is a limit.
4. **Content** (`content/me2/suicide_mission.yaml`):
   - `hold_the_line`: `requires: "seen(me2.sm.final_battle)"`, `limit: "me2.sm.htl_deaths"`.
     Remove `repeatable`, `resolve` and `nobody_left`, and the `-= 1` effects. Rewrite its
     summary and notes. It now fires even when nobody dies (the defence still happens).
   - `final_battle` loses the counter effect.
   - `shepard_fate` requires `seen(me2.sm.hold_the_line)`.
   - Delete `story.me2.sm.htl_deaths_pending`.
5. **Equivalence check** (a scratch script, not committed). Build pre-battle states directly
   with `engine.initial(overrides)`: random recruited, loyal and dead flags, party and escort
   picks, conflicts resolved. Then fire `final_battle` → hold-the-line → `shepard_fate` in the
   old content (from git) and in the new content, and compare the order of deaths and Shepard's
   fate. Assert that 0–3 hold-the-line deaths all occur. Coverage-guided states only reached 2.
   Don't compare seeded `storylet outcomes` runs between versions: fewer steps consume less RNG
   and shift the coverage weights.
6. **Tests**:
   - Engine: `limit` stops after N applied outcomes, unmatched outcomes don't count, the limit
     expression is read from state, limit 0, and the load errors.
   - Engine: a `repeatable` test, since the feature loses its only content user and was
     untested.
   - Trilogy: a weak defence where the limit is larger than the number of disloyal defenders, so
     the pass crosses into the loyal list. A strong defence: nobody dies and `shepard_fate`
     follows.
7. **Docs**:
   - `schema-evolution.md`: keep the v2 "Repeatable outcome loops" row and mark it
     superseded. Add an entry for `limit`, including that the user asked for it.
   - `porting-guide.md`: mention `limit`.
   - `README.md`: `story.*` count 49 → 48.
   - 2026-11-09 plan: mark the Deferred entry as done.

## Risks / open questions

- `chose(me2.sm.hold_the_line, X_falls)` still works: outcomes are recorded in `chosen` as before.
  Nothing reads them today.

## Review

A fresh-context agent read only this plan and the code it points to. Findings and resolutions:

- **The equivalence argument was wrong** (should-fix). What makes it hold is "applying an outcome
  never re-enables an earlier one", not "an applied outcome stops matching". `nobody_left` never
  fired. Moving when `htl_deaths` is evaluated is safe because nothing can happen in that
  window. *Resolved:* the Semantics section is rewritten.
- **The new `requires` and summary for `hold_the_line` were unspecified** (should-fix).
  *Resolved:* step 4.
- **The atlas doesn't read `graph.to_json`** (should-fix). *Resolved:* both are exported, plus
  the outcomes heading (step 3).
- **`repeatable` would have no users and no tests** (should-fix). *Resolved:* an engine test was
  added. The feature stays.
- **README count, keeping the v2 row, recording the user override** (should-fix/nit).
  *Resolved:* step 7.
- **A simpler design: the loader turns `resolve: first` into `limit: 1`, with one engine path**
  (should-fix). *Resolved:* adopted (steps 1–2). `parse` is used for the limit rather than the
  list-ANDing `requires` helper. A YAML int is accepted, and non-numeric values raise an error.
- **The coverage-guided equivalence check misses the 3-death and crossing cases** (should-fix).
  This was confirmed: a dry run of the harness reached at most 2 deaths in 401 states.
  *Resolved:* states are constructed directly, every death count must occur, and seeded
  distributions are not compared (step 5).
- **Tests for crossing into the loyal list, limit 0, and the `resolve` + `limit` error**
  (should-fix). *Resolved:* step 6.

## Status

Done. `python -m unittest` passes (35 tests). `storylet validate` reports 0 errors and 1 warning
(`me2.sm.choose_party2/none`, which was already there).

- [x] 1 model/loader: `Storylet.limit` replaces `Storylet.resolve`.
- [x] 2 engine: `Engine.outcome_limit`.
- [x] 3 static analysis and exports: validator, graph edges, `graph.to_json` `limit`, atlas `lim`
  and the outcomes heading.
- [x] 4 content.
- [x] 5 equivalence check. 20,000 constructed states, 0 differences. Hold-the-line deaths:
  0: 5412, 1: 8481, 2: 6065, 3: 42. In 372 states the pass ran out of disloyal defenders and
  continued into the full list.
- [x] 6 tests.
- [x] 7 docs.
