# Zahhak Crawler

A Chrome extension that captures web pages as training data and lets you control your browser with voice commands.

## What It Does

**Dataset Builder** — Enter a prompt describing the dataset you want. Zahhak searches the web (via Brave Search API or browser-based fallback), crawls the results, scores each page's quality with an LLM, classifies them as gold or silver tier, and exports clean JSONL + a quality report as a ZIP file.

**Voice Commander** — Speak commands and the browser executes them in real-time. Say "go to GitHub" or "click the search bar and type machine learning" and watch it happen. Powered by PinchTab for browser automation, with three provider tiers to choose from.

**Browsing Capture** — Toggle on capture mode and browse normally. Every page is automatically converted to clean Markdown with YAML frontmatter. Export as JSONL training data, push to HuggingFace, or save as a ZIP.

## Voice Commander Tiers

| Tier | Cost | Latency | What You Need |
|------|------|---------|---------------|
| **Local** | Free | ~2-3s | Companion app with `--tier local` (downloads Whisper.cpp + Llamafile) |
| **Groq** | Free tier available | ~1s | Groq API key from [console.groq.com](https://console.groq.com) |
| **OpenAI Realtime** | ~$0.06-0.24/min | Real-time | OpenAI API key |

All tiers require the companion app running (it auto-downloads PinchTab on first launch).

## Getting Started

### 1. Install the Extension

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `extension/` folder

### 2. Set Up Voice Commander (optional)

1. Open the extension popup and expand **Voice Commander**
2. Click the download button — it detects your OS automatically
3. Run the downloaded companion binary — it auto-installs PinchTab
4. Come back to the popup and click the mic button

For the free local tier (no API keys, fully offline), run the companion with:

```bash
./voice-commander --tier local
```

This downloads Whisper.cpp (~39MB), the Whisper model, and Llamafile (~2.2GB) on first run.

### 3. Configure API Keys (optional)

Open the **API Configuration** section in the popup to set up:

- **LLM Provider** (OpenAI, Anthropic, Ollama, or custom endpoint) — used for AI-enhanced capture and Dataset Builder quality scoring
- **Groq API Key** — for the Groq voice tier
- **Brave Search API Key** — for Dataset Builder (free key at [brave.com/search/api](https://brave.com/search/api/))
- **HuggingFace Token** — for pushing datasets directly to HF Hub

## Export Formats

**ZIP Export** contains per-domain folders with Markdown notes and JSONL training data.

**JSONL** uses the conversation format compatible with OpenAI and Anthropic fine-tuning:

```json
{
  "messages": [
    {"role": "system", "content": "You are a knowledgeable assistant..."},
    {"role": "user", "content": "What does this page cover?"},
    {"role": "assistant", "content": "[Extracted markdown content]"}
  ]
}
```

**Dataset Builder** exports include a gold set (high-quality), silver set (acceptable), manifest with metadata, and a quality report.

**HuggingFace** — push directly to a new or existing HF dataset repo from the extension.

## Project Structure

```
Zahhak-crawler/
├── extension/                          # Chrome extension (Manifest V3)
│   ├── manifest.json
│   ├── popup/                          # Extension popup UI
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   ├── background/
│   │   └── service-worker.js           # Orchestrator: captures, AI, voice commands
│   ├── content/
│   │   └── content.js                  # Page extraction + Markdown conversion
│   └── lib/
│       ├── turndown.min.js             # HTML → Markdown
│       ├── readability.min.js          # Article content extraction
│       ├── defuddle.min.js             # Content cleaning
│       ├── jszip.min.js               # ZIP export
│       └── audio-worklet-processor.js  # Voice activity detection
├── companion/                          # Voice Commander companion app (Go)
│   ├── main.go                         # Entry point, auto-install, health server
│   ├── services.go                     # PinchTab/Whisper/Llamafile process manager
│   ├── installer.go                    # Binary downloader with progress
│   ├── go.mod
│   └── build.sh                        # Cross-compile script
├── .github/workflows/
│   └── companion-release.yml           # Auto-build binaries on tag push
├── setup-repo.sh
└── .gitignore
```

## How the Companion App Works

The companion is a single Go binary that manages all the local services Voice Commander needs:

1. **On first run**: auto-downloads PinchTab (~12MB) for browser automation
2. **With `--tier local`**: also downloads Whisper.cpp server, Whisper model (~39MB), and Llamafile (~2.2GB)
3. **Starts services**: PinchTab on port 9867, health API on port 9868
4. **Health endpoint**: The extension polls `localhost:9868/health` to check service status
5. **Bridge token**: Auto-generated auth token shared between companion and extension

## Settings

Accessible from the popup:

- **URL Exclusions** — skip specific pages (login, banking, etc.)
- **Minimum Word Count** — skip thin pages
- **SPA Detection** — detect navigation in single-page apps
- **AI Enhancement** — use LLM to improve Markdown extraction quality
- **Data Sanitization** — regex or LLM-based PII redaction before export

## Building the Companion from Source

Requires Go 1.21+:

```bash
cd companion
bash build.sh
```

Outputs binaries for Windows, macOS (Intel + ARM), and Linux in `companion/dist/`.

## Contributing

This project is currently private but will be open-sourced soon. When it goes public:

- Fork the repo and submit PRs
- Open issues for bugs or feature requests
- All contributions will be reviewed before merging

## License

MIT
