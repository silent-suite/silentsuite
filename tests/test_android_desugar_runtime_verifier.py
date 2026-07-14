"""Synthetic APK/DEX contracts for Keeper's desugar-runtime verifier."""

import importlib.util
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "desugar_runtime_verifier", ROOT / "android/scripts/verify-androidtest-desugar-runtime.py"
)
assert SPEC and SPEC.loader
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


def _uleb(value: int) -> bytes:
    result = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        result.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(result)


def synthetic_dex(owner, name="method", result="V", parameters=(), include_method=True) -> bytes:
    """Build the smallest DEX that defines one owner/method/prototype."""
    strings = list(dict.fromkeys([owner, name, result, *parameters, "L"]))
    type_names = list(dict.fromkeys([owner, result, *parameters]))
    header_size = 0x70
    string_off = header_size
    type_off = string_off + len(strings) * 4
    proto_off = type_off + len(type_names) * 4
    method_off = proto_off + 12
    class_off = method_off + 8
    data_off = class_off + 32
    type_index = {value: index for index, value in enumerate(type_names)}
    string_index = {value: index for index, value in enumerate(strings)}
    data = bytearray()
    parameter_off = 0
    if parameters:
        parameter_off = data_off
        data += struct.pack("<I", len(parameters))
        data += b"".join(struct.pack("<H", type_index[value]) for value in parameters)
    string_offsets = []
    for value in strings:
        string_offsets.append(data_off + len(data))
        data += _uleb(len(value)) + value.encode() + b"\0"
    class_data_off = data_off + len(data)
    data += bytes([0, 0, 1 if include_method else 0, 0])
    if include_method:
        data += bytes([0, 0, 0])
    file_size = data_off + len(data)
    dex = bytearray(file_size)
    dex[:8] = b"dex\n035\0"
    struct.pack_into("<I", dex, 32, file_size)
    struct.pack_into("<I", dex, 36, header_size)
    struct.pack_into("<I", dex, 40, 0x12345678)
    struct.pack_into("<II", dex, 56, len(strings), string_off)
    struct.pack_into("<II", dex, 64, len(type_names), type_off)
    struct.pack_into("<II", dex, 72, 1, proto_off)
    struct.pack_into("<II", dex, 88, 1, method_off)
    struct.pack_into("<II", dex, 96, 1, class_off)
    struct.pack_into("<II", dex, 104, len(data), data_off)
    for index, offset in enumerate(string_offsets):
        struct.pack_into("<I", dex, string_off + index * 4, offset)
    for index, value in enumerate(type_names):
        struct.pack_into("<I", dex, type_off + index * 4, string_index[value])
    struct.pack_into("<III", dex, proto_off, string_index["L"], type_index[result], parameter_off)
    struct.pack_into("<HHI", dex, method_off, 0, 0, string_index[name])
    struct.pack_into("<I", dex, class_off, 0)
    struct.pack_into("<I", dex, class_off + 24, class_data_off)
    dex[data_off:] = data
    return bytes(dex)


def apk(directory: Path, name: str, *dexes: bytes) -> Path:
    path = directory / name
    with zipfile.ZipFile(path, "w") as archive:
        for index, dex in enumerate(dexes, 1):
            archive.writestr("classes.dex" if index == 1 else f"classes{index}.dex", dex)
    return path


class DesugarRuntimeVerifierTest(unittest.TestCase):
    def target_dexes(self):
        return (
            synthetic_dex("Lj$/util/DesugarCollections;", "synchronizedMap", "Ljava/util/Map;", ("Ljava/util/Map;",)),
            synthetic_dex("Lj$/util/Objects;", "hash", "I", ("[Ljava/lang/Object;",)),
        )

    def test_target_owns_exact_required_abis_and_test_owns_no_j_dollar_classes(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            VERIFIER.verify_apks(
                str(apk(directory, "target.apk", *self.target_dexes())),
                str(apk(directory, "test.apk", synthetic_dex("Lexample/Test;", include_method=False))),
            )

    def test_forbidden_test_j_dollar_definition_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            with self.assertRaisesRegex(VERIFIER.VerificationError, "defines j\\$ classes"):
                VERIFIER.verify_apks(
                    str(apk(directory, "target.apk", *self.target_dexes())),
                    str(apk(directory, "test.apk", synthetic_dex("Lj$/util/Objects;", include_method=False))),
                )

    def test_missing_or_wrong_target_prototype_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            target = apk(directory, "target.apk", synthetic_dex(
                "Lj$/util/DesugarCollections;", "synchronizedMap", "Ljava/util/Map;", ("Ljava/util/Map;",)
            ), synthetic_dex("Lj$/util/Objects;", "hash", "I", ("Ljava/lang/Object;",)))
            test = apk(directory, "test.apk", synthetic_dex("Lexample/Test;", include_method=False))
            with self.assertRaisesRegex(VERIFIER.VerificationError, "Objects.hash"):
                VERIFIER.verify_apks(str(target), str(test))

    def test_real_dex_mutf8_nul_is_accepted(self):
        self.assertEqual(VERIFIER.decode_mutf8(b"a\xc0\x80b"), "a\0b")

    def test_malformed_dex_is_a_controlled_verification_error(self):
        mutations = [
            lambda dex: dex[:80],
            lambda dex: dex[:56] + struct.pack("<I", len(dex) + 1) + dex[60:],
            lambda dex: dex[:-1] + b"\x80",
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate), self.assertRaises(VERIFIER.VerificationError):
                VERIFIER.Dex(mutate(synthetic_dex("Lexample/Test;")))

    def test_malformed_apk_is_a_controlled_verification_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "broken.apk"
            path.write_bytes(b"not a zip")
            with self.assertRaises(VERIFIER.VerificationError):
                VERIFIER.verify_apks(str(path), str(path))
