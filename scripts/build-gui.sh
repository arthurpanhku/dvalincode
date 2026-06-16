#!/usr/bin/env bash
# Build the DvalinCode DESKTOP GUI app (native window via webview-bun):
#   1. Build the React frontend (web/dist/)
#   2. Compile the GUI binary (src/gui/index.ts) for each platform via Bun
#   3. Package: macOS -> DvalinCode.app (dock app); Linux/Windows -> archive
#   4. Generate SHA256SUMS-gui.txt
#
# The GUI opens a native window (WKWebView / WebView2 / WebKitGTK) over the same
# embedded server as `dvalincode serve`. Separate artifact from the CLI binary.
#
# Usage: scripts/build-gui.sh [all|darwin|linux|windows]
#
# NOTE: native-webview binaries are most reliable when built on their own OS.
# Cross-compiling from macOS embeds the per-platform lib but is unverified for
# Linux/Windows until run on that OS.

set -euo pipefail

if command -v bun >/dev/null 2>&1; then BUN="$(command -v bun)";
elif [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun";
else echo "error: bun is not installed." >&2; exit 1; fi

is_windows_host() { [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

FILTER="${1:-all}"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"
RELEASE_DIR="release-gui"
ICON_SOURCE="web/public/logo.svg"
MACOS_ICON="${RELEASE_DIR}/tmp/AppIcon.icns"
ENTRY="src/gui/index.ts"

# "-" = ad-hoc (default); "Developer ID Application: NAME (TEAMID)" for
# notarization, wired from DVALINCODE_SIGN_IDENTITY by the release workflow.
SIGN_IDENTITY="${DVALINCODE_SIGN_IDENTITY:--}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DvalinCode v${VERSION} — Desktop GUI Build"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

echo "▶ Building web frontend…"
(cd web && npm run build)
echo "  ✓ web/dist/ ready"
echo

BUN_TARGETS=(); BIN_NAMES=()
add() {
  local bun_tgt="$1" bin_name="$2"
  case "$FILTER" in
    all) ;;
    darwin)  [[ "$bun_tgt" == *darwin*  ]] || return 0 ;;
    linux)   [[ "$bun_tgt" == *linux*   ]] || return 0 ;;
    windows) [[ "$bun_tgt" == *windows* ]] || return 0 ;;
    *) echo "error: unknown filter '$FILTER'" >&2; exit 1 ;;
  esac
  BUN_TARGETS+=("$bun_tgt"); BIN_NAMES+=("$bin_name")
}
# Order matters: build the verified/likely-good targets first so a flaky Linux
# cross-compile can't abort the Windows/macOS artifacts.
add "bun-darwin-arm64"  "dvalincode-gui-macos-arm64"
add "bun-darwin-x64"    "dvalincode-gui-macos-x64"
add "bun-windows-x64"   "dvalincode-gui-windows-x64"
add "bun-linux-arm64"   "dvalincode-gui-linux-arm64"
add "bun-linux-x64"     "dvalincode-gui-linux-x64"
[ "${#BUN_TARGETS[@]}" -gt 0 ] || { echo "error: no targets for '$FILTER'" >&2; exit 1; }

rm -rf "$RELEASE_DIR"; mkdir -p "$RELEASE_DIR/tmp" "$RELEASE_DIR/pkg"

prepare_macos_icon() {
  command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1 || return 0
  local base_png="${RELEASE_DIR}/tmp/AppIcon-1024.png" iconset="${RELEASE_DIR}/tmp/AppIcon.iconset"
  mkdir -p "$iconset"
  sips -s format png "$ICON_SOURCE" --out "$base_png" >/dev/null
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$base_png" --out "${iconset}/icon_${size}x${size}.png" >/dev/null
    sips -z "$((size*2))" "$((size*2))" "$base_png" --out "${iconset}/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$MACOS_ICON"
}

# A real dock GUI app: no LSUIElement, and an ATS exception so WKWebView may load
# the embedded http://127.0.0.1 server.
create_gui_macos_app() {
  local pkg_dir="$1" bin_file="$2" arch_suffix="$3"
  [ -f "$MACOS_ICON" ] || return 0
  local app_dir="${pkg_dir}/DvalinCode.app"
  mkdir -p "${app_dir}/Contents/MacOS/web" "${app_dir}/Contents/Resources"
  cp "${pkg_dir}/${bin_file}" "${app_dir}/Contents/MacOS/${bin_file}"
  cp -r web/dist "${app_dir}/Contents/MacOS/web/dist"
  cp "$MACOS_ICON" "${app_dir}/Contents/Resources/AppIcon.icns"
  chmod +x "${app_dir}/Contents/MacOS/${bin_file}"
  cat > "${app_dir}/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>DvalinCode</string>
  <key>CFBundleExecutable</key><string>${bin_file}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>dev.dvalincode.gui.${arch_suffix}</string>
  <key>CFBundleName</key><string>DvalinCode</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSAllowsArbitraryLoads</key><true/>
  </dict>
</dict></plist>
PLIST
}

[[ "$FILTER" == "all" || "$FILTER" == "darwin" ]] && { echo "▶ Preparing macOS icon…"; prepare_macos_icon; echo; }

for i in "${!BUN_TARGETS[@]}"; do
  bun_target="${BUN_TARGETS[$i]}"; bin_name="${BIN_NAMES[$i]}"
  is_windows=false; [[ "$bun_target" == *windows* ]] && is_windows=true
  $is_windows && bin_file="${bin_name}.exe" || bin_file="${bin_name}"

  echo "▶ Compiling ${bin_file}  (${bun_target})"
  build_args=("$ENTRY" --compile --minify --target="$bun_target" --outfile "${RELEASE_DIR}/tmp/${bin_file}")
  if $is_windows && is_windows_host; then
    build_args+=(--windows-icon="$ICON_SOURCE" --windows-title="DvalinCode" --windows-version="${VERSION}.0")
  fi
  if ! "$BUN" build "${build_args[@]}"; then
    echo "  ! build failed for ${bin_file} (cross-compile of native webview) — skipping"
    echo
    continue
  fi

  # Ad-hoc sign macOS binaries so Gatekeeper doesn't flag them as "damaged" on
  # Apple Silicon (not notarization — see scripts/build-release.sh note).
  if [[ "$bun_target" == *darwin* ]] && command -v codesign >/dev/null 2>&1; then
    if [ "$SIGN_IDENTITY" = "-" ]; then
      codesign --force --sign - "${RELEASE_DIR}/tmp/${bin_file}" 2>/dev/null \
        && echo "  ✓ ad-hoc signed ${bin_file}" || echo "  ! codesign failed for ${bin_file}"
    else
      codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "${RELEASE_DIR}/tmp/${bin_file}" 2>/dev/null \
        && echo "  ✓ Developer ID signed ${bin_file}" || echo "  ! codesign failed for ${bin_file}"
    fi
  fi

  pkg_dir="${RELEASE_DIR}/pkg/${bin_name}"; mkdir -p "${pkg_dir}/web"
  cp "${RELEASE_DIR}/tmp/${bin_file}" "${pkg_dir}/${bin_file}"
  cp -r web/dist "${pkg_dir}/web/dist"

  if $is_windows; then
    archive="${RELEASE_DIR}/dvalincode-gui-v${VERSION}-windows-x64.zip"
    (cd "${RELEASE_DIR}/pkg" && zip -rq "../dvalincode-gui-v${VERSION}-windows-x64.zip" "${bin_name}" -x "*.DS_Store")
    echo "  ✓ $(basename "$archive")  ($(du -sh "$archive" | cut -f1))"
  else
    if [[ "$bun_target" == *darwin* ]]; then
      create_gui_macos_app "$pkg_dir" "$bin_file" "${bin_name#dvalincode-gui-macos-}"
      # Deep-sign the bundle so the .app launches without "damaged".
      if [ -d "${pkg_dir}/DvalinCode.app" ] && command -v codesign >/dev/null 2>&1; then
        if [ "$SIGN_IDENTITY" = "-" ]; then
          codesign --force --deep --sign - "${pkg_dir}/DvalinCode.app" 2>/dev/null \
            && echo "  ✓ ad-hoc signed DvalinCode.app" || echo "  ! codesign failed for DvalinCode.app"
        else
          codesign --force --deep --options runtime --timestamp --sign "$SIGN_IDENTITY" "${pkg_dir}/DvalinCode.app" 2>/dev/null \
            && echo "  ✓ Developer ID signed DvalinCode.app" || echo "  ! codesign failed for DvalinCode.app"
        fi
      fi
    fi
    suffix="${bin_name#dvalincode-gui-}"
    archive_name="dvalincode-gui-v${VERSION}-${suffix}.tar.gz"
    (cd "${RELEASE_DIR}/pkg" && tar czf "../${archive_name}" "${bin_name}")
    echo "  ✓ ${archive_name}  ($(du -sh "${RELEASE_DIR}/${archive_name}" | cut -f1))"
  fi
  echo
done

echo "▶ Generating SHA256SUMS-gui.txt"
(cd "$RELEASE_DIR" && { command -v shasum >/dev/null 2>&1 && shasum -a 256 dvalincode-gui-v* > SHA256SUMS-gui.txt || sha256sum dvalincode-gui-v* > SHA256SUMS-gui.txt; })
echo "  ✓ done — artifacts in ${RELEASE_DIR}/"
