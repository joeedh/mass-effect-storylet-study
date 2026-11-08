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
