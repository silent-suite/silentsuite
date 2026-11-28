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
    http://localhost:37358*|http://127.0.0.1:37358*) printf 'ready\n' ;;
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


def run_installer(
    tmp_path: Path,
    checksum_case: str,
    checksum_body: str,
    verifier: str | None = "sha256sum",
    binary_body: str = BINARY_BODY,
):
    fake_bin = installer_path(tmp_path, verifier=verifier)
    install_dir = tmp_path / "install"
    env = {
        **os.environ,
        "PATH": str(fake_bin),
        "HOME": str(tmp_path / "home"),
        "SILENTSUITE_INSTALL_DIR": str(install_dir),
        "CHECKSUM_CASE": checksum_case,
        "CHECKSUM_BODY": checksum_body,
        "BINARY_BODY": binary_body,
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
    assert "Auto-start configured" in result.stdout
    assert "Auto-start was not confirmed" not in result.stdout


AUTOSTART_FAILING_BODY = '#!/bin/sh\n[ "${1:-}" = "--install-autostart" ] && exit 1\nexit 0\n'


def test_unix_installer_does_not_claim_autostart_when_install_autostart_fails(tmp_path: Path):
    body_hash = hashlib.sha256(AUTOSTART_FAILING_BODY.encode()).hexdigest()

    result, installed, leftovers = run_installer(
        tmp_path,
        "valid",
        f"{body_hash}  silentsuite-bridge-linux-x86_64\n",
        binary_body=AUTOSTART_FAILING_BODY,
    )

    assert result.returncode == 0, result.stderr
    assert installed.exists()
    assert leftovers == []
    assert "Auto-start configured" not in result.stdout
    assert "Auto-start was not confirmed" in result.stdout
    assert "--install-autostart" in result.stdout


LIFECYCLE_BINARY = r'''#!/bin/sh
printf '%s\n' "${1:-}" >> "$LIFECYCLE_LOG"
case "${1:-}" in
    --login)
        [ "$LOGIN_OK" = 1 ] || exit 1
        : > "$ACCOUNT_FILE"
        ;;
    --install-autostart)
        if [ "$SERVICE_ANSWERS" = 1 ]; then
            : > "$READY_FILE"
            if [ -f "$ACCOUNT_FILE" ]; then echo yes; else echo no; fi > "$SERVICE_ACCOUNT"
        fi
        [ "$AUTOSTART_OK" = 1 ] || exit 1
        ;;
    --no-tray)
        printf 'fallback\n' >> "$FALLBACK_LOG"
        [ "$FALLBACK_OK" = 1 ] || exit 1
        : > "$READY_FILE"
        if [ -f "$ACCOUNT_FILE" ]; then echo yes; else echo no; fi > "$SERVICE_ACCOUNT"
        ;;
esac
exit 0
'''


def lifecycle_installer(tmp_path, *, login, autostart, responder, fallback):
    fake_bin = installer_path(tmp_path, verifier="sha256sum")
    (fake_bin / "sleep").unlink()
    executable(fake_bin / "sleep", "#!/bin/sh\nexit 0\n")
    curl = fake_bin / "curl"
    source = curl.read_text(encoding="utf-8")
    source = source.replace(
        'case "$url" in\n',
        '''case "$url" in
    http://localhost:37358*|http://127.0.0.1:37358*)
        printf 'probe\\n' >> "$PROBE_LOG"
        [ -f "$READY_FILE" ] || exit 7
        printf 'ready\\n'
        exit 0
        ;;
''',
        1,
    )
    executable(curl, source)
    # Also provide date if the bounded probe uses a deadline.
    (fake_bin / "date").symlink_to("/bin/date")
    home = tmp_path / "home"
    home.mkdir()
    install_dir = tmp_path / "install"
    env = {
        **os.environ, "PATH": str(fake_bin), "HOME": str(home),
        "SILENTSUITE_INSTALL_DIR": str(install_dir), "TMPDIR": str(tmp_path),
        "CHECKSUM_CASE": "valid", "BINARY_BODY": LIFECYCLE_BINARY,
        "CHECKSUM_BODY": hashlib.sha256(LIFECYCLE_BINARY.encode()).hexdigest()
        + "  silentsuite-bridge-linux-x86_64\n",
        "LOGIN_OK": "1" if login == "ok" else "0",
        "AUTOSTART_OK": str(int(autostart)), "SERVICE_ANSWERS": str(int(responder)),
        "FALLBACK_OK": str(int(fallback)),
        "LIFECYCLE_LOG": str(tmp_path / "calls"), "FALLBACK_LOG": str(tmp_path / "fallbacks"),
        "PROBE_LOG": str(tmp_path / "probes"), "READY_FILE": str(tmp_path / "ready"),
        "ACCOUNT_FILE": str(tmp_path / "account"), "SERVICE_ACCOUNT": str(tmp_path / "service-account"),
    }
    if login != "skip":
        return subprocess.run(["/bin/sh", str(INSTALLER)], env=env, cwd=ROOT,
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)

    import fcntl
    import pty
    import termios

    master, slave = pty.openpty()

    def controlling_terminal():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    try:
        process = subprocess.Popen(["/bin/sh", str(INSTALLER)], env=env, cwd=ROOT,
                                   stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, preexec_fn=controlling_terminal)
        os.write(master, b"n\n")
        try:
            stdout, stderr = process.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise
        return subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
    finally:
        os.close(master)
        os.close(slave)


@pytest.mark.parametrize("login", ["ok", "failed", "skip"])
@pytest.mark.parametrize("autostart,responder,fallback", [
    (True, True, True), (False, True, True),
    (False, False, True), (False, False, False),
], ids=["service", "unconfirmed-running", "fallback", "fallback-failed"])
def test_unix_installer_orders_login_and_one_observed_start(tmp_path, login, autostart, responder, fallback):
    result = lifecycle_installer(tmp_path, login=login, autostart=autostart,
                                responder=responder, fallback=fallback)
    assert result.returncode == 0, result.stderr
    calls = (tmp_path / "calls").read_text().splitlines()
    assert calls.count("--install-autostart") == 1
    if login == "skip":
        assert "--login" not in calls
    else:
        assert calls.index("--login") < calls.index("--install-autostart"), calls
    fallback_calls = (tmp_path / "fallbacks").read_text().splitlines() if (tmp_path / "fallbacks").exists() else []
    assert len(fallback_calls) == int(not autostart and not responder), calls
    assert (tmp_path / "probes").exists(), "the final running claim needs an observed listener"
    if not responder and not fallback:
        assert "Bridge is running" not in result.stdout
    if not autostart:
        assert "Auto-start was not confirmed" in result.stdout
        assert "Auto-start configured" not in result.stdout
    if login == "ok" and (responder or fallback):
        assert (tmp_path / "service-account").read_text().strip() == "yes"
    # The summary names a sign-in route only when login was skipped or failed,
    # and never promises a background service it did not observe.
    assert ("Sign in:" in result.stdout) == (login != "ok"), result.stdout
    assert "runs in the background" not in result.stdout
