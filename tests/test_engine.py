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


class ShippedContentTests(unittest.TestCase):
    """The repository's own content must load, validate (without the catalog) and play through."""

    def test_content_validates(self):
        content = load_content(ROOT / "content")
        rep = validate(content, None, sim_runs=100, seed=1)
        self.assertEqual(rep.errors, [])

    def test_playthrough_reaches_an_ending(self):
        import random
        content = load_content(ROOT / "content")
        e = Engine(content)
        t = e.run(e.initial(), random.Random(0))
        self.assertFalse(t.stuck)
        self.assertTrue(e.get(t.final, "me1.end.game_complete"))


if __name__ == "__main__":
    unittest.main()
