#!/bin/sh
# SilentSuite Bridge — One-line installer
#
# Usage:
#   curl -fsSL https://silentsuite.io/bridge/install.sh | sh
#
# This script:
# 1. Detects OS and architecture
# 2. Downloads the correct binary from GitHub Releases
# 3. Installs to ~/.local/bin/
# 4. Sets up auto-start (systemd / launchd)
# 5. Launches the bridge (opens browser for first-time login)
#
# Everything is automatic — no prompts, no questions.
#
# License: AGPL-3.0

set -e

cleanup() { rm -f "$TMP_FILE"; }
trap cleanup EXIT

# --- Configuration ---
REPO="silent-suite/silentsuite"
BINARY_NAME="silentsuite-bridge"
INSTALL_DIR="${SILENTSUITE_INSTALL_DIR:-$HOME/.local/bin}"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info()  { printf "${GREEN}  ✓${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}  !${NC} %s\n" "$1"; }
error() { printf "${RED}  ✗${NC} %s\n" "$1" >&2; exit 1; }
step()  { printf "\n${BOLD}%s${NC}\n" "$1"; }

# --- Interactive detection ---
# When run via `curl | sh`, stdin is the pipe, not a terminal.
# Detect this so we can default to yes for prompts.
if [ -t 0 ]; then
    INTERACTIVE=true
else
    INTERACTIVE=false
fi

# Read user input: from /dev/tty if interactive, else default yes
prompt_yn() {
    if [ "$INTERACTIVE" = true ]; then
        printf "%s [Y/n] " "$1"
        read -r answer </dev/tty
        case "$answer" in
            [nN]*) return 1 ;;
            *) return 0 ;;
        esac
    else
        # Non-interactive (piped): default yes
        return 0
    fi
}

# --- Detect OS ---
detect_os() {
    case "$(uname -s)" in
        Linux*)  OS="linux" ;;
        Darwin*) OS="macos" ;;
        MINGW*|MSYS*|CYGWIN*) error "Windows detected. Download the .exe from https://github.com/${REPO}/releases" ;;
        *)       error "Unsupported OS: $(uname -s)" ;;
    esac
}

# --- Detect Architecture ---
detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64)  ARCH="x86_64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *)             error "Unsupported architecture: $(uname -m)" ;;
    esac
}

# --- Get latest release URL ---
get_download_url() {
    RELEASE_URL="https://api.github.com/repos/${REPO}/releases/latest"
    ASSET_NAME="${BINARY_NAME}-${OS}-${ARCH}"

    if command -v curl >/dev/null 2>&1; then
        DOWNLOAD_URL=$(curl -fsSL "$RELEASE_URL" 2>/dev/null | \
            grep "browser_download_url.*${ASSET_NAME}" | \
            head -1 | \
            cut -d '"' -f 4)
    elif command -v wget >/dev/null 2>&1; then
        DOWNLOAD_URL=$(wget -qO- "$RELEASE_URL" 2>/dev/null | \
            grep "browser_download_url.*${ASSET_NAME}" | \
            head -1 | \
            cut -d '"' -f 4)
    else
        error "Neither curl nor wget found. Please install one of them."
    fi

    if [ -z "$DOWNLOAD_URL" ]; then
        error "No release found for ${ASSET_NAME}. Check https://github.com/${REPO}/releases"
    fi
}

# --- Download and install ---
install_binary() {
    mkdir -p "$INSTALL_DIR"

    TMP_FILE=$(mktemp)
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$DOWNLOAD_URL" -o "$TMP_FILE"
    else
        wget -qO "$TMP_FILE" "$DOWNLOAD_URL"
    fi

    # Verify checksum if available
    CHECKSUM_URL="${DOWNLOAD_URL}.sha256"
    if command -v sha256sum >/dev/null 2>&1; then
        SHA256CMD="sha256sum"
    elif command -v shasum >/dev/null 2>&1; then
        SHA256CMD="shasum -a 256"
    else
        SHA256CMD=""
    fi

    if [ -n "$SHA256CMD" ]; then
        if command -v curl >/dev/null 2>&1; then
            EXPECTED_HASH=$(curl -fsSL "$CHECKSUM_URL" 2>/dev/null | awk '{print $1}' || true)
        else
            EXPECTED_HASH=$(wget -qO- "$CHECKSUM_URL" 2>/dev/null | awk '{print $1}' || true)
        fi
        if [ -n "$EXPECTED_HASH" ]; then
            ACTUAL_HASH=$($SHA256CMD "$TMP_FILE" | awk '{print $1}')
            if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
                rm -f "$TMP_FILE"
                error "Checksum mismatch! Download may be corrupted."
            fi
            info "Checksum verified"
        fi
    fi

    mv "$TMP_FILE" "${INSTALL_DIR}/${BINARY_NAME}"
    chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
    info "Installed to ${INSTALL_DIR}/${BINARY_NAME}"
}

# --- Ensure PATH ---
ensure_path() {
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) return ;;
    esac

    # Add to shell profiles
    ADDED=false
    for profile in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
        if [ -f "$profile" ]; then
            if ! grep -q "$INSTALL_DIR" "$profile" 2>/dev/null; then
                printf '\n# SilentSuite Bridge\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$profile"
                ADDED=true
            fi
        fi
    done

    if [ "$ADDED" = true ]; then
        info "Added ${INSTALL_DIR} to PATH (restart your shell or run: export PATH=\"${INSTALL_DIR}:\$PATH\")"
    fi

    # Make it available for this script
    export PATH="${INSTALL_DIR}:${PATH}"
}

# --- Setup auto-start ---
setup_autostart() {
    "${INSTALL_DIR}/${BINARY_NAME}" --install-autostart 2>/dev/null && \
        info "Auto-start configured" || \
        warn "Could not set up auto-start (you can do it later with: ${BINARY_NAME} --install-autostart)"
}

# --- Main ---
main() {
    printf "\n${BOLD}  SilentSuite Bridge${NC}\n"
    printf "  E2EE CalDAV/CardDAV sync for your desktop apps\n"

    step "Detecting system..."
    detect_os
    detect_arch
    info "Platform: ${OS}/${ARCH}"

    step "Downloading..."
    get_download_url
    install_binary
    ensure_path

    step "Setting up auto-start..."
    setup_autostart
    info "Auto-start configured. Remove with: ${BINARY_NAME} --remove-autostart"

    DASHBOARD_URL="http://localhost:37358/.web/"

    if prompt_yn "Log in to SilentSuite now?"; then
        step "Launching..."
        printf "\n  Opening your browser to sign in.\n"
        printf "  After login, the bridge runs in the background.\n\n"

        # Run login flow — don't let failure kill the script
        if "${INSTALL_DIR}/${BINARY_NAME}" --login; then
            # Start bridge daemon in background
            "${INSTALL_DIR}/${BINARY_NAME}" --no-tray &
            sleep 2
            info "Bridge is running! Dashboard: http://localhost:37358/.web/"
            info "Bookmark that URL to find your connection details later."
        else
            warn "Login did not complete. You can log in later with:"
            printf "    ${BINARY_NAME} --login\n"
        fi
    fi

    # Print status and dashboard URL
    step "Setup complete!"
    printf "\n  ${GREEN}Bridge installed.${NC}\n"
    printf "  Dashboard: ${BLUE}${DASHBOARD_URL}${NC}\n"
    printf "  Log in:    ${BLUE}${BINARY_NAME} --login${NC}\n"
    printf "  Full docs: ${BLUE}https://docs.silentsuite.io/bridge${NC}\n\n"
}

main "$@"
