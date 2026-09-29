#!/bin/zsh
# Builds ~/Applications/AgentCity.app from this folder. Run: ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
NODE="$(command -v node)"
# Installed outside ~/Desktop so macOS doesn't ask for Desktop-folder access at every launch.
APP="$HOME/Applications/AgentCity.app"
mkdir -p "$HOME/Applications"

[[ -d node_modules/three ]] || npm install --no-audit --no-fund

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O mac/AgentCity.swift -o "$APP/Contents/MacOS/AgentCity" -framework Cocoa -framework WebKit

# Bundle the server, the page and three.js inside the app.
RES="$APP/Contents/Resources/app"
mkdir -p "$RES/node_modules"
cp server.mjs package.json "$RES/"
ditto public "$RES/public"
ditto node_modules/three "$RES/node_modules/three"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>local.agentcity.wallpaper</string>
  <key>CFBundleName</key><string>Agent City</string>
  <key>CFBundleDisplayName</key><string>Agent City</string>
  <key>CFBundleExecutable</key><string>AgentCity</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>AgentCityNode</key><string>$NODE</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "Built $APP"

# Run it from launchd: starts at login, and comes back within seconds if it is killed or
# crashes. Quitting from the menu is a clean exit, so it stays quit until the next login.
LABEL=local.agentcity.wallpaper
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/AgentCity</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
PLIST
# Restart on the new build: stop the launchd copy and any copy started with open, then load.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
pkill -x AgentCity 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$UID" "$AGENT"
echo "Running (starts at login, restarts if killed)"
