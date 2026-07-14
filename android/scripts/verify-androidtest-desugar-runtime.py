#!/usr/bin/env python3
"""Verify Keeper's single-owner core-library-desugaring runtime contract."""

from __future__ import annotations

import struct
import sys
import zipfile


class VerificationError(Exception):
    """A malformed APK/DEX or a missing runtime anchor."""


HEADER_SIZE = 0x70
MAP = "Ljava/util/Map;"
DESUGAR_COLLECTIONS = "Lj$/util/DesugarCollections;"
OBJECTS = "Lj$/util/Objects;"
REQUIRED_TARGET_METHODS = (
    (DESUGAR_COLLECTIONS, "synchronizedMap", MAP, (MAP,)),
    (OBJECTS, "hash", "I", ("[Ljava/lang/Object;",)),
)


def fail(message: str) -> None:
    raise VerificationError(message)


def checked_range(data: bytes, offset: int, size: int, what: str) -> None:
    if offset < 0 or size < 0 or offset > len(data) or size > len(data) - offset:
        fail(f"truncated or invalid {what}")


def u16(data: bytes, offset: int, what: str = "u16") -> int:
    checked_range(data, offset, 2, what)
    return struct.unpack_from("<H", data, offset)[0]


def u32(data: bytes, offset: int, what: str = "u32") -> int:
    checked_range(data, offset, 4, what)
    return struct.unpack_from("<I", data, offset)[0]


def uleb(data: bytes, offset: int, what: str = "ULEB128") -> tuple[int, int]:
    value = 0
    for shift in range(0, 35, 7):
        checked_range(data, offset, 1, what)
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            if shift == 28 and byte > 0x0F:
                fail(f"overflowing {what}")
            return value, offset
    fail(f"unterminated {what}")


class Dex:
    def __init__(self, data: bytes):
        self.data = data
        self._header()
        self.string_size, self.string_off = self._table(56, 4, "string_ids")
        self.type_size, self.type_off = self._table(64, 4, "type_ids")
        self.proto_size, self.proto_off = self._table(72, 12, "proto_ids")
        self.field_size, self.field_off = self._table(80, 8, "field_ids")
        self.method_size, self.method_off = self._table(88, 8, "method_ids")
        self.class_size, self.class_off = self._table(96, 32, "class_defs")
        self.strings = self._strings()
        self.types = self._types()
        self.protos = self._protos()
        self._fields()
        self.methods = self._methods()
        self._validate_class_data()

    def _header(self) -> None:
        checked_range(self.data, 0, HEADER_SIZE, "DEX header")
        if not self.data.startswith(b"dex\n") or self.data[7:8] != b"\0":
            fail("invalid DEX magic")
        if u32(self.data, 32, "file_size") != len(self.data):
            fail("DEX file_size does not match input")
        if u32(self.data, 36, "header_size") != HEADER_SIZE:
            fail("unexpected DEX header_size")
        if u32(self.data, 40, "endian_tag") != 0x12345678:
            fail("unsupported DEX endian tag")
        link_size, link_off = u32(self.data, 44, "link_size"), u32(self.data, 48, "link_off")
        if link_size:
            checked_range(self.data, link_off, link_size, "link section")
        elif link_off:
            fail("link_off without link_size")
        map_off = u32(self.data, 52, "map_off")
        if map_off:
            map_size = u32(self.data, map_off, "map_list size")
            checked_range(self.data, map_off + 4, map_size * 12, "map_list")
        data_size, data_off = u32(self.data, 104, "data_size"), u32(self.data, 108, "data_off")
        if data_size:
            checked_range(self.data, data_off, data_size, "data section")
        elif data_off:
            fail("data_off without data_size")

    def _table(self, header_offset: int, item_size: int, what: str) -> tuple[int, int]:
        size = u32(self.data, header_offset, f"{what}_size")
        offset = u32(self.data, header_offset + 4, f"{what}_off")
        if size:
            checked_range(self.data, offset, size * item_size, what)
        elif offset:
            fail(f"{what}_off without entries")
        return size, offset

    def _index(self, index: int, size: int, what: str) -> None:
        if index >= size:
            fail(f"invalid {what} index")

    def _strings(self) -> list[str]:
        values = []
        for index in range(self.string_size):
            cursor = u32(self.data, self.string_off + index * 4, "string_id")
            utf16_size, cursor = uleb(self.data, cursor, "string_data length")
            end = self.data.find(b"\0", cursor)
            if end < 0:
                fail("unterminated string_data")
            value = decode_mutf8(self.data[cursor:end])
            if len(value.encode("utf-16-le", "surrogatepass")) // 2 != utf16_size:
                fail("string_data UTF-16 length mismatch")
            values.append(value)
        return values

    def _types(self) -> list[int]:
        values = []
        for index in range(self.type_size):
            string_index = u32(self.data, self.type_off + index * 4, "type_id")
            self._index(string_index, self.string_size, "type string")
            values.append(string_index)
        return values

    def _type_descriptor(self, index: int) -> str:
        self._index(index, self.type_size, "type")
        return self.strings[self.types[index]]

    def _type_list(self, offset: int) -> tuple[int, ...]:
        if offset == 0:
            return ()
        size = u32(self.data, offset, "proto parameter list size")
        checked_range(self.data, offset + 4, size * 2, "proto parameter list")
        values = []
        for index in range(size):
            type_index = u16(self.data, offset + 4 + index * 2, "proto parameter type")
            self._index(type_index, self.type_size, "proto parameter type")
            values.append(type_index)
        return tuple(values)

    def _protos(self) -> list[tuple[int, tuple[int, ...]]]:
        values = []
        for index in range(self.proto_size):
            offset = self.proto_off + index * 12
            shorty = u32(self.data, offset, "proto shorty")
            result = u32(self.data, offset + 4, "proto return type")
            self._index(shorty, self.string_size, "proto shorty")
            self._index(result, self.type_size, "proto return type")
            values.append((result, self._type_list(u32(self.data, offset + 8, "proto parameters"))))
        return values

    def _methods(self) -> list[tuple[int, int, int]]:
        values = []
        for index in range(self.method_size):
            offset = self.method_off + index * 8
            owner, proto, name = u16(self.data, offset, "method owner"), u16(self.data, offset + 2, "method proto"), u32(self.data, offset + 4, "method name")
            self._index(owner, self.type_size, "method owner")
            self._index(proto, self.proto_size, "method proto")
            self._index(name, self.string_size, "method name")
            values.append((owner, proto, name))
        return values

    def _fields(self) -> None:
        for index in range(self.field_size):
            offset = self.field_off + index * 8
            owner, field_type, name = u16(self.data, offset, "field owner"), u16(self.data, offset + 2, "field type"), u32(self.data, offset + 4, "field name")
            self._index(owner, self.type_size, "field owner")
            self._index(field_type, self.type_size, "field type")
            self._index(name, self.string_size, "field name")

    def _validate_class_data(self) -> None:
        self.defined_methods: set[tuple[int, int]] = set()
        for class_index in range(self.class_size):
            offset = self.class_off + class_index * 32
            class_type = u32(self.data, offset, "class type")
            self._index(class_type, self.type_size, "class type")
            superclass = u32(self.data, offset + 4, "class superclass")
            if superclass != 0xFFFFFFFF:
                self._index(superclass, self.type_size, "class superclass")
            interfaces_off = u32(self.data, offset + 12, "class interfaces")
            if interfaces_off:
                self._type_list(interfaces_off)
            source_file = u32(self.data, offset + 16, "class source file")
            if source_file != 0xFFFFFFFF:
                self._index(source_file, self.string_size, "class source file")
            annotations_off = u32(self.data, offset + 20, "class annotations")
            if annotations_off:
                checked_range(self.data, annotations_off, 16, "annotation directory")
            class_data_off = u32(self.data, offset + 24, "class_data_off")
            if class_data_off:
                self._class_data(class_type, class_data_off)
            static_values_off = u32(self.data, offset + 28, "class static values")
            if static_values_off:
                _, _ = uleb(self.data, static_values_off, "static_values size")

    def _class_data(self, class_type: int, offset: int) -> None:
        static_fields, offset = uleb(self.data, offset, "class_data static_fields")
        instance_fields, offset = uleb(self.data, offset, "class_data instance_fields")
        direct_methods, offset = uleb(self.data, offset, "class_data direct_methods")
        virtual_methods, offset = uleb(self.data, offset, "class_data virtual_methods")
        for count in (static_fields, instance_fields):
            field_index = 0
            for _ in range(count):
                diff, offset = uleb(self.data, offset, "class_data field index")
                field_index += diff
                self._index(field_index, self.field_size, "class_data field")
                _, offset = uleb(self.data, offset, "class_data field flags")
        for count in (direct_methods, virtual_methods):
            method_index = 0
            for _ in range(count):
                diff, offset = uleb(self.data, offset, "class_data method index")
                method_index += diff
                self._index(method_index, self.method_size, "class_data method")
                if self.methods[method_index][0] != class_type:
                    fail("class_data method belongs to another class")
                self.defined_methods.add((class_type, method_index))
                _, offset = uleb(self.data, offset, "class_data method flags")
                code_off, offset = uleb(self.data, offset, "class_data method code offset")
                if code_off:
                    checked_range(self.data, code_off, 16, "code item")

    def defines_class_in(self, prefix: str) -> bool:
        return any(self._type_descriptor(u32(self.data, self.class_off + index * 32, "class type")).startswith(prefix)
                   for index in range(self.class_size))

    def owns_method(self, owner_descriptor: str, method_name: str, result_descriptor: str,
                    parameter_descriptors: tuple[str, ...]) -> bool:
        for method_index, (owner, proto, name) in enumerate(self.methods):
            if (owner, method_index) not in self.defined_methods:
                continue
            if self._type_descriptor(owner) != owner_descriptor or self.strings[name] != method_name:
                continue
            result, parameters = self.protos[proto]
            if (self._type_descriptor(result) == result_descriptor and
                    tuple(self._type_descriptor(value) for value in parameters) == parameter_descriptors):
                return True
        return False


def decode_mutf8(data: bytes) -> str:
    """Decode DEX's modified UTF-8, including its encoded NUL and UTF-16 surrogates."""
    units: list[int] = []
    cursor = 0
    while cursor < len(data):
        first = data[cursor]
        if first < 0x80:
            if first == 0:
                fail("embedded NUL in string_data")
            units.append(first)
            cursor += 1
        elif first & 0xE0 == 0xC0 and cursor + 1 < len(data) and data[cursor + 1] & 0xC0 == 0x80:
            unit = ((first & 0x1F) << 6) | (data[cursor + 1] & 0x3F)
            if unit < 0x80 and unit != 0:
                fail("overlong MUTF-8 string_data")
            units.append(unit)
            cursor += 2
        elif first & 0xF0 == 0xE0 and cursor + 2 < len(data) and all(byte & 0xC0 == 0x80 for byte in data[cursor + 1:cursor + 3]):
            unit = ((first & 0x0F) << 12) | ((data[cursor + 1] & 0x3F) << 6) | (data[cursor + 2] & 0x3F)
            if unit < 0x800:
                fail("overlong MUTF-8 string_data")
            units.append(unit)
            cursor += 3
        else:
            fail("invalid MUTF-8 string_data")
    return bytes(value for unit in units for value in (unit & 0xff, unit >> 8)).decode("utf-16-le", "surrogatepass")


def apk_dexes(path: str) -> list[Dex]:
    try:
        with zipfile.ZipFile(path) as apk:
            dex_files = [name for name in apk.namelist() if name.startswith("classes") and name.endswith(".dex")]
            if not dex_files:
                fail("APK contains no classes*.dex files")
            return [Dex(apk.read(name)) for name in dex_files]
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        fail(f"invalid APK: {error}")


def verify_apks(target_path: str, android_test_path: str) -> None:
    target_dexes = apk_dexes(target_path)
    test_dexes = apk_dexes(android_test_path)
    if any(dex.defines_class_in("Lj$/") for dex in test_dexes):
        fail("androidTest APK defines j$ classes; Keeper must clear its desugar DEX so the target APK is the sole runtime owner")
    for owner, name, result, parameters in REQUIRED_TARGET_METHODS:
        if not any(dex.owns_method(owner, name, result, parameters) for dex in target_dexes):
            fail(f"target debug APK does not define required desugar ABI {owner[1:-1]}.{name}{parameters}:{result}")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: verify-androidtest-desugar-runtime.py <target-debug.apk> <debug-androidTest.apk>")
    try:
        verify_apks(sys.argv[1], sys.argv[2])
    except Exception as error:
        # Every malformed or unexpected input is a verification failure, never a traceback/pass.
        print(f"verification error: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
