#!/bin/bash
# ============================================================
# Zahhak Crawler — One-shot repo setup + first release
# Run this from the browsing-capture-extension/ directory
# Requires: gh CLI (brew install gh / winget install GitHub.cli)
# ============================================================

set -e

REPO_NAME="Zahhak-crawler"
GITHUB_USER="thedefaultman"

echo "=== Zahhak Crawler Setup ==="
echo ""

# 1. Check prerequisites
if ! command -v gh &> /dev/null; then
  echo "ERROR: GitHub CLI (gh) is not installed."
  echo "  macOS:   brew install gh"
  echo "  Windows: winget install GitHub.cli"
  echo "  Linux:   https://github.com/cli/cli/blob/trunk/docs/install_linux.md"
  exit 1
fi

if ! gh auth status &> /dev/null; then
  echo "Not logged into GitHub CLI. Running 'gh auth login'..."
  gh auth login
fi

echo "Step 1: Creating private repo ${GITHUB_USER}/${REPO_NAME}..."
gh repo create "${GITHUB_USER}/${REPO_NAME}" \
  --private \
  --description "Voice-controlled browser automation & training data crawler Chrome extension" \
  --source . \
  --push

echo ""
echo "Step 2: Tagging v0.1.0..."
git tag -a v0.1.0 -m "Initial release — Dataset Builder + Voice Commander"
git push origin v0.1.0

echo ""
echo "Step 3: Creating release with companion app binaries..."

# Check if Go is installed for building companion
if command -v go &> /dev/null; then
  echo "  Building companion app binaries..."
  cd companion
  bash build.sh
  cd ..

  echo "  Creating GitHub release with binaries..."
  gh release create v0.1.0 \
    companion/dist/voice-commander-windows-amd64.exe \
    companion/dist/voice-commander-darwin-amd64 \
    companion/dist/voice-commander-darwin-arm64 \
    companion/dist/voice-commander-linux-amd64 \
    --title "v0.1.0 — Zahhak Crawler" \
    --notes "## Zahhak Crawler v0.1.0

### Features
- **Dataset Builder**: Enter a prompt, auto-search Brave, crawl results, score quality via LLM, export gold/silver JSONL
- **Voice Commander**: Voice-controlled browser automation with 3 tiers (Local/Groq/OpenAI Realtime)
- **Companion App**: Auto-installs PinchTab on first run, no technical setup needed

### Companion App Downloads
| Platform | File |
|----------|------|
| Windows | voice-commander-windows-amd64.exe |
| macOS (Intel) | voice-commander-darwin-amd64 |
| macOS (Apple Silicon) | voice-commander-darwin-arm64 |
| Linux | voice-commander-linux-amd64 |

### First Run
Just download and run the companion binary. It auto-downloads PinchTab (~12MB).
For the **Local** (free/offline) tier, run with: \`--tier local\`"
else
  echo "  Go not found — creating release without binaries."
  echo "  GitHub Actions will build them when the tag is pushed."
  gh release create v0.1.0 \
    --title "v0.1.0 — Zahhak Crawler" \
    --generate-notes
fi

echo ""
echo "=== Done! ==="
echo "Repo:    https://github.com/${GITHUB_USER}/${REPO_NAME}"
echo "Release: https://github.com/${GITHUB_USER}/${REPO_NAME}/releases/tag/v0.1.0"
echo ""
echo "If you don't have Go installed, the GitHub Actions workflow will"
echo "auto-build the companion binaries when the v0.1.0 tag is pushed."
