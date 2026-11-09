# CLAUDE.md

Extract the Mass Effect LE trilogy's narrative graph from BioWare's plot databases and port it to
a storylet system that evolves as each game is ported. Start with `README.md`;
`docs/schema-evolution.md` explains why the schema looks the way it does.

## Layout

- `src/meplot/`: extraction from the plot databases (fetch, catalog, plot graph, outlines, `bind`).
- `src/storylet/`: game-agnostic engine (expression language, loader, engine, validator, graph, atlas).
- `content/`: storylet YAML per game (`me1/`, `me2/`, `me3/`) plus `campaign.yaml`.
- `tests/`: unittest. Catalog tests skip unless `meplot fetch` has been run.
- `build/`: generated output, gitignored. Never commit plot-database data or anything derived
  wholesale from it (see `docs/data-sources.md`).

## Checks before committing

```sh
python -m unittest discover -s tests
storylet validate          # must report 0 errors
```

## Rules

### Temporary comments

Any temporary comment (debug notes, reminders, scaffolding to remove later) must start with
`claudenote:` so it can be found and stripped mechanically:

```python
# claudenote: remove once Shiala's ME1 variable is located
```

```yaml
# claudenote: values below are placeholders until the asset table is checked
```

Before finishing a task, list leftovers with `grep -rn "claudenote:" src content tests docs`.
Permanent explanatory comments do not use the prefix.

### Debugging guide

Keep `docs/debugging.md` up to date as a running guide. When you diagnose a non-obvious problem
(a misleading validator warning, an engine quirk, a data surprise in the plot databases), add an
entry: the symptom, how it was found, the cause and the fix. Update entries that turn out to be
wrong instead of appending contradictions.

### Docs

- All documentation goes in `docs/`. The only Markdown files outside it are `README.md` and this file.
- Don't copy styling between docs. Write each doc in the structure and format its own content
  calls for, instead of mirroring another doc's headings, tables or layout.

### Plans

- Plans go in `docs/plans/`, one file per plan, named `YYYY-MM-DD-short-topic.md`.
- Plans are saved in the repo: commit the plan file, and keep it updated as the work proceeds
  (status, decisions changed along the way).
- Before acting on a plan, pressure-test it with an agent that has fresh context. Spawn a
  subagent that has not seen the planning conversation. Give it only the plan file and pointers
  to the relevant code and docs, and ask it to find wrong assumptions, missing steps, risks and
  simpler alternatives. Record its findings, and how each was resolved, in a "Review" section of
  the plan before starting the work.

## Conventions that matter

- Bind storylet variables to canonical plot refs with their path (`meplot bind`). Prefer
  lifting BioWare's conditionals verbatim over re-deriving rules.
- When no plot variable exists yet, use a documented `story.*` variable, and put every
  modeling simplification in the storylet's `notes`.
- Extend the schema only when a game's structure forces it, and record the change in
  `docs/schema-evolution.md`.
- Don't put model identifiers in commits or other repository content.
