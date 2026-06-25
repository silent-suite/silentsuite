from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "bridge" / "install.ps1"
DOCS = ROOT / "apps" / "docs" / "user-guide" / "apps" / "dav-bridge.md"
WINDOWS_WORKFLOW = ROOT / ".github" / "workflows" / "test-bridge-windows.yml"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_windows_installer_error_helper_does_not_exit_parent_powershell():
    script = read(INSTALLER)
    helper_match = re.search(r"function\s+Write-Err\s*\([^)]*\)\s*\{(?P<body>.*?)\n\}", script, re.DOTALL)
    assert helper_match, "installer should define a Write-Err helper"
    helper_body = helper_match.group("body")

    assert not re.search(r"\bexit\b", helper_body, re.IGNORECASE), (
        "Write-Err must not call exit; under `irm ... | iex` that can close the user's PowerShell window"
    )
    assert re.search(r"\bthrow\b", helper_body, re.IGNORECASE), (
        "Write-Err should throw so failures are visible without terminating the parent host"
    )


def test_windows_installer_has_top_level_error_log_and_interactive_pause():
    script = read(INSTALLER)

    assert "$InstallLog" in script
    assert "%LOCALAPPDATA%" in script or "$env:LOCALAPPDATA" in script
    assert "Press Enter to close" in script
    assert re.search(r"try\s*\{", script, re.IGNORECASE)
    assert re.search(r"catch\s*\{", script, re.IGNORECASE)


def test_windows_installer_fails_closed_on_checksum_mismatch():
    script = read(INSTALLER)
    checksum_block = script[script.index("# --- Verify SHA256 checksum ---"):script.index("# --- Install binary ---")]

    assert "No checksum asset found" in checksum_block
    assert "refusing to install an unverified binary" in checksum_block
    assert "Invalid checksum content" in checksum_block
    assert "Could not verify checksum" in checksum_block
    assert "Write-Warn" not in checksum_block

    mismatch_match = re.search(
        r"if\s*\(\$ExpectedHash\s+-ne\s+\$ActualHash\)\s*\{(?P<body>.*?)\n\s*\}\s*else\s*\{(?P<else_body>.*?)\n\s*\}",
        checksum_block,
        re.DOTALL,
    )
    assert mismatch_match, "installer should explicitly compare expected and actual SHA256 hashes"
    mismatch_body = mismatch_match.group("body")
    else_body = mismatch_match.group("else_body")

    assert "Remove-Item $TmpFile" in mismatch_body
    assert "Write-Err" in mismatch_body
    assert "Write-Ok \"Checksum verified\"" in else_body


def test_bridge_docs_link_direct_windows_asset_and_visible_error_recovery():
    docs = read(DOCS)

    assert "silentsuite-bridge-windows-x86_64.exe" in docs
    assert "silentsuite-bridge-windows-x86_64.exe.sha256" in docs
    assert "already-open PowerShell" in docs or "already-open Windows Terminal" in docs
    assert "-OutFile" in docs and "-File" in docs


def test_windows_github_actions_workflow_covers_installer_and_binary_smoke_tests():
    workflow = read(WINDOWS_WORKFLOW)

    assert "windows-latest" in workflow
    assert "install.ps1" in workflow
    assert "PSScriptAnalyzer" in workflow
    assert "Write-Err" in workflow
    assert "silentsuite-bridge --version" in workflow or "silentsuite-bridge.exe --version" in workflow
