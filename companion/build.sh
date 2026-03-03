#!/bin/bash
# Build the Zahhak companion app (Windows only)

set -e

APP_NAME="zahhak-companion"
VERSION="2.0.0"
OUT_DIR="dist"

mkdir -p "$OUT_DIR"

echo "Building $APP_NAME v$VERSION..."

# Windows (amd64) — primary target
echo "  -> windows/amd64"
GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o "$OUT_DIR/${APP_NAME}-windows-amd64.exe" .

echo ""
echo "Build complete! Binary in $OUT_DIR/"
ls -lh "$OUT_DIR/"
