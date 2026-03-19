#!/bin/sh
# SilentSuite Bridge — One-line installer
#
# Usage:
#   curl -fsSL https://silentsuite.io/bridge/install.sh | sh
#
# This script:
# 1. Detects OS and architecture
# 2. Downloads the correct binary from GitHub Releases
# 3. Installs to ~/.local/bin/ (or /usr/local/bin/ with sudo)
# 4. Sets up auto-start
# 5. Runs first-time login
#
# License: AGPL-3.0

set -e

# --- Configuration ---
REPO="silent-suite/silentsuite-bridge"
BINARY_NAME="silentsuite-bridge"
INSTALL_DIR="${SILENTSUITE_INSTALL_DIR:-$HOME/.local/bin}"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() { printf "${GREEN}[info]${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}[warn]${NC} %s\n" "$1"; }
error() { printf "${RED}[error]${NC} %s\n" "$1" >&2; exit 1; }

# --- Detect OS ---
detect_os() {
    case "$(uname -s)" in
        Linux*)  OS="linux" ;;
        Darwin*) OS="macos" ;;
        *)       error "Unsupported OS: $(uname -s). Use Windows PowerShell installer instead." ;;
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

    # Construct expected asset name
    ASSET_NAME="${BINARY_NAME}-${OS}-${ARCH}"
    if [ "$OS" = "macos" ]; then
        ASSET_NAME="${BINARY_NAME}-macos-${ARCH}"
    fi

    info "Fetching latest release from ${REPO}..."

    # Try to get the download URL from GitHub API
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
        error "Could not find release for ${ASSET_NAME}. Check https://github.com/${REPO}/releases"
    fi
}

# --- Download and install ---
install_binary() {
    info "Downloading ${BINARY_NAME} for ${OS}/${ARCH}..."

    # Create install directory
    mkdir -p "$INSTALL_DIR"

    # Download
    TMP_FILE=$(mktemp)
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$DOWNLOAD_URL" -o "$TMP_FILE"
    else
        wget -qO "$TMP_FILE" "$DOWNLOAD_URL"
    fi

    # Verify checksum if available
    CHECKSUM_URL="${DOWNLOAD_URL}.sha256"
    if command -v sha256sum >/dev/null 2>&1; then
        EXPECTED_HASH=$(curl -fsSL "$CHECKSUM_URL" 2>/dev/null | awk '{print $1}')
        if [ -n "$EXPECTED_HASH" ]; then
            ACTUAL_HASH=$(sha256sum "$TMP_FILE" | awk '{print $1}')
            if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
                rm -f "$TMP_FILE"
                error "Checksum mismatch! Expected: ${EXPECTED_HASH}, Got: ${ACTUAL_HASH}"
            fi
            info "Checksum verified."
        fi
    fi

    # Install
    mv "$TMP_FILE" "${INSTALL_DIR}/${BINARY_NAME}"
    chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

    info "Installed to ${INSTALL_DIR}/${BINARY_NAME}"
}

# --- Ensure PATH ---
ensure_path() {
    if ! echo "$PATH" | grep -q "$INSTALL_DIR"; then
        warn "${INSTALL_DIR} is not in your PATH."
        warn "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
        printf "  export PATH=\"%s:\$PATH\"\n" "$INSTALL_DIR"
        echo ""

        # Try to add to common shell profiles
        for profile in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
            if [ -f "$profile" ]; then
                if ! grep -q "$INSTALL_DIR" "$profile" 2>/dev/null; then
                    printf '\n# SilentSuite Bridge\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$profile"
                    info "Added to ${profile}"
                fi
            fi
        done
    fi
}

# --- Setup auto-start ---
setup_autostart() {
    info "Setting up auto-start..."
    "${INSTALL_DIR}/${BINARY_NAME}" --install-autostart 2>/dev/null || true
}

# --- First-time login ---
first_login() {
    info "Starting first-time login..."
    echo ""
    "${INSTALL_DIR}/${BINARY_NAME}" --login
}

# --- Main ---
main() {
    echo ""
    echo "  SilentSuite Bridge — Installer"
    echo "  ==============================="
    echo ""

    detect_os
    detect_arch
    info "Detected: ${OS}/${ARCH}"

    get_download_url
    install_binary
    ensure_path

    echo ""
    info "Installation complete!"
    echo ""

    # Ask about auto-start
    printf "Set up auto-start (start bridge on login)? [Y/n] "
    read -r answer
    case "$answer" in
        [nN]*) info "Skipping auto-start." ;;
        *)     setup_autostart ;;
    esac

    echo ""

    # Check if already logged in
    if "${INSTALL_DIR}/${BINARY_NAME}" --version >/dev/null 2>&1; then
        printf "Log in to SilentSuite now? [Y/n] "
        read -r answer
        case "$answer" in
            [nN]*) info "You can log in later with: silentsuite-bridge --login" ;;
            *)     first_login ;;
        esac
    fi

    echo ""
    info "Done! Start the bridge with: silentsuite-bridge"
    echo ""
}

main "$@"
