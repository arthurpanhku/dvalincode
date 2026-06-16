#!/usr/bin/env bash
# Build the DvalinCode CLI + Web bundle release:
#   1. Build the React frontend (web/dist/)
#   2. Compile the CLI binary for all platforms via Bun --compile
#   3. Package each platform as an archive: binary + web/dist/ + start script
#   4. Generate SHA256SUMS.txt
#   5. Smoke-test every archive (structure + checksums)
#
# The packaged binary is the full CLI: bare `dvalincode` opens the terminal
# agent (TUI); `dvalincode serve` starts the web server + GUI. The bundled
# start.sh / start.bat launcher runs `serve` for non-terminal users.
#
# The native desktop GUI app is a SEPARATE artifact — see scripts/build-gui.sh.
#
# Usage:
#   scripts/build-release.sh             # all platforms
#   scripts/build-release.sh darwin      # macOS only
#   scripts/build-release.sh linux       # Linux only
#   scripts/build-release.sh windows     # Windows only

set -euo pipefail

# ── Bun ────────────────────────────────────────────────────────────────
if command -v bun >/dev/null 2>&1; then
  BUN="$(command -v bun)"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
else
  echo "error: bun is not installed." >&2
  exit 1
fi

is_windows_host() {
  [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

FILTER="${1:-all}"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"
RELEASE_DIR="release"
ICON_SOURCE="web/public/logo.svg"   # used only for the Windows .exe icon/metadata

# Code-signing identity for macOS binaries:
#   "-"  (default) → ad-hoc signature: clears the "damaged" error, NOT notarized.
#   "Developer ID Application: NAME (TEAMID)" → real signature for notarization;
#     set via DVALINCODE_SIGN_IDENTITY (the release workflow wires this from a
#     secret). Requires the cert to be present in the build host's keychain.
SIGN_IDENTITY="${DVALINCODE_SIGN_IDENTITY:--}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DvalinCode v${VERSION} — CLI + Web Bundle Release"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

# ── 1. Build web frontend ──────────────────────────────────────────────
echo "▶ Building web frontend…"
cd web && npm run build && cd "$ROOT_DIR"
echo "  ✓ web/dist/ ready"
echo

# ── 2. Platform matrix (parallel arrays — bash 3 compatible) ──────────
BUN_TARGETS=()
BIN_NAMES=()

add() {
  local bun_tgt="$1" bin_name="$2"
  case "$FILTER" in
    all) ;;
    darwin)  if [[ "$bun_tgt" != *darwin*  ]]; then return 0; fi ;;
    linux)   if [[ "$bun_tgt" != *linux*   ]]; then return 0; fi ;;
    windows) if [[ "$bun_tgt" != *windows* ]]; then return 0; fi ;;
    *) echo "error: unknown filter '$FILTER'" >&2; exit 1 ;;
  esac
  BUN_TARGETS+=("$bun_tgt"); BIN_NAMES+=("$bin_name")
}

add "bun-darwin-arm64"  "dvalincode-macos-arm64"
add "bun-darwin-x64"    "dvalincode-macos-x64"
add "bun-linux-arm64"   "dvalincode-linux-arm64"
add "bun-linux-x64"     "dvalincode-linux-x64"
add "bun-windows-x64"   "dvalincode-windows-x64"

if [ "${#BUN_TARGETS[@]}" -eq 0 ]; then
  echo "error: no targets for filter '$FILTER'" >&2; exit 1
fi

rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR/tmp" "$RELEASE_DIR/pkg"

# ── 3. Compile + package each target ──────────────────────────────────
# Unified entry: the binary is the full CLI. Bare `dvalincode` opens the
# terminal agent (TUI); `dvalincode serve` starts the web server + GUI.
ENTRY="src/index.ts"

for i in "${!BUN_TARGETS[@]}"; do
  bun_target="${BUN_TARGETS[$i]}"
  bin_name="${BIN_NAMES[$i]}"

  is_windows=false
  if [[ "$bun_target" == *windows* ]]; then is_windows=true; fi

  # Bun adds .exe only for Windows
  if $is_windows; then
    bin_file="${bin_name}.exe"
  else
    bin_file="${bin_name}"
  fi

  echo "▶ Compiling ${bin_file}  (${bun_target})"
  build_args=(
    "$ENTRY"
    --compile \
    --minify \
    --target="$bun_target" \
    --outfile "${RELEASE_DIR}/tmp/${bin_file}"
  )

  if $is_windows; then
    if is_windows_host; then
      build_args+=(
        --windows-icon="$ICON_SOURCE"
        --windows-title="DvalinCode"
        --windows-publisher="DvalinCode"
        --windows-version="${VERSION}.0"
        --windows-description="Local-first coding agent"
        --windows-copyright="MIT"
      )
    else
      echo "  ! Windows exe icon/metadata are skipped in cross-builds."
      echo "    Bun only accepts --windows-icon/metadata when this script runs on Windows."
      echo "    The Windows archive is still valid; verify it by unzipping and running start.bat."
    fi
  fi

  "$BUN" build "${build_args[@]}"

  # Ad-hoc sign macOS binaries so Gatekeeper doesn't report them as "damaged"
  # on Apple Silicon. This is NOT notarization — it only clears the hard
  # "damaged"/won't-run failure; a browser-downloaded copy still needs the
  # quarantine flag cleared (the installer does this automatically). `codesign`
  # exists only on a macOS build host, so this no-ops elsewhere.
  if [[ "$bun_target" == *darwin* ]] && command -v codesign >/dev/null 2>&1; then
    if [ "$SIGN_IDENTITY" = "-" ]; then
      cs_args=(--force --sign -); cs_label="ad-hoc signed"
    else
      # Hardened runtime + timestamp are required for notarization to pass.
      cs_args=(--force --options runtime --timestamp --sign "$SIGN_IDENTITY")
      cs_label="Developer ID signed"
    fi
    if codesign "${cs_args[@]}" "${RELEASE_DIR}/tmp/${bin_file}" 2>/dev/null; then
      echo "  ✓ ${cs_label} ${bin_file}"
    else
      echo "  ! codesign failed for ${bin_file} (shipping unsigned)"
    fi
  fi

  # ── Package ──────────────────────────────────────────────────────
  pkg_dir="${RELEASE_DIR}/pkg/${bin_name}"
  mkdir -p "${pkg_dir}/web"
  cp "${RELEASE_DIR}/tmp/${bin_file}" "${pkg_dir}/${bin_file}"
  cp -r web/dist "${pkg_dir}/web/dist"

  if $is_windows; then
    # Windows ZIP — the launcher starts the web GUI (`serve`); the bare binary
    # is still the CLI/terminal agent for command-line users.
    printf '@echo off\r\necho Starting DvalinCode web GUI...\r\n"%%~dp0dvalincode-windows-x64.exe" serve\r\n' \
      > "${pkg_dir}/start.bat"
    archive="${RELEASE_DIR}/dvalincode-v${VERSION}-windows-x64.zip"
    (cd "${RELEASE_DIR}/pkg" && zip -r "../dvalincode-v${VERSION}-windows-x64.zip" "${bin_name}" -x "*.DS_Store")
    echo "  ✓ dvalincode-v${VERSION}-windows-x64.zip  ($(du -sh "$archive" | cut -f1))"
  else
    # The CLI ships as a terminal binary only — no double-click .app (the
    # desktop GUI app is a separate artifact built by scripts/build-gui.sh).

    # macOS / Linux tar.gz — the launcher starts the web GUI (`serve`); the bare
    # binary is still the CLI/terminal agent for command-line users.
    cat > "${pkg_dir}/start.sh" << 'SH'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$(ls "$DIR" | grep -Ev '(start\.sh|web)' | head -1)"
exec "$DIR/$BIN" serve
SH
    chmod +x "${pkg_dir}/start.sh"
    suffix="${bin_name#dvalincode-}"
    archive_name="dvalincode-v${VERSION}-${suffix}.tar.gz"
    (cd "${RELEASE_DIR}/pkg" && tar czf "../${archive_name}" "${bin_name}")
    echo "  ✓ ${archive_name}  ($(du -sh "${RELEASE_DIR}/${archive_name}" | cut -f1))"
  fi
  echo
done

rm -rf "${RELEASE_DIR}/tmp" "${RELEASE_DIR}/pkg"

# ── 4. Checksums ──────────────────────────────────────────────────────
echo "▶ Generating SHA256SUMS.txt"
(
  cd "$RELEASE_DIR"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 dvalincode-v* > SHA256SUMS.txt
  else
    sha256sum dvalincode-v* > SHA256SUMS.txt
  fi
)

# ── 5. Smoke test ─────────────────────────────────────────────────────
# Extract every archive and assert the layout the installer relies on:
# a top-level dvalincode-<platform>/ dir containing the binary, web/dist/
# index.html, and the start launcher. Then verify checksums.
smoke_fail() { echo "  ✗ smoke: $1" >&2; exit 1; }

echo
echo "▶ Smoke-testing archives…"
SMOKE_DIR="${RELEASE_DIR}/smoke"
rm -rf "$SMOKE_DIR"; mkdir -p "$SMOKE_DIR"

for archive in "${RELEASE_DIR}"/dvalincode-v*; do
  name="$(basename "$archive")"
  dest="${SMOKE_DIR}/$(echo "$name" | sed 's/[^a-zA-Z0-9]/_/g')"
  mkdir -p "$dest"

  case "$name" in
    *.zip)
      command -v unzip >/dev/null 2>&1 || smoke_fail "unzip not available to check ${name}"
      unzip -q -o "$archive" -d "$dest" ;;
    *.tar.gz)
      tar xzf "$archive" -C "$dest" ;;
    *) continue ;;
  esac

  root="$(find "$dest" -mindepth 1 -maxdepth 1 -type d -name 'dvalincode-*' | head -1)"
  [ -n "$root" ] || smoke_fail "${name}: missing top-level dvalincode-* directory"

  bin="$(find "$root" -maxdepth 1 -type f \( -name 'dvalincode-*' -o -name 'dvalincode-*.exe' \) ! -name '*.sh' ! -name '*.bat' | head -1)"
  [ -n "$bin" ] || smoke_fail "${name}: binary not found"
  case "$name" in
    *.tar.gz) [ -x "$bin" ] || smoke_fail "${name}: binary not executable" ;;
  esac

  [ -f "${root}/web/dist/index.html" ] || smoke_fail "${name}: web/dist/index.html missing"

  case "$name" in
    *.zip)    [ -f "${root}/start.bat" ] || smoke_fail "${name}: start.bat missing" ;;
    *.tar.gz) [ -f "${root}/start.sh" ]  || smoke_fail "${name}: start.sh missing" ;;
  esac

  echo "  ✓ ${name}: binary + web/dist/index.html + start launcher"
done

echo "▶ Verifying checksums…"
(
  cd "$RELEASE_DIR"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c SHA256SUMS.txt
  else
    sha256sum -c SHA256SUMS.txt
  fi
) || smoke_fail "checksum verification failed"

rm -rf "$SMOKE_DIR"

echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Artifacts in ${RELEASE_DIR}/:"
ls -1 "$RELEASE_DIR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo
echo "All archives passed the structure + checksum smoke test."
echo
echo "Manual verification before publishing:"
echo "  • macOS/Linux: tar xzf the archive, run ./dvalincode-<platform>/start.sh"
echo "    → DvalinCode serves http://localhost:3000 (the web GUI)."
echo "    Bare ./dvalincode-<platform>/<binary> opens the terminal agent (TUI)."
echo "  • Windows: unzip and run start.bat → opens http://localhost:3000."
echo "    Regression signal: ENOENT mentioning B:\\~BUN\\root\\web\\dist\\index.html."
echo "  • web/dist must stay adjacent to each binary; compiled Bun paths are virtual."
echo "  • The native desktop GUI app is built separately by scripts/build-gui.sh."
