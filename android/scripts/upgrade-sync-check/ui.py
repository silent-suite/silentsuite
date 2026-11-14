"""Minimal uiautomator helper for the Android upgrade-and-sync check (CI emulator only).

Usage:
  ui.py dump <out.xml>                  save the current hierarchy
  ui.py ids <xml>                       print visible resource-id suffixes, one per line
  ui.py has-text <xml> <id> <text>      exit 0 if node <id> holds exactly <text>
  ui.py tap <xml> id:<suffix>|text:<re> tap the first matching node; exit 1 if none
"""

import re
import subprocess
import sys
import xml.etree.ElementTree as ET


def adb(*args: str) -> str:
    return subprocess.run(["adb", *args], check=True, capture_output=True, text=True).stdout


def dump(out: str) -> None:
    for _ in range(3):
        try:
            adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
            data = adb("exec-out", "cat", "/sdcard/ui.xml")
            if "<hierarchy" in data:
                with open(out, "w", encoding="utf-8") as fh:
                    fh.write(data)
                return
        except subprocess.CalledProcessError:
            pass
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("<hierarchy/>")


def nodes(path: str):
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError:
        return []
    return list(root.iter("node"))


def suffix(node) -> str:
    rid = node.attrib.get("resource-id", "")
    return rid.split("/", 1)[1] if "/" in rid else rid


def center(node):
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.attrib.get("bounds", ""))
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    if x2 <= x1 or y2 <= y1:
        return None
    return (x1 + x2) // 2, (y1 + y2) // 2


def main() -> None:
    cmd = sys.argv[1]
    if cmd == "dump":
        dump(sys.argv[2])
    elif cmd == "ids":
        for node in nodes(sys.argv[2]):
            s = suffix(node)
            if s:
                print(s)
    elif cmd == "has-text":
        wanted_id, wanted_text = sys.argv[3], sys.argv[4]
        ok = any(suffix(n) == wanted_id and n.attrib.get("text", "") == wanted_text for n in nodes(sys.argv[2]))
        sys.exit(0 if ok else 1)
    elif cmd == "tap":
        selector = sys.argv[3]
        kind, value = selector.split(":", 1)
        for node in nodes(sys.argv[2]):
            if kind == "id" and suffix(node) != value:
                continue
            if kind == "text" and not re.fullmatch(value, node.attrib.get("text", ""), re.IGNORECASE):
                continue
            point = center(node)
            if point and node.attrib.get("enabled", "true") == "true":
                adb("shell", "input", "tap", str(point[0]), str(point[1]))
                print(f"tapped {selector} at {point}")
                return
        sys.exit(1)
    else:
        sys.exit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
