#!/bin/sh
# Build the macOS BLE relayer. Output: bin/health-relay
set -e
cd "$(dirname "$0")/.."
mkdir -p bin
swiftc -O relayer/health-relay.swift -o bin/health-relay
echo "built bin/health-relay"
