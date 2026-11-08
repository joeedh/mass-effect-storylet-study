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
    "campaign.start": "me2", "me2.player.style": "paragon", "me2.recruit.legion": "activate",
    "me2.loyalty.legion": "rewrite", "me2.loyalty.mordin": "keep_data", "me2.loyalty.tali": "charm",
    "me2.conflict.miranda_jack": "resolve", "me2.conflict.tali_legion": "resolve",
    "me2.sm.choose_tech": "legion", "me2.sm.choose_leader1": "garrus", "me2.sm.choose_biotic": "samara",
    "me2.sm.choose_leader2": "miranda", "me2.sm.choose_escort": "mordin", "me2.sm.choose_party1": "kasumi",
    "me2.sm.choose_party2": "tali", "me2.sm.final_decision": "destroy",
    "me3.citadel.standoff": "talk_down", "me3.rannoch.admiral_koris": "save_koris",
    "me3.rannoch.reaper_base": "peace", "me3.genophage.shroud": "cure", "me3.thessia": "challenge_tim",
    "me3.horizon": "miranda_warned", "me3.monastery": "stop_samara", "me3.attican.krogan_team": "free_breeder",
    "me3.earth.illusive_man": "persuade", "me3.earth.catalyst": "destroy",
}
LAST = ("me2.sm.launch", "me3.import.me2_save", "me3.cronos", "me3.earth.london")


def golden_policy(state, opts):
    for st, cid in opts:
        if st.id in GOLDEN and GOLDEN[st.id] == cid:
            return st, cid
    free = [(st, cid) for st, cid in opts if st.id not in LAST and st.id not in GOLDEN]
    return (free or opts)[0]


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

    def test_tuchanka_bomb_timer_is_lifted(self):
        e = self.engine
        s = e.initial({"me3.order.KroN7a": 5, "me3.progress.mission_count": 7})
        self.assertFalse(self.val(s, "me3.tuchanka.bomb_exploded"))
        s = e.initial({"me3.order.KroN7a": 5, "me3.progress.mission_count": 8})
        self.assertTrue(self.val(s, "me3.tuchanka.bomb_exploded"))


if __name__ == "__main__":
    unittest.main()
