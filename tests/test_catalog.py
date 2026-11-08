"""Tests against the real plot databases. Skipped unless `meplot fetch` has been run."""
import unittest
from pathlib import Path

from meplot.catalog import load_catalog
from meplot.graph import infer_transition_target

PLOTDB = Path(__file__).resolve().parents[1] / "build" / "plotdb"
HAVE_DB = all((PLOTDB / f).exists() for f in ("le1.json", "le2.json", "le3.json"))


@unittest.skipUnless(HAVE_DB, "run `meplot fetch` to enable plot-database tests")
class CatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cat = load_catalog(PLOTDB)

    def test_path_resolution(self):
        hits = self.cat.resolve_path("me1:CH2_Virmire.The_Choice.Rescued_Kaidan")
        self.assertEqual([h.ref for h in hits], ["me1.bool.3828"])

    def test_le3_carries_me1_table_at_offset(self):
        el = self.cat.get("me3.bool.13828")
        self.assertEqual(el.canonical, "me1.bool.3828")
        self.assertEqual(el.import_region, "ME1_Plots_for_ME3")

    def test_le3_carries_me2_table_unchanged(self):
        hits = self.cat.resolve_path("me3:ME2_Plots_for_ME3.Act_3.Final_Decision.Destroy_Base")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].canonical, "me2.bool.1831")

    def test_le2_import_region_is_native(self):
        hits = self.cat.resolve_path("me2:ME1_Plots_for_ME2.CH2_Virmire.Ash_died")
        self.assertEqual(hits[0].canonical, hits[0].ref)  # ME2's own variable, set by the importer

    def test_conditional_rewrite(self):
        el = self.cat.resolve_path("me1:Global_Plots.World_Progress.Time_For_Virmire_Open")[0]
        code = self.cat.condition_code(el)
        self.assertIn("me1.bool.4104 == false", code)
        self.assertNotIn("PE{", code)

    def test_transition_inference(self):
        tr = self.cat.resolve_path("me1:CH2_Virmire.The_Choice.Set_Rescued_Kaidan_True")[0]
        target, confidence, value = infer_transition_target(self.cat, tr)
        self.assertEqual((target.ref, confidence, value), ("me1.bool.3828", "high", "true"))

    def test_few_alias_anomalies(self):
        self.assertLess(len(self.cat.anomalies), 50)


if __name__ == "__main__":
    unittest.main()
