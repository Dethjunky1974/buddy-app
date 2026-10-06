#!/usr/bin/env python3
"""Pin Buddy immediately after Chrome, preserving the rest of the Dock."""
import pathlib
import plistlib
import subprocess
import sys
import tempfile

app = pathlib.Path(sys.argv[1]).resolve()
support = pathlib.Path(sys.argv[2])
original = subprocess.check_output(["defaults", "export", "com.apple.dock", "-"])
settings = plistlib.loads(original)
apps = [item for item in settings.get("persistent-apps", [])
        if item.get("tile-data", {}).get("bundle-identifier") != "app.buddy.local"]

support.joinpath("dock-before-buddy.plist").write_bytes(original)
tile = {
    "tile-data": {
        "file-data": {"_CFURLString": app.as_uri() + "/", "_CFURLStringType": 15},
        "file-label": "Buddy",
        "bundle-identifier": "app.buddy.local",
    },
    "tile-type": "file-tile",
}
index = next(
    (i + 1 for i, item in enumerate(apps)
     if item.get("tile-data", {}).get("bundle-identifier") == "com.google.Chrome"),
    len(apps),
)
apps.insert(index, tile)
settings["persistent-apps"] = apps
with tempfile.NamedTemporaryFile(suffix=".plist") as temp:
    temp.write(plistlib.dumps(settings, fmt=plistlib.FMT_XML))
    temp.flush()
    subprocess.run(["defaults", "import", "com.apple.dock", temp.name], check=True)
subprocess.run(["killall", "Dock"], check=True)
