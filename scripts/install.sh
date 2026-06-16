#!/usr/bin/env bash
# DvalinCode one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/arthurpanhku/dvalincode/main/scripts/install.sh | bash
#
# What it does:
#   1. Detects your OS + arch.
#   2. Downloads the matching release archive from GitHub.
#   3. Extracts to ~/.dvalincode/.
#   4. Adds ~/.dvalincode/bin to your PATH (via ~/.bashrc / ~/.zshrc).
#
# Environment variables:
#   DVALINCODE_VERSION=v0.2.0   # pin to a specific version
#   DVALINCODE_HOME=~/foo       # install to a different directory

set -euo pipefail

REPO="arthurpanhku/dvalincode"
INSTALL_DIR="${DVALINCODE_HOME:-$HOME/.dvalincode}"

# ── Colors ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''; C_BLUE=''; C_GREEN=''; C_RED=''; C_YELLOW=''
fi

log()   { printf "%s▶%s %s\n" "$C_BLUE" "$C_RESET" "$*"; }
ok()    { printf "%s✓%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf "%s!%s %s\n" "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail()  { printf "%sx%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# ── Detect platform ───────────────────────────────────────────────────
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="macos" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *) fail "Unsupported OS: $os" ;;
  esac

  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *) fail "Unsupported arch: $arch" ;;
  esac

  # Windows: only x64 published
  if [ "$os" = "windows" ] && [ "$arch" = "arm64" ]; then
    fail "Windows ARM64 builds are not yet available."
  fi

  echo "${os}-${arch}"
}

PLATFORM="$(detect_platform)"
log "Detected platform: ${C_BOLD}${PLATFORM}${C_RESET}"

# ── Find latest version ───────────────────────────────────────────────
if [ -n "${DVALINCODE_VERSION:-}" ]; then
  VERSION="$DVALINCODE_VERSION"
  log "Pinned to version ${C_BOLD}${VERSION}${C_RESET}"
else
  log "Fetching latest release…"
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep -m1 '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')"
  [ -n "$VERSION" ] || fail "Could not detect latest version. Check your network and GitHub access."
  ok "Latest is ${C_BOLD}${VERSION}${C_RESET}"
fi

# ── Build URL ─────────────────────────────────────────────────────────
case "$PLATFORM" in
  windows-*) EXT="zip" ;;
  *)         EXT="tar.gz" ;;
esac
FILE="dvalincode-${VERSION}-${PLATFORM}.${EXT}"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${FILE}"

# ── Download ──────────────────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "Downloading ${C_DIM}${URL}${C_RESET}"
if ! curl -fSL -o "${TMP}/${FILE}" "$URL"; then
  fail "Download failed. The release may not include a build for your platform."
fi
ok "Downloaded $(du -sh "${TMP}/${FILE}" | cut -f1)"

# ── Extract ───────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
log "Extracting to ${C_BOLD}${INSTALL_DIR}${C_RESET}"

if [ "$EXT" = "zip" ]; then
  if ! command -v unzip >/dev/null 2>&1; then
    fail "'unzip' is required but not installed."
  fi
  unzip -q -o "${TMP}/${FILE}" -d "$TMP"
else
  tar xzf "${TMP}/${FILE}" -C "$TMP"
fi

# Archive top-level dir is e.g. dvalincode-macos-arm64/
ARCHIVE_ROOT="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d -name 'dvalincode-*' | head -1)"
[ -n "$ARCHIVE_ROOT" ] || fail "Could not find extracted directory."

# The binary resolves web/dist/ relative to its own location, so the binary
# must live at $INSTALL_DIR/ (not a bin/ subdirectory) and web/ must be
# adjacent: $INSTALL_DIR/web/dist/.  A thin wrapper at bin/dvalincode
# exec's the real binary so PATH stays tidy.

rm -rf "${INSTALL_DIR}/web" "${INSTALL_DIR}/bin" "${INSTALL_DIR}/dvalincode"
mkdir -p "${INSTALL_DIR}/bin"
cp -r "${ARCHIVE_ROOT}/web" "${INSTALL_DIR}/web"

# Find and place the actual binary at $INSTALL_DIR/ root
BIN_SRC="$(find "$ARCHIVE_ROOT" -maxdepth 1 -type f \( -name 'dvalincode-*' -o -name 'dvalincode-*.exe' \) ! -name '*.sh' ! -name '*.bat' | head -1)"
[ -n "$BIN_SRC" ] || fail "Could not find binary inside archive."

if [ "$EXT" = "zip" ]; then
  cp "$BIN_SRC" "${INSTALL_DIR}/dvalincode.exe"
  # Windows doesn't run this script, but keep structure consistent
  printf '@echo off\r\n"%s\\dvalincode.exe" %%*\r\n' "${INSTALL_DIR}" > "${INSTALL_DIR}/bin/dvalincode.bat"
else
  cp "$BIN_SRC" "${INSTALL_DIR}/dvalincode"
  chmod +x "${INSTALL_DIR}/dvalincode"

  # Wrapper at bin/dvalincode exec's the real binary (preserves import.meta.url)
  cat > "${INSTALL_DIR}/bin/dvalincode" << 'WRAPPER'
#!/usr/bin/env bash
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dvalincode" "$@"
WRAPPER
  chmod +x "${INSTALL_DIR}/bin/dvalincode"
fi
ok "Installed to ${C_BOLD}${INSTALL_DIR}${C_RESET}"

# ── macOS: clear Gatekeeper quarantine ────────────────────────────────
# curl downloads aren't quarantined, but be defensive (re-runs, manual copies,
# browser-downloaded archives) so the unsigned binary isn't flagged as
# "damaged" / blocked on Apple Silicon.
case "$PLATFORM" in
  macos-*)
    if command -v xattr >/dev/null 2>&1; then
      xattr -dr com.apple.quarantine "$INSTALL_DIR" 2>/dev/null || true
    fi
    ;;
esac

# ── PATH setup ────────────────────────────────────────────────────────
ADD_TO_PATH=true
case ":$PATH:" in
  *":${INSTALL_DIR}/bin:"*) ADD_TO_PATH=false ;;
esac

if $ADD_TO_PATH; then
  EXPORT_LINE="export PATH=\"${INSTALL_DIR}/bin:\$PATH\""
  RC_FILES=()
  [ -f "$HOME/.zshrc"  ] && RC_FILES+=("$HOME/.zshrc")
  [ -f "$HOME/.bashrc" ] && RC_FILES+=("$HOME/.bashrc")
  [ -f "$HOME/.profile" ] && RC_FILES+=("$HOME/.profile")

  if [ "${#RC_FILES[@]}" -gt 0 ]; then
    for rc in "${RC_FILES[@]}"; do
      if ! grep -q "${INSTALL_DIR}/bin" "$rc" 2>/dev/null; then
        printf "\n# Added by DvalinCode installer\n%s\n" "$EXPORT_LINE" >> "$rc"
        ok "PATH updated in ${C_DIM}${rc}${C_RESET}"
      fi
    done
  else
    warn "Could not find a shell rc file. Add this to your shell config manually:"
    printf "  %s\n" "$EXPORT_LINE"
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────
echo
ok "${C_BOLD}DvalinCode ${VERSION} installed!${C_RESET}"
echo
echo "  ${C_DIM}# Reload your shell:${C_RESET}"
echo "  source ~/.zshrc    ${C_DIM}# or ~/.bashrc${C_RESET}"
echo
echo "  ${C_DIM}# Then start the GUI (opens in your browser):${C_RESET}"
echo "  ${C_BOLD}dvalincode${C_RESET}"
echo
