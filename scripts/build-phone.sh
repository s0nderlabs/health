#!/bin/sh
# Build (and optionally install) the iPhone relayer.
#   scripts/build-phone.sh            build for the connected device
#   scripts/build-phone.sh sim        build for the iOS simulator
#   scripts/build-phone.sh install    build + install to the connected device
# First run needs Xcode signing set up once: open relayer-ios/HealthRelay.xcodeproj,
# pick your (free) Personal Team under Signing & Capabilities.
set -e
cd "$(dirname "$0")/../relayer-ios"

command -v xcodegen >/dev/null || { echo "xcodegen missing: brew install xcodegen"; exit 1; }
[ -d HealthRelay.xcodeproj ] || xcodegen generate

case "${1:-device}" in
  sim)
    xcodebuild -project HealthRelay.xcodeproj -scheme HealthRelay \
      -destination 'generic/platform=iOS Simulator' -quiet build
    ;;
  install)
    xcodebuild -project HealthRelay.xcodeproj -scheme HealthRelay \
      -destination 'generic/platform=iOS' -allowProvisioningUpdates -quiet build
    # The model column contains spaces, so grab the UDID by shape, not position.
    DEVICE_ID=$(xcrun devicectl list devices --hide-headers 2>/dev/null | grep -oEm1 '[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}')
    [ -n "$DEVICE_ID" ] || { echo "no device connected (cable or same Wi-Fi with pairing)"; exit 1; }
    APP=$(find ~/Library/Developer/Xcode/DerivedData -path '*Build/Products/*-iphoneos/HealthRelay.app' -newer HealthRelay.xcodeproj -print -quit)
    xcrun devicectl device install app --device "$DEVICE_ID" "$APP"
    echo "installed to $DEVICE_ID"
    ;;
  *)
    xcodebuild -project HealthRelay.xcodeproj -scheme HealthRelay \
      -destination 'generic/platform=iOS' -allowProvisioningUpdates -quiet build
    ;;
esac
echo "build ok"
