import textwrap
import unittest
from pathlib import Path
import tempfile

from storylet.engine import Engine
from storylet.expr import ExprError, evaluate, parse, parse_effect
from storylet.loader import load_content
from storylet.validate import validate

ROOT = Path(__file__).resolve().parents[1]


def content_from(yaml_text: str):
    d = tempfile.mkdtemp()
    Path(d, "c.yaml").write_text(textwrap.dedent(yaml_text), encoding="utf-8")
    return load_content(Path(d))


class ExprTests(unittest.TestCase):
    def ev(self, src, **env):
        return evaluate(parse(src), lambda n: env[n.replace(".", "_")])

    def test_bioware_syntax(self):
        # Shape of real plot-DB conditionals after PE{n} -> canonical ref rewriting.
        src = "me1.bool.1 == true && (me1.bool.2 || me1.bool.3 ) && me1.int.4 >= 2"
        self.assertTrue(self.ev(src, me1_bool_1=True, me1_bool_2=False, me1_bool_3=True, me1_int_4=2))
        self.assertFalse(self.ev(src, me1_bool_1=True, me1_bool_2=False, me1_bool_3=False, me1_int_4=2))

    def test_precedence_and_ternary(self):
        self.assertEqual(self.ev("1 + 2 * 3"), 7)
        self.assertTrue(self.ev("!false && 1 < 2 || false"))
        self.assertEqual(self.ev("a > 1 ? 10 : 20", a=3), 10)
        self.assertEqual(self.ev("count(true, false, 1 == 1)"), 2)

    def test_roundtrip(self):
        for src in ("a && !b || c == 3", "count(a, b) >= 2 ? x : -y", "seen(me1.x.y)"):
            node = parse(src)
            self.assertEqual(str(parse(str(node))), str(node))

    def test_effects(self):
        e = parse_effect("me1.player.paragon += 2")
        self.assertEqual((e.target, e.op), ("me1.player.paragon", "+="))
        with self.assertRaises(ExprError):
            parse_effect("a == b")
        with self.assertRaises(ExprError):
            parse("a &&")


SMALL = """
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
"""


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.c = content_from(SMALL)
        self.assertEqual(self.c.errors, [])
        self.e = Engine(self.c)

    def test_fire_and_choices(self):
        s0 = self.e.initial()
        self.assertEqual([s.id for s in self.e.available(s0)], ["start"])
        with self.assertRaises(ValueError):
            self.e.fire(s0, "start")  # two choices available, none given
        s1 = self.e.fire(s0, "start", "left")
        self.assertEqual(self.e.get(s1, "story.counter"), 6)
        self.assertEqual([s.id for s in self.e.available(s1)], ["second"])
        s2 = self.e.fire(s1, "second")
        self.assertEqual([s.id for s in self.e.available(s2)], ["finale"])

    def test_condition_with_argument(self):
        s = self.e.initial({"a": True})
        cond = parse("done_at_least(1) && !done_at_least(2)")
        self.assertTrue(self.e.eval(cond, s))

    def test_explore(self):
        ex = self.e.explore()
        self.assertFalse(ex.truncated)
        self.assertEqual(ex.fired, {"start", "second", "finale"})
        self.assertEqual(len(ex.terminals), 2)  # left (finale fired) / right

    def test_validator_catches_unknown_names(self):
        bad = content_from("""
        storylets:
          - id: x
            requires: "nope && seen(ghost)"
            effects: ["also_nope = true"]
        """)
        rep = validate(bad, None, sim_runs=0)
        text = "\n".join(rep.errors)
        self.assertIn("unknown variable 'nope'", text)
        self.assertIn("unknown storylet 'ghost'", text)
        self.assertIn("also_nope", text)


V2 = """
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
"""


class SchemaV2Tests(unittest.TestCase):
    def setUp(self):
        self.c = content_from(V2)
        self.assertEqual(self.c.errors, [])
        self.e = Engine(self.c)

    def test_gating_bridge_traits_templates_outcomes(self):
        e = self.e
        s = e.fire(e.initial(), "start")
        self.assertEqual([x.id for x in e.available(s)], ["one"])      # me2 storylets gated off
        s = e.fire(s, "one")
        self.assertEqual(e.get(s, "story.n"), 1)                        # trait effect
        s = e.fire(s, "bridge")
        self.assertEqual(sorted(x.id for x in e.available(s)), ["pick_a", "pick_b"])  # foreach
        a = e.fire(e.fire(s, "pick_a"), "rules")
        self.assertTrue(e.get(a, "y"))
        self.assertEqual(e.get(a, "story.n"), 1)                        # resolve: first stops at is_a
        self.assertIn(("rules", "is_a"), a.chosen)
        b = e.fire(e.fire(s, "pick_b"), "rules")
        self.assertEqual(e.get(b, "story.n"), 11)
        self.assertEqual([x.id for x, _ in e.step_options(b)], ["fallback"])  # idle only when nothing else

    def test_enum_rejects_unknown_member(self):
        from storylet.expr import parse_effect
        st = self.c.storylets["pick_a"]
        st.effects = [parse_effect("story.role = 'c'")]
        s = self.e.fire(self.e.fire(self.e.fire(self.e.initial(), "start"), "one"), "bridge")
        with self.assertRaises(ValueError):
            self.e.fire(s, "pick_a")


class ValidatorOrderingTests(unittest.TestCase):
    def test_choice_reading_own_effect_is_an_error(self):
        c = content_from("""
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
        """)
        rep = validate(c, None, sim_runs=0)
        self.assertEqual(len(rep.errors), 1)
        self.assertIn("s/dead", rep.errors[0])
        self.assertTrue(any(i.startswith("s/counter") and "traits" in i for i in rep.info))

    def test_preempted_auto_is_reported(self):
        # 'scene' can only happen before 'next' fires; with equal priority, file order decides.
        c = content_from("""
        vars: {a: me1.bool.1, b: me1.bool.2, done: me1.bool.3}
        storylets:
          - {id: start, trigger: auto, requires: "!a", effects: ["a = true"]}
          - {id: next, trigger: auto, requires: "a && !b", effects: ["b = true"]}
          - {id: scene, trigger: auto, requires: "a && !b && !done", effects: ["done = true"]}
        """)
        e = Engine(c)
        t = e.run(e.initial())
        self.assertEqual(t.preempted, {"scene"})
        self.assertEqual(t.ties, {("next", "scene")})
        rep = validate(c, None, sim_runs=5)
        self.assertTrue(any(w.startswith("scene: auto storylet") for w in rep.warnings))


class ShippedContentTests(unittest.TestCase):
    """The repository's own content must load, validate (without the catalog) and play through."""

    def test_content_validates(self):
        content = load_content(ROOT / "content")
        rep = validate(content, None, sim_runs=100, seed=1)
        self.assertEqual(rep.errors, [])

    def test_trilogy_playthrough_from_me1(self):
        import random
        content = load_content(ROOT / "content")
        e = Engine(content)
        rng = random.Random(0)

        def from_me1(state, opts):
            for st, cid in opts:
                if st.id == "campaign.start":
                    return st, "me1"
            return rng.choice(opts)

        t = e.run(e.initial(), rng, policy=from_me1)
        self.assertFalse(t.stuck)
        self.assertTrue(e.get(t.final, "me1.end.game_complete"))
        self.assertTrue(e.get(t.final, "me2.progress.game_done"))
        # the import bridge carried ME1's Virmire outcome into ME2's own variables
        self.assertEqual(e.get(t.final, "me2.import.ash_died"), e.get(t.final, "me1.virmire.rescued_kaidan"))


if __name__ == "__main__":
    unittest.main()
