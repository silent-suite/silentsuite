#!/usr/bin/env python3
"""CI only: look for secrets and identifiers in the YunoHost container's logs.

Runs inside the test container as root:
    log-scan.py MARKERS WINDOWS

MARKERS holds "kind<TAB>value" lines. Searched: /var/log/yunohost, /var/log/nginx and
the journal. Prints only the kind and the file, never a value or a line. Kinds starting
with "control-" are reported but not counted.

One exemption: request identifiers (collection and item UIDs) in nginx lines timestamped
inside one of WINDOWS ("start:end,...", inclusive epoch seconds): a failed upgrade's
removal-to-restore operation interval from YunoHost's operation log. In that interval
YunoHost removes the app's nginx locations (which turn request logging off) and puts them
back, so the domain's default logs can record the request paths. Those are reported separately. Credentials are never
exempt, and a line whose time cannot be read counts as a hit.
Exit status: the number of counted hits (capped at 100).
"""

import datetime
import os
import re
import subprocess
import sys

EXEMPTIBLE = {"collection-uid", "item-uid"}
ACCESS_TIME = re.compile(r"\[(\d{2}/\w{3}/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4})\]")
ERROR_TIME = re.compile(r"^(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})")


def line_time(line):
    match = ACCESS_TIME.search(line)
    if match:
        return datetime.datetime.strptime(match.group(1), "%d/%b/%Y:%H:%M:%S %z").timestamp()
    match = ERROR_TIME.match(line)
    if match:
        parsed = datetime.datetime.strptime(match.group(1), "%Y/%m/%d %H:%M:%S")
        return parsed.replace(tzinfo=datetime.timezone.utc).timestamp()
    return None


def files():
    for root in ("/var/log/yunohost", "/var/log/nginx"):
        for directory, _, names in os.walk(root):
            for name in names:
                yield os.path.join(directory, name)


def main():
    markers_path = sys.argv[1]
    windows = [tuple(int(x) for x in w.split(":")) for w in sys.argv[2].split(",") if w]
    markers = {}
    for raw in open(markers_path, encoding="utf-8"):
        kind, _, value = raw.rstrip("\n").partition("\t")
        if value:
            markers.setdefault(value, kind)

    journal = subprocess.run(["journalctl", "-o", "cat", "--no-pager"], capture_output=True,
                             text=True, errors="replace").stdout
    sources = [("journal", journal.splitlines())]
    for path in files():
        try:
            with open(path, encoding="utf-8", errors="replace") as handle:
                sources.append((path, handle.read().splitlines()))
        except OSError:
            continue

    counted = 0
    for name, lines in sources:
        for value, kind in markers.items():
            matching = [line for line in lines if value in line]
            if not matching:
                continue
            if name.startswith("/var/log/nginx/") and kind in EXEMPTIBLE:
                inside = [line for line in matching
                          if (t := line_time(line)) is not None
                          and any(a <= t <= b for a, b in windows)]
                if inside:
                    print(f"INFO {kind} in {name}: {len(inside)} line(s) while the app was removed")
                matching = [line for line in matching if line not in inside]
                if not matching:
                    continue
            print(f"HIT {kind} in {name}: {len(matching)} line(s)")
            if not kind.startswith("control-"):
                counted += 1
    return min(counted, 100)


if __name__ == "__main__":
    sys.exit(main())
