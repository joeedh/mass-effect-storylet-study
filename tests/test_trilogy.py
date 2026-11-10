"""Cross-game regression tests on the shipped content: long prerequisite chains must stay reachable."""
import random
import unittest
from pathlib import Path

from storylet.engine import Engine
from storylet.expr import parse
from storylet.loader import load_content

ROOT = Path(__file__).resolve().parents[1]

# A deliberate "golden" ME2 -> ME3 career: everyone recruited and loyal, ideal suicide-mission
# picks, heretics rewritten, Koris saved; every optional op done before the point of no return.
GOLDEN = {
    "campaign.start": "me2", "me2.genesis.rachni": "released", "me2.player.style": "paragon", "me2.recruit.legion": "activate",
    "me2.loyalty.legion": "rewrite", "me2.loyalty.mordin": "keep_data", "me2.loyalty.tali": "charm",
    "me2.conflict.miranda_jack": "resolve", "me2.conflict.tali_legion": "resolve",
    "me2.sm.choose_tech": "legion", "me2.sm.choose_leader1": "garrus", "me2.sm.choose_biotic": "samara",
    "me2.sm.choose_leader2": "miranda", "me2.sm.choose_escort": "mordin", "me2.sm.choose_party1": "kasumi",
    "me2.sm.choose_party2": "tali", "me2.sm.final_decision": "destroy",
    "me3.citadel.standoff": "talk_down", "me3.rannoch.admiral_koris": "save_koris",
    "me3.rannoch.reaper_base": "peace", "me3.genophage.shroud": "cure", "me3.thessia": "challenge_tim",
    "me3.horizon": "miranda_warned", "me3.monastery": "stop_samara", "me3.attican.krogan_team": "free_queen",
    "me3.earth.illusive_man": "persuade", "me3.earth.catalyst": "destroy",
}
LAST = ("me2.sm.launch", "me3.import.me2_save", "me3.cronos", "me3.earth.london")


def golden_policy(state, opts):
    """Scripted picks are taken as soon as they are offered in ME2, where windows close
    (Legion must be reactivated before the crew is taken). In ME3 the career is a completionist:
    optional content comes first, because priority missions close it and its reputation is what
    the persuasion checks need. The point-of-no-return storylets in LAST always come last."""
    scripted = [(st, cid) for st, cid in opts if st.id in GOLDEN and GOLDEN[st.id] == cid]
    free = [(st, cid) for st, cid in opts if st.id not in LAST and st.id not in GOLDEN]
    in_me3 = dict(state.values).get("story.game") == 3
    for pool in ((free, scripted) if in_me3 else (scripted, free)):
        if pool:
            return pool[0]
    return opts[0]


class TrilogyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.content = load_content(ROOT / "content")
        cls.engine = Engine(cls.content)

    def val(self, state, src):
        return self.engine.eval(parse(src), state)

    def test_golden_career(self):
        t = self.engine.run(self.engine.initial(), random.Random(0), policy=golden_policy)
        s = t.final
        # every scripted pick was taken; otherwise the policy silently fell back to another option
        self.assertEqual(sorted(set(GOLDEN.items()) - s.chosen), [])
        self.assertTrue(self.val(s, "me2.progress.game_done && !story.me2.shepard_dead"))
        self.assertEqual(self.val(s, "count(me2.squad.legion.dead, me2.squad.tali.dead, me2.squad.garrus.dead)"), 0)
        self.assertIn(("me3.rannoch.reaper_base", "peace"), s.chosen)   # needs ~8 decisions across ME2+ME3
        self.assertTrue(self.val(s, "me3.end.tim_suicide"))             # lifted IM_Final_Persuade
        self.assertGreaterEqual(self.val(s, "me3.ems.current_rating"), 4000)
        self.assertTrue(self.val(s, "me3.end.shepard_alive && me3.end.earth_ok"))

    def test_me3_reads_me1_virmire_directly(self):
        # LE3's Kaiden_Is_Dead reads ME1's Rescued_Kaidan (me1.bool.3828) through the +10000 alias.
        e = self.engine
        self.assertTrue(self.val(e.initial({"me1.virmire.rescued_ash": True}), "me3.fate.kaidan_dead"))
        self.assertFalse(self.val(e.initial({"me1.virmire.rescued_kaidan": True}), "me3.fate.kaidan_dead"))

    def test_wrex_fate_spans_three_games(self):
        e = self.engine
        alive = e.initial({"me1.squad.wrex": True})
        self.assertFalse(self.val(alive, "me3.fate.wrex_dead"))
        shot = e.initial({"me1.squad.wrex": True, "me1.virmire.wrex_killed_by_player": True})
        self.assertTrue(self.val(shot, "me3.fate.wrex_dead"))
        # ME3: a sabotaged cure + Wrex alive after Rannoch -> the Citadel confrontation fires
        later = e.initial({"me1.squad.wrex": True, "me3.genophage.cure_sabotaged": True, "me3.order.Gth002": 12})
        self.assertTrue(self.val(later, "me3.citadel.time_for_wrex_confrontation"))

    def test_wreav_leads_unless_wrex_ended_me1_in_the_squad(self):
        # LE3 decides by the lifted Wrex_is_present, not by Wrex_is_dead.
        e = self.engine
        careers = {
            "talked down": ({"me1.squad.wrex": True, "me1.virmire.wrex_success": True}, False),
            "shot on Virmire": ({"me1.virmire.wrex_failure": True, "me1.virmire.wrex_killed_by_player": True}, True),
            "never recruited": ({}, True),  # also a fresh ME3 start: every table at its default
        }
        for name, (overrides, wreav) in careers.items():
            with self.subTest(name):
                self.assertEqual(self.val(e.initial(overrides), "me3.genophage.wreav_leads"), wreav)
        self.assertFalse(self.val(e.initial(), "me3.fate.wrex_dead"))  # why Wrex_is_dead is the wrong test

    def test_wreav_leads_after_genesis_wrex_died(self):
        e = self.engine
        for virmire, wreav in (("kaidan_lives_wrex_dies", True), ("kaidan_lives_wrex_lives", False)):
            s = e.fire(e.initial(), "campaign.start", "me2")
            for sid, cid in (("me2.genesis.shepard", "male"), ("me2.genesis.fist", "killed"),
                             ("me2.genesis.rachni", "killed"), ("me2.genesis.virmire", virmire)):
                s = e.fire(s, sid, cid)
            with self.subTest(virmire):
                self.assertEqual(self.val(s, "me3.genophage.wreav_leads"), wreav)

    def test_mordin_can_be_talked_out_of_the_cure(self):
        # Needs Wreav in charge and Eve dead, i.e. Maelon's data destroyed (regression: the choice
        # used to test eve_dead, which only the same storylet's effects set, so it never appeared).
        e = self.engine
        shroud = self.content.storylets["me3.genophage.shroud"]
        base = {"story.game": 3, "me3.order.KroGar": 1, "me3.order.Kro001": 2, "me2.squad.mordin.recruited": True}
        offered = lambda extra: "sabotage_persuade" in {c.id for c in e.choices(shroud, e.initial({**base, **extra}))}
        self.assertTrue(offered({}))
        self.assertFalse(offered({"me2.mordin.saved_data": True}))
        self.assertFalse(offered({"me1.squad.wrex": True}))
        s = e.fire(e.initial(base), shroud, "sabotage_persuade")
        self.assertTrue(self.val(s, "me3.genophage.eve_dead && me3.genophage.sabotage_mordin_lived"))

    def hold_the_line(self, squad, party=("grunt", "zaeed")):
        """Fire the final battle, holding the line and the escape from a constructed state.
        ``squad`` maps each recruited squadmate to whether they are loyal."""
        e = self.engine
        ov = {"story.game": 2, "story.me2.sm.escort": "none",
              "story.me2.sm.party1": party[0], "story.me2.sm.party2": party[1]}
        for who, loyal in squad.items():
            ov[f"me2.squad.{who}.recruited"] = True
            ov[f"me2.squad.{who}.loyal"] = loyal
        s = e.initial(ov)
        for sid in ("me2.sm.final_battle", "me2.sm.hold_the_line", "me2.sm.shepard_fate"):
            s = e.fire(s, sid)
        fallen = {c for sid, c in s.chosen if sid == "me2.sm.hold_the_line"}
        return fallen, s

    def test_weak_defence_takes_disloyal_first_then_anyone(self):
        # Defenders mordin (0, disloyal), tali/kasumi/jack (0 + 1 loyal): average 0.75 -> two die.
        # Only one is disloyal, so the limited pass crosses into the full priority list.
        fallen, s = self.hold_the_line({"mordin": False, "tali": True, "kasumi": True, "jack": True,
                                        "grunt": True, "zaeed": True})
        self.assertEqual(fallen, {"mordin_falls_disloyal", "tali_falls"})
        self.assertFalse(self.val(s, "story.me2.shepard_dead"))

    def test_strong_defence_loses_nobody(self):
        fallen, s = self.hold_the_line({"garrus": True, "grunt": True, "zaeed": True, "miranda": True,
                                        "jacob": True}, party=("miranda", "jacob"))
        self.assertEqual(fallen, set())
        self.assertIn("me2.sm.hold_the_line", s.fired)
        self.assertIn("me2.sm.shepard_fate", s.fired)
        self.assertEqual(self.val(s, "count(me2.squad.garrus.dead, me2.squad.grunt.dead, me2.squad.zaeed.dead)"), 0)

    def test_tuchanka_bomb_timer_is_lifted(self):
        e = self.engine
        s = e.initial({"me3.order.KroN7a": 5, "me3.progress.mission_count": 7})
        self.assertFalse(self.val(s, "me3.tuchanka.bomb_exploded"))
        s = e.initial({"me3.order.KroN7a": 5, "me3.progress.mission_count": 8})
        self.assertTrue(self.val(s, "me3.tuchanka.bomb_exploded"))


if __name__ == "__main__":
    unittest.main()
