#!/bin/sh
# Build the macOS S400 scale listener. Output: bin/scale-listen
set -e
cd "$(dirname "$0")/.."
mkdir -p bin
swiftc -O relayer/scale-listen.swift -o bin/scale-listen
echo "built bin/scale-listen"
