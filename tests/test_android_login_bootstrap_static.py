"""Static production-wiring contracts for Android post-login bootstrap."""

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/setup/PostLoginSetupMigration.kt"


def test_production_bootstrap_separates_row_classification_from_marker_publication():
    source = MIGRATION.read_text(encoding="utf-8")
    production = source.split("fun bootstrap(context: Context): Boolean", 1)[1].split(
        "/**\n     * Startup repair", 1
    )[0]

    assert "interface RowStore" in source
    assert "interface Store : RowStore" in source
    assert "internal fun classifyRows(store: RowStore" in source
    assert "val classified = classifyRows(object : RowStore" in production
    assert production.count("classifyRows(object : RowStore") == 1
    assert re.search(r"\bbootstrap\s*\(", production) is None
    assert "override fun marker() = 0" not in production
    assert "override fun writeMarker" not in production
    assert "classifyRows = { classified }" in production
    assert 'prefs.edit().putInt("version", MIGRATION_VERSION).commit()' in production
