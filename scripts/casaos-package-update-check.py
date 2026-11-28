#!/usr/bin/env python3
"""Replay legacy CasaOS's update decision for two package manifests.

A literal copy of IceWhaleTech/CasaOS-AppManagement@debfa317:
  pkg/docker/manifest.go:42-60        ExtractImageAndTag
  service/compose_app.go:285-305      MainService / MainTag (x-casaos.main)
  service/appstore_management.go:546-587 IsUpdateAvailableWith
  common/constants.go:35              NeedCheckDigestTags = ["latest"]
The digest branch (tag "latest") needs a local Docker image and is refused here: the
package must never use it, because CasaOS would then compare digests, not releases.

Usage: casaos-package-update-check.py INSTALLED.yml STORE.yml {update|none}
"""

import sys

import yaml

NEED_CHECK_DIGEST_TAGS = ["latest"]


def extract_image_and_tag(image_name):
    if ":" in image_name:
        parts = image_name.split(":")
        if len(parts) > 2:
            return parts[0], ":".join(parts[1:])
        return parts[0], parts[1]
    return image_name, "latest"


def main_tag(document):
    main = (document.get("x-casaos") or {}).get("main")
    if not main:
        raise SystemExit("ERROR: x-casaos.main is not set")
    service = document["services"].get(main)
    if service is None:
        raise SystemExit(f"ERROR: main service {main!r} does not exist")
    return extract_image_and_tag(service["image"])[1]


def is_update_available_with(installed, store):
    current = main_tag(installed)
    if current in NEED_CHECK_DIGEST_TAGS:
        raise SystemExit("ERROR: main image uses the digest-compare tag; releases would not be compared")
    return current != main_tag(store)


def main():
    if len(sys.argv) != 4 or sys.argv[3] not in ("update", "none"):
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as handle:
        installed = yaml.safe_load(handle)
    with open(sys.argv[2], encoding="utf-8") as handle:
        store = yaml.safe_load(handle)
    expected = sys.argv[3] == "update"
    actual = is_update_available_with(installed, store)
    print(f"{'PASS' if actual == expected else 'FAIL'} CasaOS update decision: "
          f"{'update available' if actual else 'no update'} (expected {sys.argv[3]})")
    return 0 if actual == expected else 1


if __name__ == "__main__":
    sys.exit(main())
