#!/usr/bin/env bash
# Build the DvalinCode GUI release:
#   1. Build the React frontend (web/dist/)
#   2. Compile server binaries for all platforms via Bun
#   3. Package each platform as an archive: binary + web/dist/
#   4. Generate SHA256SUMS.txt
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
ICON_SOURCE="web/public/logo.svg"
MACOS_ICON="${RELEASE_DIR}/tmp/AppIcon.icns"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DvalinCode v${VERSION} — GUI Release Build"
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

prepare_macos_icon() {
  if ! command -v sips >/dev/null 2>&1 || ! command -v iconutil >/dev/null 2>&1; then
    echo "  ! sips/iconutil not found; macOS .app icon will be skipped"
    return 0
  fi

  local base_png="${RELEASE_DIR}/tmp/AppIcon-1024.png"
  local iconset="${RELEASE_DIR}/tmp/AppIcon.iconset"
  mkdir -p "$iconset"

  sips -s format png "$ICON_SOURCE" --out "$base_png" >/dev/null
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$base_png" --out "${iconset}/icon_${size}x${size}.png" >/dev/null
    sips -z "$((size * 2))" "$((size * 2))" "$base_png" --out "${iconset}/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$MACOS_ICON"
}

create_macos_app() {
  local pkg_dir="$1"
  local bin_file="$2"
  local arch_suffix="$3"

  if [ ! -f "$MACOS_ICON" ]; then
    return 0
  fi

  local app_dir="${pkg_dir}/DvalinCode.app"
  mkdir -p "${app_dir}/Contents/MacOS/web" "${app_dir}/Contents/Resources"
  cp "${pkg_dir}/${bin_file}" "${app_dir}/Contents/MacOS/dvalincode"
  cp -r web/dist "${app_dir}/Contents/MacOS/web/dist"
  cp "$MACOS_ICON" "${app_dir}/Contents/Resources/AppIcon.icns"
  chmod +x "${app_dir}/Contents/MacOS/dvalincode"

  cat > "${app_dir}/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>DvalinCode</string>
  <key>CFBundleExecutable</key>
  <string>dvalincode</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>dev.dvalincode.${arch_suffix}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>DvalinCode</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST
}

if [ "$FILTER" = "all" ] || [ "$FILTER" = "darwin" ]; then
  echo "▶ Preparing macOS app icon from ${ICON_SOURCE}…"
  prepare_macos_icon
  [ -f "$MACOS_ICON" ] && echo "  ✓ AppIcon.icns ready"
  echo
fi

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

  # ── Package ──────────────────────────────────────────────────────
  pkg_dir="${RELEASE_DIR}/pkg/${bin_name}"
  mkdir -p "${pkg_dir}/web"
  cp "${RELEASE_DIR}/tmp/${bin_file}" "${pkg_dir}/${bin_file}"
  cp -r web/dist "${pkg_dir}/web/dist"

  if $is_windows; then
    # Windows ZIP
    printf '@echo off\r\necho Starting DvalinCode...\r\n"%%~dp0dvalincode-windows-x64.exe"\r\n' \
      > "${pkg_dir}/start.bat"
    archive="${RELEASE_DIR}/dvalincode-v${VERSION}-windows-x64.zip"
    (cd "${RELEASE_DIR}/pkg" && zip -r "../dvalincode-v${VERSION}-windows-x64.zip" "${bin_name}" -x "*.DS_Store")
    echo "  ✓ dvalincode-v${VERSION}-windows-x64.zip  ($(du -sh "$archive" | cut -f1))"
  else
    # The CLI ships as a terminal binary only — no double-click .app (the
    # desktop GUI app is a separate artifact built by scripts/build-gui.sh).

    # macOS / Linux tar.gz
    cat > "${pkg_dir}/start.sh" << 'SH'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$(ls "$DIR" | grep -Ev '(start\.sh|web)' | head -1)"
exec "$DIR/$BIN"
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

echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Artifacts in ${RELEASE_DIR}/:"
ls -1 "$RELEASE_DIR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo
echo "Release verification checklist:"
echo "  1. Run: (cd ${RELEASE_DIR} && shasum -a 256 -c SHA256SUMS.txt)"
echo "  2. macOS archives: confirm DvalinCode.app/Contents/Resources/AppIcon.icns exists."
echo "  3. Windows archive: unzip it and run start.bat from the extracted folder."
echo "     Expected: DvalinCode opens http://localhost:3000."
echo "     Regression signal: ENOENT mentioning B:\\~BUN\\root\\web\\dist\\index.html."
echo "  4. Keep web/dist adjacent to each binary in packaged archives; compiled Bun paths are virtual."
