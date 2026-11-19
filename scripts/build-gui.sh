#!/usr/bin/env bash
# Build the DvalinCode DESKTOP GUI app (native window via webview-bun):
#   1. Build the React frontend (web/dist/)
#   2. Compile the GUI binary (src/gui/index.ts) for each platform via Bun
#   3. Package: macOS -> DvalinCode.app (dock app); Linux -> archive;
#      Windows -> archive, plus a per-user .exe installer when built on Windows
#   4. Generate SHA256SUMS-gui.txt
#
# The GUI opens a native window (WKWebView / WebView2 / WebKitGTK) over the same
# embedded server as `dvalincode serve`. Separate artifact from the CLI binary.
#
# Usage: scripts/build-gui.sh [all|darwin|linux|windows ...]
#   scripts/build-gui.sh                # every target
#   scripts/build-gui.sh darwin linux   # the targets the macOS runner builds
#   scripts/build-gui.sh windows        # the Windows runner's target
#
# NOTE: native-webview binaries are most reliable when built on their own OS.
# Cross-compiling from macOS embeds the per-platform lib but is unverified for
# Linux/Windows until run on that OS. The Windows installer, the .exe icon and
# the .exe version metadata are produced only on a Windows host: Bun accepts
# --windows-icon there and nowhere else, and the installer is compiled by Inno
# Setup, which is a Windows program.

set -euo pipefail

if command -v bun >/dev/null 2>&1; then BUN="$(command -v bun)";
elif [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun";
else echo "error: bun is not installed." >&2; exit 1; fi

is_windows_host() { [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

FILTERS=("$@"); [ "${#FILTERS[@]}" -gt 0 ] || FILTERS=("all")
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"
RELEASE_DIR="release-gui"
ICON_VARIANT="${DVALINCODE_ICON_VARIANT:-dark}"
case "$ICON_VARIANT" in
  dark|light) ;;
  *) echo "error: DVALINCODE_ICON_VARIANT must be 'dark' or 'light'." >&2; exit 1 ;;
esac
ICON_SOURCE="${DVALINCODE_ICON_SOURCE:-web/public/app-icon-${ICON_VARIANT}.svg}"
MACOS_ICON="${RELEASE_DIR}/tmp/AppIcon.icns"
# Windows reads its icon out of the PE resource and the shortcut, and Bun's
# --windows-icon takes an .ico — not the SVG the other platforms use. Generated
# from that same SVG by scripts/generate-windows-icon.mjs.
WINDOWS_ICON="${DVALINCODE_WINDOWS_ICON:-installer/windows/dvalincode.ico}"
WINDOWS_ISS="installer/windows/dvalincode.iss"
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
echo "  ✓ app icon: ${ICON_SOURCE}"
echo

BUN_TARGETS=(); BIN_NAMES=()
wants() {
  local bun_tgt="$1" filter
  for filter in "${FILTERS[@]}"; do
    case "$filter" in
      all) return 0 ;;
      darwin|linux|windows) [[ "$bun_tgt" == *"$filter"* ]] && return 0 ;;
      *) echo "error: unknown filter '$filter'" >&2; exit 1 ;;
    esac
  done
  return 1
}

add() {
  local bun_tgt="$1" bin_name="$2"
  wants "$bun_tgt" || return 0
  BUN_TARGETS+=("$bun_tgt"); BIN_NAMES+=("$bin_name")
}
# Order matters: build the verified/likely-good targets first so a flaky Linux
# cross-compile can't abort the Windows/macOS artifacts.
add "bun-darwin-arm64"  "dvalincode-gui-macos-arm64"
add "bun-darwin-x64"    "dvalincode-gui-macos-x64"
add "bun-windows-x64"   "dvalincode-gui-windows-x64"
add "bun-linux-arm64"   "dvalincode-gui-linux-arm64"
add "bun-linux-x64"     "dvalincode-gui-linux-x64"
[ "${#BUN_TARGETS[@]}" -gt 0 ] || { echo "error: no targets for '${FILTERS[*]}'" >&2; exit 1; }

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

# Git Bash on a Windows runner has no `zip`; 7-Zip is there instead.
make_zip() {
  local archive="$1" source_dir="$2" parent
  parent="$(cd "$(dirname "$source_dir")" && pwd)"
  if command -v zip >/dev/null 2>&1; then
    (cd "$parent" && zip -rq "$archive" "$(basename "$source_dir")" -x "*.DS_Store")
  elif command -v 7z >/dev/null 2>&1; then
    (cd "$parent" && 7z a -tzip -bso0 -bsp0 "$archive" "$(basename "$source_dir")" -x'!*.DS_Store' >/dev/null)
  else
    echo "error: no zip or 7z available to package ${archive}." >&2; exit 1
  fi
}

# Inno Setup is a Windows program; Git Bash on a Windows runner reaches it
# through its install path rather than $PATH.
find_iscc() {
  local candidate
  for candidate in "${DVALINCODE_ISCC:-}" "$(command -v iscc 2>/dev/null || true)" \
    "/c/Program Files (x86)/Inno Setup 6/ISCC.exe" "/c/Program Files/Inno Setup 6/ISCC.exe"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

# ISCC takes native Windows paths, and MSYS mangles anything that looks like a
# POSIX one — including the /D switches themselves — so convert here and turn
# the automatic conversion off at the call.
win_path() { command -v cygpath >/dev/null 2>&1 && cygpath -w "$1" || printf '%s' "$1"; }

# A per-user setup .exe: %LocalAppData%\Programs\DvalinCode, a Start menu
# entry, an optional desktop shortcut, an uninstall entry, and no UAC prompt.
build_windows_installer() {
  local pkg_dir="$1" bin_file="$2" iscc
  if ! iscc="$(find_iscc)"; then
    echo "  ! Inno Setup (ISCC.exe) not found — the .exe installer is built on Windows only."
    return 0
  fi

  local out_base="dvalincode-gui-v${VERSION}-windows-x64-setup"
  echo "▶ Compiling Windows installer (Inno Setup)"
  MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 "$iscc" \
    "/DAppVersion=${VERSION}" \
    "/DSourceDir=$(win_path "${ROOT_DIR}/${pkg_dir}")" \
    "/DSourceExe=${bin_file}" \
    "/DIconFile=$(win_path "${ROOT_DIR}/${WINDOWS_ICON}")" \
    "/DLicenseFile=$(win_path "${ROOT_DIR}/LICENSE")" \
    "/DNoticesFile=$(win_path "${ROOT_DIR}/THIRD_PARTY_NOTICES.md")" \
    "/DOutputDir=$(win_path "${ROOT_DIR}/${RELEASE_DIR}")" \
    "/DOutputBaseFilename=${out_base}" \
    "$(win_path "${ROOT_DIR}/${WINDOWS_ISS}")" \
    | sed 's/^/    /'

  local installer="${RELEASE_DIR}/${out_base}.exe"
  [ -f "$installer" ] || { echo "error: Inno Setup reported success but ${installer} is missing." >&2; exit 1; }
  if [ -n "${DVALINCODE_WINDOWS_SIGN_P12_FILE:-}" ] && command -v osslsigncode >/dev/null 2>&1; then
    osslsigncode sign -pkcs12 "$DVALINCODE_WINDOWS_SIGN_P12_FILE" \
      -readpass "${DVALINCODE_WINDOWS_SIGN_PASSWORD_FILE:?missing signing password file}" \
      -ts "${DVALINCODE_WINDOWS_TIMESTAMP_URL:?missing RFC 3161 timestamp URL}" -h sha256 \
      -n DvalinCode -in "$installer" -out "${installer}.signed"
    mv "${installer}.signed" "$installer"
    echo "  ✓ Authenticode signed $(basename "$installer")"
  else
    echo "  ! Installer unsigned — Windows SmartScreen will warn on first run."
  fi
  echo "  ✓ $(basename "$installer")  ($(du -sh "$installer" | cut -f1))"
}

if wants "bun-darwin-arm64"; then echo "▶ Preparing macOS icon…"; prepare_macos_icon; echo; fi

for i in "${!BUN_TARGETS[@]}"; do
  bun_target="${BUN_TARGETS[$i]}"; bin_name="${BIN_NAMES[$i]}"
  is_windows=false; [[ "$bun_target" == *windows* ]] && is_windows=true
  $is_windows && bin_file="${bin_name}.exe" || bin_file="${bin_name}"

  echo "▶ Compiling ${bin_file}  (${bun_target})"
  build_args=("$ENTRY" --compile --minify --target="$bun_target" --outfile "${RELEASE_DIR}/tmp/${bin_file}")
  if $is_windows && is_windows_host; then
    # Bun rejects these flags on any other host, which is why a cross-built
    # .exe has no icon and no version information.
    [ -f "$WINDOWS_ICON" ] || { echo "error: ${WINDOWS_ICON} is missing — run 'node scripts/generate-windows-icon.mjs'." >&2; exit 1; }
    build_args+=(
      --windows-icon="$WINDOWS_ICON"
      --windows-title="DvalinCode"
      --windows-publisher="DvalinCode"
      --windows-version="${VERSION}.0"
      --windows-description="Local-first security engineering agent"
      --windows-copyright="MIT"
    )
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
    cp LICENSE THIRD_PARTY_NOTICES.md "${pkg_dir}/"
    archive="${RELEASE_DIR}/dvalincode-gui-v${VERSION}-windows-x64.zip"
    make_zip "${ROOT_DIR}/${archive}" "${RELEASE_DIR}/pkg/${bin_name}"
    echo "  ✓ $(basename "$archive")  ($(du -sh "$archive" | cut -f1))"
    echo
    build_windows_installer "${RELEASE_DIR}/pkg/${bin_name}" "$bin_file"
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
