#!/usr/bin/env python3
"""CI only: prove which safety backup YunoHost restored after a failed upgrade.

Runs inside the YunoHost test container as root:
    rollback-evidence.py UPGRADE_OUTPUT ATTEMPT_START ATTEMPT_END

Created archive: the name in this attempt's "Backup created: <name>" message.
Restored archive: basename of metadata.env.YNH_BACKUP_DIR of the one successful
backup_restore_app operation for silentsuite that started inside the attempt,
found by walking `yunohost log list --with-suboperations` (nested operations
included). Prints check names only, then one line "WINDOW <start> <end>": from the start of
this attempt's app_remove to the end of that restore (epoch seconds), the time YunoHost had
the app removed.
"""

import datetime
import json
import os
import re
import subprocess
import sys


def yunohost_json(*args):
    out = subprocess.run(["yunohost", *args, "--output-as", "json"], check=True,
                         capture_output=True, text=True).stdout
    return json.loads(out)


def walk(entries):
    for entry in entries or []:
        yield entry
        yield from walk(entry.get("suboperations"))


def parse_time(value):
    if isinstance(value, (int, float)):
        return datetime.datetime.fromtimestamp(value, datetime.timezone.utc)
    parsed = datetime.datetime.fromisoformat(str(value))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=datetime.timezone.utc)


def main():
    output_path, start, end = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    start_t = datetime.datetime.fromtimestamp(start, datetime.timezone.utc)
    end_t = datetime.datetime.fromtimestamp(end, datetime.timezone.utc)

    created = re.findall(r"Backup created: (silentsuite-pre-upgrade[12])\b",
                         open(output_path, encoding="utf-8", errors="replace").read())
    if len(created) != 1:
        print(f"FAIL rollback: expected one safety backup creation message, found {len(created)}")
        return 1
    print("PASS rollback: safety backup created during the attempt")

    listing = yunohost_json("log", "list", "--with-suboperations", "--limit", "200")
    names = [e.get("name", "") for e in walk(listing.get("operation", []))]
    candidates = [n for n in names if "backup_restore_app" in n and "silentsuite" in n]

    matches, restore_ends = [], []
    for name in candidates:
        meta = yunohost_json("log", "show", name).get("metadata", {})
        if meta.get("success") is not True or "started_at" not in meta:
            continue
        if start_t <= parse_time(meta["started_at"]) <= end_t:
            matches.append(os.path.basename(str(meta.get("env", {}).get("YNH_BACKUP_DIR", "")).rstrip("/")))
            restore_ends.append(parse_time(meta.get("ended_at") or meta["started_at"]))

    removal_starts = []
    for name in (n for n in names if "app_remove" in n and "silentsuite" in n):
        meta = yunohost_json("log", "show", name).get("metadata", {})
        if "started_at" in meta and start_t <= parse_time(meta["started_at"]) <= end_t:
            removal_starts.append(parse_time(meta["started_at"]))

    if len(matches) != 1:
        print(f"FAIL rollback: expected one successful restore in the attempt, found {len(matches)}")
        return 1
    print("PASS rollback: one successful restore inside the attempt")
    if matches[0] != created[0]:
        print("FAIL rollback: restored archive differs from the one created in the attempt")
        return 1
    print("PASS rollback: restored archive is the one created in the attempt")
    if len(removal_starts) != 1:
        print(f"FAIL rollback: expected one app removal inside the attempt, found {len(removal_starts)}")
        return 1
    print(f"WINDOW {int(removal_starts[0].timestamp())} {int(restore_ends[0].timestamp()) + 1}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
