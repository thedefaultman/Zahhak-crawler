#!/bin/bash
# Cross-compile the Voice Commander companion app for all platforms

set -e

APP_NAME="voice-commander"
VERSION="0.1.0"
OUT_DIR="dist"

mkdir -p "$OUT_DIR"

echo "Building $APP_NAME v$VERSION..."

# Windows (amd64)
echo "  -> windows/amd64"
GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o "$OUT_DIR/${APP_NAME}-windows-amd64.exe" .

# macOS (Intel)
echo "  -> darwin/amd64"
GOOS=darwin GOARCH=amd64 go build -ldflags="-s -w" -o "$OUT_DIR/${APP_NAME}-darwin-amd64" .

# macOS (Apple Silicon)
echo "  -> darwin/arm64"
GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -o "$OUT_DIR/${APP_NAME}-darwin-arm64" .

# Linux (amd64)
echo "  -> linux/amd64"
GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o "$OUT_DIR/${APP_NAME}-linux-amd64" .

echo ""
echo "Build complete! Binaries in $OUT_DIR/"
ls -lh "$OUT_DIR/"
