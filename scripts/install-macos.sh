#!/bin/zsh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "Buddy's one-click installer is for macOS."
  exit 1
fi

source_dir="${0:A:h:h}"
support_dir="$HOME/Library/Application Support/Buddy"
app_dir="$HOME/Applications/Buddy.app"
agent_dir="$HOME/Library/LaunchAgents"
server_label="app.buddy.local.server"
check_only=false
if [[ "${1:-}" == "--check" ]]; then
  check_only=true
elif (( $# )); then
  print -u2 "Usage: zsh scripts/install-macos.sh [--check]"
  exit 2
fi

missing=false
for tool in node npm codex claude swiftc; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    missing=true
    case "$tool" in
      node|npm) print -u2 "Missing $tool. Install Node.js 20 or newer: https://nodejs.org/en/download" ;;
      codex) print -u2 "Missing Codex CLI. Install with: npm install -g @openai/codex" ;;
      claude) print -u2 "Missing Claude Code. See: https://code.claude.com/docs/en/setup" ;;
      swiftc) print -u2 "Missing Apple Command Line Tools. Run: xcode-select --install" ;;
    esac
  fi
done
if [[ "$missing" == true ]]; then
  print -u2 "Install the missing tools, sign in to Codex and Claude Code, then run the Buddy installer again."
  exit 1
fi

node_bin="$(command -v node)"
npm_bin="$(command -v npm)"
codex_bin="$(command -v codex)"
claude_bin="$(command -v claude)"

node_major="$($node_bin -p 'process.versions.node.split(".")[0]')"
if (( node_major < 20 )); then
  print -u2 "Buddy needs Node.js 20 or newer. Found: $($node_bin --version)"
  exit 1
fi

if [[ "$check_only" == true ]]; then
  print "Buddy prerequisites are ready. Codex and Claude Code should each be signed in before first use."
  exit 0
fi

if [[ -d "$app_dir" ]]; then
  existing_id=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app_dir/Contents/Info.plist" 2>/dev/null || true)
  if [[ -n "$existing_id" && "$existing_id" != "app.buddy.local" ]]; then
    print -u2 "Another Buddy installation is already at $app_dir ($existing_id). Move or uninstall it before installing this edition."
    exit 1
  fi
fi

uid="$(id -u)"
if /usr/sbin/lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl print "gui/$uid/$server_label" >/dev/null 2>&1; then
  print -u2 "Port 4317 is already in use by another app. Close it before installing Buddy."
  exit 1
fi

install_instance="$(uuidgen)"

mkdir -p "$support_dir/source" "$agent_dir" "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources"
rsync -a --delete --exclude=.git --exclude=node_modules --exclude=data --exclude=.DS_Store "$source_dir/" "$support_dir/source/"
cd "$support_dir/source"
"$npm_bin" ci

cat > "$app_dir/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Buddy</string>
  <key>CFBundleExecutable</key><string>Buddy</string>
  <key>CFBundleIconFile</key><string>Buddy.icns</string>
  <key>CFBundleIdentifier</key><string>app.buddy.local</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Buddy</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

swiftc -O -framework AppKit "$source_dir/mac/Buddy.swift" -o "$app_dir/Contents/MacOS/Buddy"
iconset="$support_dir/Buddy.iconset"
mkdir -p "$iconset"
sips -s format png -z 1024 1024 "$source_dir/assets/buddy-icon.png" --out "$iconset/icon_512x512@2x.png" >/dev/null
for spec in '16x16 16' '16x16@2x 32' '32x32 32' '32x32@2x 64' '128x128 128' '128x128@2x 256' '256x256 256' '256x256@2x 512' '512x512 512'; do
  parts=(${=spec})
  sips -s format png -z "$parts[2]" "$parts[2]" "$iconset/icon_512x512@2x.png" --out "$iconset/icon_$parts[1].png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app_dir/Contents/Resources/Buddy.icns"

path_parts=("${node_bin:h}" "${codex_bin:h}" "${claude_bin:h}" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin)
typeset -U path_parts
service_path="${(j/:/)path_parts}"
runner="$support_dir/run-server.sh"
cat > "$runner" <<RUNNER
#!/bin/zsh
export PATH='$service_path'
export BUDDY_INSTALL_INSTANCE='$install_instance'
cd '$support_dir/source'
exec '$node_bin' server/index.js
RUNNER
chmod 755 "$runner"

cat > "$agent_dir/$server_label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$server_label</string>
  <key>ProgramArguments</key><array><string>$runner</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$support_dir/server.log</string>
  <key>StandardErrorPath</key><string>$support_dir/server.err.log</string>
</dict></plist>
PLIST

launchctl bootout "gui/$uid/$server_label" 2>/dev/null || true
bootstrapped=false
for attempt in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$uid" "$agent_dir/$server_label.plist" 2>"$support_dir/bootstrap.err.log"; then
    bootstrapped=true
    break
  fi
  sleep 1
done
if [[ "$bootstrapped" != true ]]; then
  cat "$support_dir/bootstrap.err.log" >&2
  exit 1
fi
launchctl kickstart "gui/$uid/$server_label"
ready=false
for attempt in {1..30}; do
  status_json=$(/usr/bin/curl -fsS --max-time 1 http://127.0.0.1:4317/api/status 2>/dev/null || true)
  if [[ "$status_json" == *"\"installInstance\":\"$install_instance\""* ]]; then
    ready=true
    break
  fi
  sleep 0.5
done
if [[ "$ready" != true ]]; then
  print -u2 "Buddy server did not become ready on port 4317. See $support_dir/server.err.log"
  exit 1
fi
launchctl bootout "gui/$uid/app.buddy.local.app" 2>/dev/null || true
rm -f "$agent_dir/app.buddy.local.app.plist"
/usr/bin/killall Buddy 2>/dev/null || true
/usr/bin/open -a "$app_dir"
if command -v python3 >/dev/null 2>&1; then
  python3 "$source_dir/scripts/pin-dock.py" "$app_dir" "$support_dir" || print -u2 "Buddy is installed, but could not be pinned to the Dock. Open it from ~/Applications instead."
else
  print -u2 "Buddy is installed. To add it to the Dock, open it from ~/Applications and choose Keep in Dock."
fi
print "Buddy installed at $app_dir"
print "Local URL: http://127.0.0.1:4317/"
