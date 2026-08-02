import hashlib
import os
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / "bridge" / "install.sh"
BINARY_BODY = "#!/bin/sh\nexit 0\n"
BINARY_HASH = hashlib.sha256(BINARY_BODY.encode()).hexdigest()


def executable(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)


def installer_path(tmp_path: Path, *, verifier: str | None) -> Path:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    for command in ("awk", "chmod", "cut", "grep", "head", "mkdir", "mktemp", "mv", "rm", "sleep", "tail", "tr", "wc"):
        target = Path("/usr/bin") / command
        if not target.exists():
            target = Path("/bin") / command
        (fake_bin / command).symlink_to(target)
    if verifier:
        target = Path("/usr/bin") / verifier
        if not target.exists():
            target = Path("/bin") / verifier
        (fake_bin / verifier).symlink_to(target)
    executable(fake_bin / "uname", "#!/bin/sh\n[ \"${1:-}\" = \"-s\" ] && echo Linux || echo x86_64\n")
    executable(
        fake_bin / "curl",
        """#!/bin/sh
raw_args=$*
url=''
out=''
while [ "$#" -gt 0 ]; do
    case "$1" in
        -o) out=$2; shift 2 ;;
        http*) url=$1; shift ;;
        *) shift ;;
    esac
done
case "$url" in
    *api.github.com*/releases*)
        printf '%s\n' '[' '  "browser_download_url": "https://download.test/silentsuite-bridge-linux-x86_64"' ']'
        ;;
    https://download.test/*)
        case "$url" in
            *.sha256)
                [ "${CHECKSUM_CASE:-}" != "fetch-failure" ] || exit 22
                if [ -n "$out" ]; then printf '%s' "${CHECKSUM_BODY:-}" > "$out"; else printf '%s' "${CHECKSUM_BODY:-}"; fi
                ;;
            *) printf '%s' "$BINARY_BODY" > "$out" ;;
        esac
        ;;
    *) printf 'unexpected test URL: %s (args: %s)\n' "$url" "$raw_args" >&2; exit 22 ;;
esac
exit 0
""",
    )
    return fake_bin


def run_installer(tmp_path: Path, checksum_case: str, checksum_body: str, verifier: str | None = "sha256sum"):
    fake_bin = installer_path(tmp_path, verifier=verifier)
    install_dir = tmp_path / "install"
    env = {
        **os.environ,
        "PATH": str(fake_bin),
        "HOME": str(tmp_path / "home"),
        "SILENTSUITE_INSTALL_DIR": str(install_dir),
        "CHECKSUM_CASE": checksum_case,
        "CHECKSUM_BODY": checksum_body,
        "BINARY_BODY": BINARY_BODY,
        "TMPDIR": str(tmp_path),
    }
    (tmp_path / "home").mkdir()
    result = subprocess.run(
        ["/bin/sh", str(INSTALLER)],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=20,
    )
    leftovers = sorted(path.name for path in tmp_path.glob("tmp.*"))
    return result, install_dir / "silentsuite-bridge", leftovers


@pytest.mark.parametrize(
    ("checksum_case", "checksum_body", "verifier"),
    [
        ("valid", "", None),
        ("fetch-failure", "", "sha256sum"),
        ("valid", "", "sha256sum"),
        ("valid", "not-a-checksum\n", "sha256sum"),
        ("valid", f"{'0' * 64}  silentsuite-bridge-linux-x86_64\n", "sha256sum"),
        ("valid", f"{'0' * 64}  one\n{'1' * 64}  two\n", "sha256sum"),
        ("valid", f"{'0' * 64}  silentsuite-bridge-linux-x86_64 extra\n", "sha256sum"),
        ("valid", f"{'0' * 64}  wrong-artifact\n", "sha256sum"),
        ("valid", f"\n{'0' * 64}  silentsuite-bridge-linux-x86_64\nextra\n", "sha256sum"),
        ("valid", f"\n{BINARY_HASH}  silentsuite-bridge-linux-x86_64\n", "sha256sum"),
        ("valid", f"{BINARY_HASH}  silentsuite-bridge-linux-x86_64\n\n", "sha256sum"),
        ("valid", f"{BINARY_HASH}  silentsuite-bridge-linux-x86_64", "sha256sum"),
    ],
)
def test_unix_installer_fails_closed_and_removes_downloads(
    tmp_path: Path,
    checksum_case: str,
    checksum_body: str,
    verifier: str | None,
):
    result, installed, leftovers = run_installer(tmp_path, checksum_case, checksum_body, verifier)

    assert result.returncode != 0
    assert not installed.exists()
    assert leftovers == []


def test_unix_installer_accepts_one_exact_matching_checksum(tmp_path: Path):
    result, installed, leftovers = run_installer(
        tmp_path,
        "valid",
        f"{BINARY_HASH}  silentsuite-bridge-linux-x86_64\n",
    )

    assert result.returncode == 0, result.stderr
    assert installed.read_text(encoding="utf-8") == BINARY_BODY
    assert os.access(installed, os.X_OK)
    assert leftovers == []
