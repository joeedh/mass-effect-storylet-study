"""Download BioWare's plot databases (as shipped with LegendaryExplorer) at a pinned revision.

The databases are not vendored in this repository: they are fetched into ``build/plotdb``
and verified against a pinned SHA-256 so every derived artifact is reproducible.
"""
from __future__ import annotations

import hashlib
import io
import urllib.request
import zipfile
from pathlib import Path

LEX_REPO = "ME3Tweaks/LegendaryExplorer"
LEX_COMMIT = "b8869f92c7b80be7818447b5079f65c99b4a97b8"
ZIP_PATH = "LegendaryExplorer/LegendaryExplorerCore/Embedded/PlotDatabases.zip"
ZIP_SHA256 = "48aee954405f8725dad88b87563f2de8fafd05e6218e7a5cee5a170cf6265ada"
ZIP_URL = f"https://raw.githubusercontent.com/{LEX_REPO}/{LEX_COMMIT}/{ZIP_PATH}"
DB_FILES = ("le1.json", "le2.json", "le3.json")


def fetch(dest: Path, *, force: bool = False, url: str = ZIP_URL) -> list[Path]:
    """Fetch and unpack the plot databases into ``dest``. Returns the extracted paths."""
    dest.mkdir(parents=True, exist_ok=True)
    targets = [dest / name for name in DB_FILES]
    if not force and all(p.exists() for p in targets):
        return targets
    with urllib.request.urlopen(url, timeout=120) as resp:
        blob = resp.read()
    digest = hashlib.sha256(blob).hexdigest()
    if digest != ZIP_SHA256:
        raise RuntimeError(f"PlotDatabases.zip checksum mismatch: got {digest}, expected {ZIP_SHA256}")
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        for name in DB_FILES:
            (dest / name).write_bytes(zf.read(name))
    (dest / "SOURCE.txt").write_text(
        f"{url}\nsha256={ZIP_SHA256}\nLicense: GPL-3.0 (LegendaryExplorer); plot data originates from BioWare's games.\n",
        encoding="utf-8",
    )
    return targets
