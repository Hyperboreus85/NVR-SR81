import contextlib
import io
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

script = Path(__file__).resolve().parents[1] / "deploy" / "proxmox-create.sh"
embedded = script.read_text(encoding="utf-8").split("<<'THIN_POOL_PY'\n", 1)[1].split("\nTHIN_POOL_PY", 1)[0]
report = ModuleType("nvr_thin_pool_report")
exec(compile(embedded, str(script) + ":thin-pool-report", "exec"), report.__dict__)


class ThinPoolReportTests(unittest.TestCase):
    def fake_read(self, *args):
        if args[0] == "pvesh":
            return {"type": "lvmthin", "vgname": "pve", "thinpool": "data"}
        if args[0] == "lvs":
            def lv(name, size, pool="", segtype="thin"):
                return {"vg_name": "pve", "lv_name": name, "lv_size": str(size * report.GIB),
                        "pool_lv": pool, "segtype": segtype, "data_percent": "55.05", "metadata_percent": "2.94"}
            return {"report": [{"lv": [lv("data", 141.14, segtype="thin-pool"), lv("vm-100-disk-0", 20, "data"),
                                        lv("vm-101-disk-0", 64, "data"), lv("other", 100, "other-pool")]}]}
        if args[0] == "vgs":
            return {"report": [{"vg": [{"vg_name": "pve", "vg_free": str(16 * report.GIB)}]}]}
        self.fail(args)

    def run_report(self, arguments, reader=None):
        output = io.StringIO()
        with patch.object(report, "read", side_effect=reader or self.fake_read), contextlib.redirect_stdout(output):
            report.main(arguments)
        return output.getvalue()

    def test_50_gib_projects_142_and_warns(self):
        output = self.run_report(["local-lvm", "8", "local-lvm", "50"])
        self.assertIn("fisico 141.14", output)
        self.assertIn("= 142.00 GiB", output)
        self.assertIn("Data 55.05%; Meta 2.94%", output)
        self.assertIn("ATTENZIONE: volumi virtuali", output)
        self.assertNotIn("superiore anche a pool", output)

    def test_40_gib_projects_132_without_overprovision_warning(self):
        output = self.run_report(["local-lvm", "8", "local-lvm", "40"])
        self.assertIn("= 132.00 GiB", output)
        self.assertNotIn("ATTENZIONE:", output)

    def test_storage_aliases_aggregate_one_pool(self):
        output = self.run_report(["alias-one", "8", "alias-two", "50"])
        self.assertEqual(output.count("Thin pool pve/data:"), 1)
        self.assertIn("nuovi 58.00", output)

    def test_exceeding_pool_plus_vg_free_has_second_warning(self):
        output = self.run_report(["local-lvm", "8", "local-lvm", "80"])
        self.assertIn("superiore anche a pool", output)

    def test_failures_only_warn(self):
        output = self.run_report(["local-lvm", "8", "", "50"], reader=OSError("unavailable"))
        self.assertIn("Avviso:", output)
        self.assertNotIn("unavailable", output)

    def test_non_thin_storage_is_silent(self):
        output = self.run_report(["local", "8", "local", "50"], reader=lambda *args: {"type": "dir"})
        self.assertEqual(output, "")


if __name__ == "__main__":
    unittest.main()
