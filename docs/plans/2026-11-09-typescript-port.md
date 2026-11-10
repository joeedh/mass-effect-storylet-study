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
  `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`.
- **Tests: Vitest.** It gives readable deep-equality diffs for Sets and Maps, `describe.skipIf` for
  the catalog tests, and watch mode. `node:test` would avoid the dependency, but its assertion
  output is weaker. Vitest transforms TS itself, so the tsconfig settings above are what keep test
  code and CLI code within the same syntax.
- **Runtime dependencies:**
  - `yaml` with `version: "1.1"`, to match PyYAML's `safe_load`.
  - `commander`, for subcommand CLIs like argparse.
  - `fflate`, to unzip the plot databases.
  - Hashing and HTTP come from `node:crypto` and the global `fetch`.
- **Commands:** `pnpm meplot …` and `pnpm storylet …` are package.json scripts that run
  `node src/<pkg>/cli.ts`. `pnpm test`, `pnpm typecheck` and `pnpm lint` cover the checks.
  CLAUDE.md's pre-commit checks become `pnpm typecheck && pnpm lint && pnpm test &&
  pnpm storylet validate`.
- **Linting:** `lintrix:recommended`, plus the type-aware rules that suit a strictly typed
  codebase (`no-unsafe-*`, `strict-boolean-expressions`, `no-floating-promises`,
  `consistent-type-imports`). The final set is whatever runs cleanly; any rule left off gets a
  reason in the config.

## Layout

The files keep their names, so history and docs still map one to one:

- `src/meplot/*.ts` replaces `src/meplot/*.py`.
- `src/storylet/*.ts` replaces `src/storylet/*.py`; `atlas_template.html` stays.
- `tests/*.test.ts` replaces `tests/test_*.py`.
- New files:
  - `src/storylet/pyrandom.ts` (see below).
  - `src/storylet/pycompat.ts`: Python value semantics, plus `repr` for messages.
- `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `lintrix.config.json` and
  `vitest.config.ts` replace `pyproject.toml`. `.gitignore` gains `node_modules/`.

## Semantics that have to be carried over deliberately

These are the places where a line-by-line translation would silently change behaviour.

- **Expression values** are `boolean | number | string`. Python's int and float both become JS
  numbers. The places where Python's rules differ from JS get explicit helpers:
  - `==`/`!=`: bool and number compare numerically (`true == 1`); everything else is strict.
  - `<`, `+`, `-`, `*`, `/`, `%`, unary `-`: numbers and bools only, except `+` on two strings.
    Mixed types throw, as Python raises `TypeError`.
  - `/` or `%` by zero throws, like Python. `%` is floored, as in Python.
  - `int()` truncates; it accepts bools and integer strings and throws on anything else.
  - `min()`/`max()` need at least two arguments and return the first extreme element.
  - Truthiness is Python's for these primitive types, which is the same as JS's except for `NaN`.
    `NaN` can't arise once division by zero throws.
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
- **Catalog JSON scalars:** `str()` of a JSON bool or float differs from JS `String()`
  (`True`/`true`, `1.0`/`1`). Before porting `GameDB`, check the plot databases for non-string
  `label`/`argument` values and for float `sequence` values. Python's `_num` truncates float
  numbers, `int(1.5) == 1`, but parses float strings as floats. Replicate whatever the data
  actually contains.
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
- **Bug fix:** `storylet explore --game` and `storylet graph --game` dropped `conditions` from the
  filtered content. Any requires that used a named condition then failed with "unknown
  variable". Confirm this against Python before fixing it.
- Malformed YAML shapes (a choice without an `id`, a non-mapping storylet) become load errors
  instead of Python `KeyError`/`AttributeError` crashes. The loader narrows `unknown` input, so
  this falls out of the types.

## Steps

1. **Baseline.** Create a scratch venv with PyYAML and run `meplot fetch`. Capture Python output
   for every command (list below) into the scratchpad. Nothing from this is committed: it is
   derived from the plot data.
2. **Scaffold.** Add `package.json` (`"type": "module"`, `engines.node >= 24`), the tsconfig,
   the lintrix and Vitest configs, and `.gitignore`. Run `pnpm install`.
3. **storylet core**, in dependency order:
   - `pycompat`, `pyrandom`, `expr`, `model`, `loader`, `engine`, `validate`, `graph`,
     `atlas`, `porting`, `cli`.
   - Port the engine tests as each module lands.
4. **meplot:** `catalog`, `graph`, `outline`, `fetch`, `cli`. Then the catalog tests.
5. **Parity check.** A scratch script runs both implementations and diffs them. Remaining
   differences must all be listed under "Intended deviations".
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
- The Python test count is 35. The TS suite should cover the same cases, plus `pyrandom`
  vectors and the `pycompat` helpers.
- Vitest's own transform and Node's type stripping could disagree on some syntax. `tsc` with
  `erasableSyntaxOnly` should catch that before either runs.

## Review

(to be filled in by a fresh-context review before work starts)

## Status

- [ ] 1 baseline
- [ ] 2 scaffold
- [ ] 3 storylet core
- [ ] 4 meplot
- [ ] 5 parity check
- [ ] 6 remove Python
- [ ] 7 docs
- [ ] 8 checks and commit
