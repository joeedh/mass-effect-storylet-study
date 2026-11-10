import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Engine } from "../src/storylet/engine.ts";
import { ExprError, evaluate, parse, parseEffect, show } from "../src/storylet/expr.ts";
import { YAML_OPTIONS, loadContent } from "../src/storylet/loader.ts";
import { parse as parseYaml } from "yaml";
import { PyRandom } from "../src/storylet/pyrandom.ts";
import { ValueError } from "../src/storylet/pycompat.ts";
import type { Value } from "../src/storylet/pycompat.ts";
import { validate } from "../src/storylet/validate.ts";
import { ROOT, contentFrom } from "./helpers.ts";
import path from "node:path";

describe("expressions", () => {
  const ev = (src: string, env: Record<string, Value> = {}): Value =>
    evaluate(parse(src), (n) => {
      const v = env[n.replaceAll(".", "_")];
      if (v === undefined) throw new Error(`no ${n}`);
      return v;
    });

  it("parses BioWare's conditional syntax", () => {
    // Shape of real plot-DB conditionals after PE{n} -> canonical ref rewriting.
    const src = "me1.bool.1 == true && (me1.bool.2 || me1.bool.3 ) && me1.int.4 >= 2";
    assert.equal(ev(src, { me1_bool_1: true, me1_bool_2: false, me1_bool_3: true, me1_int_4: 2 }), true);
    assert.equal(ev(src, { me1_bool_1: true, me1_bool_2: false, me1_bool_3: false, me1_int_4: 2 }), false);
  });

  it("follows precedence, and the ternary", () => {
    assert.equal(ev("1 + 2 * 3"), 7);
    assert.equal(ev("!false && 1 < 2 || false"), true);
    assert.equal(ev("a > 1 ? 10 : 20", { a: 3 }), 10);
    assert.equal(ev("count(true, false, 1 == 1)"), 2);
  });

  it("prints a canonical form that parses back to itself", () => {
    for (const src of ["a && !b || c == 3", "count(a, b) >= 2 ? x : -y", "seen(me1.x.y)"]) {
      const node = parse(src);
      assert.equal(show(parse(show(node))), show(node));
    }
  });

  it("parses effects", () => {
    const e = parseEffect("me1.player.paragon += 2");
    assert.deepEqual([e.target, e.op], ["me1.player.paragon", "+="]);
    assert.throws(() => parseEffect("a == b"), ExprError);
    assert.throws(() => parse("a &&"), ExprError);
  });

  it("keeps Python's value semantics", () => {
    assert.equal(ev("true == 1"), true); // bools are numbers
    assert.equal(ev("-7 % 3"), 2); // floored modulo
    assert.equal(ev("'ab' * 2"), "abab");
    assert.equal(ev("max('a', 'b')"), "b");
    assert.equal(ev("1 && 2"), true); // && returns a bool, not an operand
    assert.throws(() => ev("1 / 0"));
    assert.throws(() => ev("'a' < 1"));
    assert.throws(() => ev("sum('a', 'b')"));
  });
});

const SMALL = `
  game: me1
  area: test
  conditions:
    done_at_least: "(argument == 1 && (a || b)) || (argument == 2 && a && b)"
  vars:
    a: me1.bool.1
    b: me1.bool.2
    story.counter: {type: int, default: 5}
  storylets:
    - id: start
      trigger: auto
      requires: "!a"
      choices:
        - {id: left, effects: ["a = true", "story.counter += 1"]}
        - {id: right, effects: ["a = true", "story.counter -= 1"]}
    - id: second
      requires: "seen(start) && !b"
      effects: ["b = true"]
    - id: finale
      trigger: auto
      requires: "done_at_least(2) && chose(start, left) && !seen(finale)"
`;

describe("engine", () => {
  const setup = () => {
    const c = contentFrom(SMALL);
    assert.deepEqual(c.errors, []);
    return new Engine(c);
  };

  it("fires storylets and choices", () => {
    const e = setup();
    const s0 = e.initial();
    assert.deepEqual(e.available(s0).map((s) => s.id), ["start"]);
    assert.throws(() => e.fire(s0, "start"), ValueError); // two choices available, none given
    const s1 = e.fire(s0, "start", "left");
    assert.equal(e.get(s1, "story.counter"), 6);
    assert.deepEqual(e.available(s1).map((s) => s.id), ["second"]);
    const s2 = e.fire(s1, "second");
    assert.deepEqual(e.available(s2).map((s) => s.id), ["finale"]);
  });

  it("never changes the state it fires from", () => {
    const e = setup();
    const s0 = e.initial();
    const before = s0.key;
    e.fire(s0, "start", "left");
    assert.equal(s0.key, before);
    assert.equal(s0.fired.size, 0);
  });

  it("calls conditions that take an argument", () => {
    const e = setup();
    const s = e.initial({ a: true });
    assert.equal(e.eval(parse("done_at_least(1) && !done_at_least(2)"), s), true);
  });

  it("explores every state", () => {
    const ex = setup().explore();
    assert.equal(ex.truncated, false);
    assert.deepEqual(ex.fired, new Set(["start", "second", "finale"]));
    assert.equal(ex.terminals.size, 2); // left (finale fired) / right
  });

  it("drops a value equal to the default by Python equality", () => {
    const e = setup();
    assert.deepEqual(e.initial({ a: 0 }).values, []); // 0 == false
  });

  it("validator catches unknown names", () => {
    const bad = contentFrom(`
      storylets:
        - id: x
          requires: "nope && seen(ghost)"
          effects: ["also_nope = true"]
    `);
    const text = validate(bad, null, 0).errors.join("\n");
    assert.match(text, /unknown variable 'nope'/);
    assert.match(text, /unknown storylet 'ghost'/);
    assert.match(text, /also_nope/);
  });
});

const V2 = `
  vars:
    story.game: {type: int}
    story.role: {type: enum, values: [a, b]}
    x: me1.bool.1
    y: me2.bool.2
    story.n: {type: int}
  traits:
    counted: {effects: ["story.n += 1"]}
  storylets:
    - id: start
      kind: bridge
      trigger: auto
      requires: "story.game == 0"
      effects: ["story.game = 1"]
    - id: one
      game: me1
      traits: [counted]
      requires: "!x"
      effects: ["x = true"]
    - id: bridge
      kind: bridge
      trigger: auto
      requires: "story.game == 1 && x"
      effects: ["story.game = 2"]
    - foreach: [{r: a}, {r: b}]
      id: pick_{r}
      game: me2
      requires: "story.role == ''"
      effects: ["story.role = '{r}'"]
    - id: rules
      game: me2
      trigger: auto
      resolve: first
      requires: "story.role != '' && !seen(rules)"
      outcomes:
        - {id: is_a, when: "story.role == 'a'", effects: ["y = true"]}
        - {id: always, when: "true", effects: ["story.n += 10"]}
    - id: fallback
      game: me2
      trigger: idle
      requires: "seen(rules)"
`;

describe("schema v2", () => {
  it("gates by game, bridges, applies traits, expands templates and resolves outcomes", () => {
    const c = contentFrom(V2);
    assert.deepEqual(c.errors, []);
    const e = new Engine(c);
    let s = e.fire(e.initial(), "start");
    assert.deepEqual(e.available(s).map((x) => x.id), ["one"]); // me2 storylets gated off
    s = e.fire(s, "one");
    assert.equal(e.get(s, "story.n"), 1); // trait effect
    s = e.fire(s, "bridge");
    assert.deepEqual(e.available(s).map((x) => x.id).sort(), ["pick_a", "pick_b"]); // foreach
    const a = e.fire(e.fire(s, "pick_a"), "rules");
    assert.equal(e.get(a, "y"), true);
    assert.equal(e.get(a, "story.n"), 1); // resolve: first stops at is_a
    assert.ok(a.chosen.has(["rules", "is_a"]));
    const b = e.fire(e.fire(s, "pick_b"), "rules");
    assert.equal(e.get(b, "story.n"), 11);
    assert.deepEqual(e.stepOptions(b).map(([x]) => x.id), ["fallback"]); // idle only when nothing else
  });

  it("rejects an enum value that isn't a member", () => {
    const c = contentFrom(V2.replace("story.role = '{r}'", "story.role = 'c'"));
    const e = new Engine(c);
    const s = e.fire(e.fire(e.fire(e.initial(), "start"), "one"), "bridge");
    assert.throws(() => e.fire(s, "pick_a"), ValueError);
  });
});

const LIMITED = `
  vars: {a: me1.bool.1, b: me1.bool.2, c: me1.bool.3, story.n: {type: int, default: 2}, story.k: {type: int}}
  storylets:
    - id: s
      trigger: auto
      limit: "story.n"
      outcomes:
        - {id: never, when: "false", effects: ["story.k += 100"]}
        - {id: oa, when: "!a", effects: ["a = true", "story.k += 1"]}
        - {id: ob, when: "!b", effects: ["b = true", "story.k += 1"]}
        - {id: oc, when: "!c", effects: ["c = true", "story.k += 1"]}
    - id: tick
      trigger: auto
      repeatable: true
      requires: "seen(s) && story.k < 5"
      effects: ["story.k += 1"]
`;

describe("outcome limit", () => {
  const setup = () => {
    const c = contentFrom(LIMITED);
    assert.deepEqual(c.errors, []);
    return new Engine(c);
  };
  const applied = (e: Engine, n: Value): [string[], Value] => {
    const s = e.fire(e.initial({ "story.n": n }), "s");
    return [[...s.chosen].map(([, c]) => c).sort(), e.get(s, "story.k")];
  };

  it("counts applied outcomes only", () => {
    const e = setup();
    assert.deepEqual(applied(e, 2), [["oa", "ob"], 2]); // 'never' didn't match, so didn't count
    assert.deepEqual(applied(e, 5), [["oa", "ob", "oc"], 3]);
    assert.deepEqual(applied(e, 0), [[], 0]);
    assert.deepEqual(applied(e, -1), [[], 0]);
    assert.deepEqual(applied(e, 1.9), [["oa"], 1]); // int() truncates
  });

  it("must be numeric", () => {
    const e = setup();
    assert.throws(() => e.fire(e.initial({ "story.n": "x" }), "s"), ExprError);
  });

  it("is what resolve: first loads as", () => {
    const c = contentFrom(`
      vars: {a: me1.bool.1}
      storylets:
        - {id: s, resolve: first, outcomes: [{id: x, when: "true"}, {id: y, when: "true"}]}
    `);
    const limit = c.storylets.get("s")?.limit;
    assert.ok(limit);
    assert.equal(show(limit), "1");
    const e = new Engine(c);
    assert.deepEqual([...e.fire(e.initial(), "s").chosen], [["s", "x"]]);
  });

  it("reports load errors", () => {
    const c = contentFrom(`
      storylets:
        - {id: both, resolve: first, limit: 2, outcomes: [{id: x, when: "true"}]}
        - {id: bare, limit: 2}
    `);
    const text = c.errors.join("\n");
    assert.match(text, /both: give either resolve: first or limit/);
    assert.match(text, /bare: limit applies to outcomes/);
  });

  it("lets a repeatable storylet fire until its requires fails", () => {
    const e = setup();
    const t = e.run(e.initial());
    assert.deepEqual(t.steps.map((s) => s.storylet), ["s", "tick", "tick", "tick"]);
    assert.equal(e.get(t.final, "story.k"), 5);
  });
});

describe("validator ordering rules", () => {
  it("makes a choice that reads its own storylet's effect an error", () => {
    const c = contentFrom(`
      vars: {a: me1.bool.1, b: me1.bool.2, story.n: {type: int}}
      traits:
        counted: {effects: ["story.n += 1"]}
      storylets:
        - id: s
          traits: [counted]
          effects: ["a = true"]
          choices:
            - {id: dead, requires: "a", effects: ["b = true"]}
            - {id: counter, requires: "story.n > 0"}
            - {id: fine, requires: "!b"}
    `);
    const rep = validate(c, null, 0);
    assert.equal(rep.errors.length, 1);
    assert.match(rep.errors[0]!, /s\/dead/);
    assert.ok(rep.info.some((i) => i.startsWith("s/counter") && i.includes("traits")));
  });

  it("reports a pre-empted auto storylet", () => {
    // 'scene' can only happen before 'next' fires; with equal priority, file order decides.
    const c = contentFrom(`
      vars: {a: me1.bool.1, b: me1.bool.2, done: me1.bool.3}
      storylets:
        - {id: start, trigger: auto, requires: "!a", effects: ["a = true"]}
        - {id: next, trigger: auto, requires: "a && !b", effects: ["b = true"]}
        - {id: scene, trigger: auto, requires: "a && !b && !done", effects: ["done = true"]}
    `);
    const e = new Engine(c);
    const t = e.run(e.initial());
    assert.deepEqual(t.preempted, new Set(["scene"]));
    assert.deepEqual([...t.ties], [["next", "scene"]]);
    const rep = validate(c, null, 5);
    assert.ok(rep.warnings.some((w) => w.startsWith("scene: auto storylet")));
  });
});

describe("YAML", () => {
  it("resolves scalars as PyYAML's safe_load did", () => {
    // Expected values captured from PyYAML 6.0.3. The yaml package's own 1.1 schema reads
    // y/n as booleans, 1e5 as a float and 09 as an int.
    const src = ["a: y", "b: n", "c: yes", "d: 1e5", "e: 1.0e+5", "f: 09", "g: 012", "h: 1_000", "i: .", "j: 1.5", "k: Off", "l: 0x1F", "m: 1:30", "n: .5"].join("\n");
    assert.deepEqual(parseYaml(src, YAML_OPTIONS), {
      a: "y", b: "n", c: true, d: "1e5", e: 100000, f: "09", g: 10, h: 1000, i: ".", j: 1.5, k: false, l: 31, m: 90, n: 0.5,
    });
  });
});

describe("shipped content", () => {
  // The repository's own content must load, validate (without the catalog) and play through.
  const content = loadContent(path.join(ROOT, "content"));

  it("validates", () => {
    assert.deepEqual(validate(content, null, 100, 1).errors, []);
  });

  it("plays through the trilogy from ME1", () => {
    const e = new Engine(content);
    const rng = new PyRandom(0);
    const t = e.run(e.initial(), rng, undefined, (_state, opts) => opts.find(([st, cid]) => st.id === "campaign.start" && cid === "me1") ?? rng.choice(opts));
    assert.equal(t.stuck, false);
    assert.equal(e.get(t.final, "me1.end.game_complete"), true);
    assert.equal(e.get(t.final, "me2.progress.game_done"), true);
    // the import bridge carried ME1's Virmire outcome into ME2's own variables
    assert.equal(e.get(t.final, "me2.import.ash_died"), e.get(t.final, "me1.virmire.rescued_kaidan"));
  });

  it("keeps named conditions when filtering by game (graph --game)", () => {
    const sub = content.filtered((st) => st.game === "me3");
    assert.equal(sub.conditions.size, content.conditions.size);
    const e = new Engine(sub);
    // a condition-only name must still resolve to the variables behind it
    const names = e.expandNames(parse("me3.fate.wrex_dead"));
    assert.ok(names.size > 0 && !names.has("me3.fate.wrex_dead"));
  });
});
