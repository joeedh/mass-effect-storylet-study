# Port the Python code to TypeScript

## Goal

Replace the Python implementation (`src/meplot`, `src/storylet`, `tests/`) with TypeScript, for
the stronger type checking. The user asked for this and chose the toolchain:

- pnpm, the latest TypeScript (7.x, the native compiler), and the `lintrix` linter.
- A unit test framework of our choosing.

Content YAML, the atlas HTML template and the docs' substance don't change. The CLI commands,
their options and their output stay the same, apart from the deviations listed below.

## Toolchain decisions

- **Run TypeScript directly with Node 24's type stripping.** There is no build step, and `tsc`
  only type-checks (`noEmit`). This needs erasable syntax only (no enums, namespaces or parameter
  properties), `.ts` extensions in imports and `import type` for types. These tsconfig options
  enforce that: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`.
- **Strict typing:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`. TS 7 defaults `types`
  to `[]`, so the config sets `"types": ["node"]` and installs `@types/node`.
- **Tests: `node:test`** (changed from Vitest after review). It runs the same type stripping as
  the CLI, so tests can't pass on syntax the CLI rejects. It needs no dependency, and
  `node:assert`'s `deepStrictEqual` diffs Sets and Maps. The catalog tests use `{ skip }` when
  `build/plotdb` is missing. Run with `node --test "tests/**/*.test.ts"`.
- **Runtime dependencies:**
  - `yaml` with `version: "1.1"`, to match PyYAML's `safe_load`.
  - `commander`, for subcommand CLIs like argparse.
  - `fflate`, to unzip the plot databases.
  - Hashing and HTTP come from `node:crypto` and the global `fetch`.
- **Commands:** `pnpm meplot …` and `pnpm storylet …` are package.json scripts that run
  `node src/<pkg>/cli.ts`. `pnpm test`, `pnpm typecheck` and `pnpm lint` cover the checks.
  CLAUDE.md's pre-commit checks become `pnpm typecheck && pnpm lint && pnpm test &&
  pnpm storylet validate`.
- **Linting:** `lintrix:recommended` (which includes `no-unsafe-*`), plus
  `strict-boolean-expressions` and `no-floating-promises`. The config sets `project` to
  `tsconfig.json`.
  - The npm package lints through WASM, and WASM silently skips every type-aware rule. Verified:
    an `any` member access passed through WASM and was caught with a native binary on PATH.
  - `pnpm lint` therefore runs `lintrix --engine native`, which fails loudly when no native
    `lintrix` is on PATH, instead of passing without type checks.
  - The binary's location is machine-specific (`C:\dev\fastlint\build\release\bin`), so it goes
    on PATH, not into the committed config. The docs say so.
  - Any rule left off gets a reason in the config.

## Layout

The files keep their names, so history and docs still map one to one:

- `src/meplot/*.ts` replaces `src/meplot/*.py`.
- `src/storylet/*.ts` replaces `src/storylet/*.py`; `atlas_template.html` stays.
- `tests/*.test.ts` replaces `tests/test_*.py`.
- New files:
  - `src/storylet/pyrandom.ts` (see below).
  - `src/storylet/pycompat.ts`: Python value semantics, plus `repr` for messages.
- `package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `lintrix.config.json` replace
  `pyproject.toml`. `.gitignore` gains `node_modules/` and `.lintrix.native.json`.

## Semantics that have to be carried over deliberately

These are the places where a line-by-line translation would silently change behaviour.

- **Expression values** are `boolean | number | string`. Python's int and float both become JS
  numbers. The places where Python's rules differ from JS get explicit helpers:
  - `==`/`!=`: bool and number compare numerically (`true == 1`); everything else is strict.
  - `+`, `-`, `*`, `/`, `%`, unary `-` work on numbers and bools.
    - `+` also joins two strings.
    - `*` also repeats a string by an integer.
    - `<`, `<=`, `>`, `>=` also compare two strings.
    - Any other mix of types throws, as Python raises `TypeError`.
  - `/` or `%` by zero throws, like Python. `%` is floored, as in Python.
  - `&&` and `||` return bools, not an operand.
  - `int()` truncates; it accepts bools and integer strings and throws on anything else.
  - `sum()` starts at 0, so summing strings throws.
  - `min()`/`max()` need at least two arguments. They return the first extreme element, strings
    included.
  - Truthiness is Python's for these primitive types, which matches JS except that `NaN` is
    truthy.
- **Errors:**
  - `ValueError` and `ExprError extends ValueError` mirror Python's classes, because tests assert
    on `ValueError`.
  - Python's `TypeError` and `ZeroDivisionError` become `PyTypeError`, which is not an
    `ExprError`.
  - Every `catch` that Python wrote as `except ExprError` rethrows anything else.
- **State copying:** `State` holds `ReadonlyMap`/`ReadonlySet`, and `fire` never mutates its
  input.
  - Effects run on `new Map(state.values)`.
  - `fired` and `chosen` are replaced by new sets.
  - As in Python, effect expressions read the in-progress values. `seen()`/`chose()` read `mid`,
    which already includes this storylet and its choice.
- **Formatting:**
  - `%5.1f`, and the atlas's `round(x, 3)`, round half to even. `toFixed` rounds half up, so a
    `pycompat` formatter does this instead.
  - f-strings of `None` print `None` (`arg=None` in outlines).
  - The Python reads `raw.get(k, d)` return `None` for a key that is present with a null value.
    A helper keeps that difference; `??` would lose it.
  - `meplot build` prints its stats as a Python dict repr.
- **Equality of state values:** `_pack` drops values equal to the default by Python `==`
  (`0 == False`). The `outcomes` histogram merges `true`, `1` and `1.0` into one key, as
  Python's `Counter` does, and labels it with the first value seen.
- **AST:** a discriminated union (`lit`, `name`, `call`, `not`, `neg`, binary, `?:`) instead of
  Python's generic `Node(op, args, value)`. The id arguments of `seen()`/`chose()`/`total()` are
  read through one helper that accepts a name or a string literal. Anything else is rejected,
  which the validator already does.
- **State identity:** Python hashes the frozen `State` dataclass. TS gives each `State` a
  canonical string key: sorted values, sorted `fired`, sorted `chosen`. `explore()` dedupes on
  that key. A `chosen` entry is a `(storylet, choice)` pair. It is stored as one string with a
  non-printing separator, and `State.hasChosen(sid, cid)` / `State.chosenPairs()` read it back.
- **Ordering:**
  - `dict` becomes `Map`, never a plain object, wherever keys come from data. Plain objects put
    integer-like keys first; plot element ids are integers.
  - `sorted()` on tuples becomes an explicit lexicographic comparator. Strings compare by code
    unit, never `localeCompare`.
  - `load_content` sorts YAML files the way Python sorts `Path`s: part by part, and
    case-insensitively on Windows. File order is storylet order, and storylet order breaks
    priority ties. Today all names are lowercase.
- **Random numbers:** `pyrandom.ts` ports CPython's Mersenne Twister: `init_by_array` seeding
  for integer seeds, `random()`, `getrandbits`, `_randbelow`, `choice()` and the
  `choices(weights)` bisect. The same seed then gives the same playthroughs. That keeps the
  `--seed` examples in the docs valid and makes validator output diffable against Python. The
  first values for a few seeds are checked against vectors captured from CPython.
- **YAML:** compare the parsed form of every content file (as JSON) between PyYAML and `yaml`
  with the 1.1 schema before relying on it.
  - Watch for `y`/`n` booleans, duplicate keys and dates. For dates, PyYAML's side needs
    `default=str`.
  - Anchors such as `foreach: *roster` share one object, so the loader copies a mapping before
    it pops keys, as Python's `dict(spec)` does.
- **Catalog JSON scalars** (checked against the fetched data):
  - `label`, `argument` and `code` are always strings or null, so `str()` versus `String()`
    never comes up.
  - `elementid`, `parentelementid` and `type` are sometimes integer strings.
  - About half the `sequence` values are fractional floats (27,698 of them, such as 193.75).
    Python's `_num` calls `int()` on them, which truncates (`int(193.75) == 193`). 2,163
    parents end up with tied sequences, and their children fall back to element-id order.
  - The port replicates this with `Math.trunc`, so outlines can be compared byte for byte. It
    is reported to the user as a probable bug to fix separately.
- **Messages** keep Python's `repr()` style for strings and lists (`'nope'`, `['a', 'b']`).
  Tests and the debugging guide quote them.

## Intended deviations

These are documented in the commit and in `docs/debugging.md` where they matter:

- Bools print as `true`/`false` (the expression language's spelling) instead of `True`/`False`,
  in `storylet outcomes` and in messages.
- Whole-number floats print without `.0`.
- Content source names use `/` on every platform (Python printed `me1\x.yaml` on Windows).
- JSON outputs (`build/catalog.json`, `plotgraph.json`, `graph --format json`) don't escape
  non-ASCII. `catalog.json` is compact rather than Python's `indent=0`. Nothing reads these
  files except people.
- `storylet graph` sorts edges by the full edge, not just `(src, dst, via)`. Python's order for
  edges tied on those three fields depended on string hash randomization.
- **Bug fix:** `_filter` (cli.py:65) never copies `conditions`. `storylet graph --game` therefore
  loses every edge through a named condition. `explore --game` hides the bug only because the
  filter also removes `campaign.start`, so nothing is ever available. A regression test covers
  the fix.
- Malformed YAML shapes (a choice without an `id`, a non-mapping storylet) become load errors
  instead of Python `KeyError`/`AttributeError` crashes. The loader narrows `unknown` input, so
  this falls out of the types.
- YAML scalars interpolated into expressions (requires lists, trait parameters) use the
  expression language's spelling (`true`), not Python's `str()` (`True`).
- **CLI parsing:**
  - commander doesn't accept argparse's abbreviated long options (`--max` for
    `--max-states`).
  - Usage errors still exit with code 2.
- `meplot find` patterns are JavaScript regexes. Python-only syntax such as `(?P<name>…)` is
  rejected.
- `meplot fetch` uses Node's `fetch`, which ignores `HTTP(S)_PROXY` (Python's `urllib`
  honoured it).

## Steps

1. **Baseline.** Create a scratch venv with PyYAML and run `meplot fetch`. Capture Python output
   for every command (list below) into the scratchpad. Nothing from this is committed: it is
   derived from the plot data.
2. **Scaffold.** Add `package.json` (`"type": "module"`, `engines.node >= 24`), the tsconfig,
   the lintrix config and `.gitignore`. Run `pnpm install`.
   - pnpm runs scripts from the package root, so the CLIs resolve relative path arguments
     (`-o`, `--content`) against `INIT_CWD` when pnpm sets it.
   - Check whether pnpm prints a banner on stdout. If it does, the docs use `pnpm -s` wherever
     output is piped.
   - Check the zip's compression method before relying on `fflate`.
3. **storylet core**, in dependency order:
   - `pycompat`, `pyrandom`, `expr`, `model`, `loader`, `engine`, `validate`, `graph`,
     `atlas`, `porting`, `cli`.
   - Port the engine tests as each module lands.
4. **meplot:** `catalog`, `graph`, `outline`, `fetch`, `cli`. Then the catalog tests.
5. **Parity check.** A scratch script runs both implementations and diffs them. Remaining
   differences must all be listed under "Intended deviations".
   - The script calls `node` directly, not through pnpm.
   - Python runs with `PYTHONHASHSEED=0`.
   - The commands compared:
   - `storylet validate -v` (with and without the catalog, `--runs 300`)
   - `simulate --seed {0,3,4} --state`, `simulate --choose …`, `available --set …`
   - `explore --max-states 2000`
   - `outcomes --start {me1,me2,me3} --runs 500`
   - `graph --format {dot,mermaid,json}` and `--max-writers 6`
   - `coverage`
   - the atlas data, compared parsed, with `x` within 0.001
   - `meplot build`: `catalog.json` and `plotgraph.json` compared parsed; outlines and
     `anomalies.txt` byte for byte
   - `meplot find/show/resolve/bind/outline` on the README and porting-guide examples
6. **Remove Python:** `src/**/*.py`, `tests/*.py` and `pyproject.toml`.
7. **Docs:**
   - `README.md` quick start.
   - `CLAUDE.md`: layout, checks, and the `claudenote` grep (add `.ts`).
   - `docs/porting-guide.md`: commands, and its `python3 -` heredoc snippet, rewritten as a
     `node -e` / `.ts` snippet.
   - `docs/debugging.md`: the Python snippet, and an entry for each semantic trap that bit
     during the port.
   - `docs/data-sources.md`: the `fetch.py` path.
   - `docs/schema-evolution.md`: test paths.
   - Historical plans stay as written.
8. **Checks:** `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm storylet validate` with 0
   errors. Grep for `claudenote:`. Commit on the `typescript-port` branch.

## Risks / open questions

- TypeScript 7 is the Go-native compiler. The options above exist in 5.x. If 7.x drops or
  renames one, adjust and note it here.
- lintrix is young (0.1.x), and its type-aware rules need `tsc --api` from the TS 7 install.
  If a rule misbehaves on valid code, turn it off with a reason. Don't contort the code to
  satisfy it. Custom rules are out of scope unless something specific calls for one.
- TS 7.0.2's API server crashes when serializing an empty tuple type (microsoft/typescript-go#64080;
  see fastlint docs/tsgo-client.md). If lintrix reports "type query failed", that is the likely
  cause.
- The Python test count is 35. The TS suite should cover the same cases, plus `pyrandom` vectors
  (captured from CPython 3.15.1), the `pycompat` helpers and the `_filter` regression.

## Review

A fresh-context agent read only this plan, the Python source and the lintrix docs. Findings and
how each was resolved:

- **Must-fix: the npm lintrix lints through WASM, which skips type-aware rules silently.**
  *Resolved:* `pnpm lint` runs `--engine native` with the native binary on PATH. This was
  verified in a scratch project (Toolchain decisions).
- **Must-fix: TS 7 defaults `types` to `[]`.** *Resolved:* `"types": ["node"]`, `@types/node`,
  and `module`/`moduleResolution` set to `nodenext`.
- **Must-fix: the plan didn't say how `fire` copies state.** *Resolved:* the "State copying"
  bullet.
- **Must-fix: the `_num` truncation is real.** *Resolved:* it is replicated, and reported to the
  user as a probable bug (Catalog JSON scalars).
- **Should-fix: Python equality in `_pack` and in the `outcomes` Counter.** *Resolved:* the
  "Equality of state values" bullet.
- **Should-fix: `%5.1f` rounds half to even.** *Resolved:* a pycompat formatter.
- **Should-fix: `None` in f-strings, YAML scalars through `str()`, `raw.get` with nulls.**
  *Resolved:* the Formatting bullets and a deviation entry.
- **Should-fix: YAML anchors shared between entries, `y`/`n`, duplicate keys, dates.**
  *Resolved:* the YAML bullets. The comparison runs in step 3, before the loader is trusted.
- **Should-fix: pnpm's banner and working directory.** *Resolved:* step 2. Parity runs call
  `node` directly.
- **Should-fix: the exception hierarchy, and catch-alls swallowing real bugs.** *Resolved:* the
  Errors bullet.
- **Should-fix: argparse versus commander.** *Resolved:* listed as deviations. Usage errors keep
  exit code 2.
- **Should-fix: string `<`, `str * int`, `min`/`max` on strings, `&&`/`||` returning bools,
  `sum` starting at 0.** *Resolved:* the Expression values bullet now supports or specifies each.
- **Nit: an empty-tuple crash in TS 7.0.2's API.** Noted under Risks.
- **Nit: `consistent-type-imports` duplicates `verbatimModuleSyntax`.** Dropped.
- **Nit: `node:test` avoids the syntax mismatch between Vitest and Node.** Adopted.
- **Nit: fflate supports only some compression methods; `fetch` ignores proxies.** Step 2, and
  a deviation entry.
- **Nit: use `process.exitCode`, not `process.exit()`.** Adopted, so piped output isn't cut off.
- **Nit: JS regexes in `find`, and the dict repr printed by `build`.** Listed as a deviation and
  under Formatting.
- **Nit: confirm the Path sort order and record the CPython version.** Both verified (3.15.1).
- **Nit: the `_filter` bug needs a regression test, not a confirmation step.** Adopted.
- **Nit: run the Python side with `PYTHONHASHSEED=0`.** Adopted (step 5).

## Status

- [x] 1 baseline (outputs in the session scratchpad, not committed)
- [ ] 2 scaffold
- [ ] 3 storylet core
- [ ] 4 meplot
- [ ] 5 parity check
- [ ] 6 remove Python
- [ ] 7 docs
- [ ] 8 checks and commit
