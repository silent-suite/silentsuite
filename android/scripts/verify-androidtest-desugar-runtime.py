#!/usr/bin/env python3
"""Verify the test APK owns the desugared API FragmentManager calls at runtime."""

from __future__ import annotations

import struct
import sys
import zipfile


def u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def u16(data: bytes, offset: int) -> int:
    return struct.unpack_from("<H", data, offset)[0]


def uleb(data: bytes, offset: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7


def strings(dex: bytes) -> list[str]:
    size, offset = u32(dex, 56), u32(dex, 60)
    values = []
    for index in range(size):
        cursor = u32(dex, offset + 4 * index)
        _, cursor = uleb(dex, cursor)  # UTF-16 length; descriptors here are ASCII.
        end = dex.index(b"\0", cursor)
        values.append(dex[cursor:end].decode("utf-8"))
    return values


def owns_synchronized_map(dex: bytes) -> bool:
    values = strings(dex)
    type_size, type_offset = u32(dex, 64), u32(dex, 68)
    types = [u32(dex, type_offset + 4 * index) for index in range(type_size)]
    method_size, method_offset = u32(dex, 88), u32(dex, 92)

    owner = "Lj$/util/DesugarCollections;"
    owner_type = next((index for index, value in enumerate(types) if values[value] == owner), None)
    if owner_type is None:
        return False

    class_size, class_offset = u32(dex, 96), u32(dex, 100)
    for index in range(class_size):
        offset = class_offset + 32 * index
        if u32(dex, offset) != owner_type:
            continue
        cursor = u32(dex, offset + 24)  # class_data_off
        if cursor == 0:
            return False
        static_fields, cursor = uleb(dex, cursor)
        instance_fields, cursor = uleb(dex, cursor)
        direct_methods, cursor = uleb(dex, cursor)
        virtual_methods, cursor = uleb(dex, cursor)
        for _ in range(static_fields + instance_fields):
            _, cursor = uleb(dex, cursor)  # field_idx_diff
            _, cursor = uleb(dex, cursor)  # access_flags
        for methods in (direct_methods, virtual_methods):
            method_index = 0
            for _ in range(methods):
                method_diff, cursor = uleb(dex, cursor)
                method_index += method_diff
                _, cursor = uleb(dex, cursor)  # access_flags
                _, cursor = uleb(dex, cursor)  # code_off
                if method_index < method_size and values[u32(dex, method_offset + 8 * method_index + 4)] == "synchronizedMap":
                    return True
    return False


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: verify-androidtest-desugar-runtime.py <androidTest.apk>")
    with zipfile.ZipFile(sys.argv[1]) as apk:
        dex_files = [name for name in apk.namelist() if name.startswith("classes") and name.endswith(".dex")]
        if not any(owns_synchronized_map(apk.read(name)) for name in dex_files):
            raise SystemExit(
                "androidTest APK does not own j$.util.DesugarCollections.synchronizedMap; "
                "its core-library-desugaring runtime is incompatible with FragmentManager"
            )


if __name__ == "__main__":
    main()
