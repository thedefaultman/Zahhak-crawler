# Zahhak Crawler

A Chrome extension that captures web pages as training data, lets you control your browser with voice commands, and fine-tunes a local AI model that adapts to your workflow.

## What It Does

**Two Modes** — The extension has two tabs: **Local** (fully offline, free, powered by a companion app) and **Third Party** (OpenAI API). All AI features work through whichever mode you choose.

**Dataset Builder** — Enter a prompt describing the dataset you want. Zahhak searches the web (via Brave Search API or browser-based fallback), crawls the results, scores each page's quality with an LLM, classifies them as gold or silver tier, and exports clean JSONL + a quality report as a ZIP file.

**Voice Commander** — Speak commands and the browser executes them in real-time. Say "go to GitHub" or "click the search bar and type machine learning" and watch it happen. Powered by PinchTab for browser automation.

**Browsing Capture** — Toggle on capture mode and browse normally. Every page is automatically converted to clean Markdown with YAML frontmatter. Export as JSONL training data, push to HuggingFace, or save as a ZIP.

**Fine-Tuning** — In Local mode, push your captured training data to HuggingFace and fine-tune your model with one click via AutoTrain. The model adapts to your work style over time.

## Local vs Third Party

| Feature | Local (Free) | Third Party (OpenAI) |
|---------|-------------|---------------------|
| AI-Enhanced Extraction | Ollama (Qwen 3.5) | OpenAI API |
| Voice Commander | Vosk STT + Ollama + PinchTab | OpenAI Realtime WebRTC + PinchTab |
| Dataset Builder Scoring | Ollama (Qwen 3.5) | OpenAI API |
| Fine-Tuning | HuggingFace AutoTrain (one-click) | Not available |
| Cost | Free (runs on your hardware) | ~$0.06-0.24/min for voice, per-token for AI |
| Requirements | Companion app (Windows) | OpenAI API key |

Both modes use the companion app for browser automation via PinchTab.

## Getting Started

### 1. Install the Extension

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `extension/` folder

### 2. Local Mode Setup

1. Open the extension popup — it defaults to the **Local** tab
2. Click the download button in the Companion Status panel
3. Run the companion binary — it automatically:
   - Detects your hardware (CPU, RAM, GPU/VRAM)
   - Installs Ollama and pulls the best Qwen 3.5 model for your system
   - Downloads the Vosk speech-to-text model (~40MB) and auto-installs the Python package
   - Downloads PinchTab for browser automation
   - Detects Chrome and connects via DevTools Protocol
4. The Companion Status panel shows green indicators when services are ready

### 3. Third Party Mode Setup

1. Switch to the **Third Party** tab in the extension popup
2. Enter your OpenAI API key and select a model
3. Click Save — all AI features now use OpenAI

### 4. Configure Additional Keys (optional)

- **Brave Search API Key** — for Dataset Builder web search ([brave.com/search/api](https://brave.com/search/api/))
- **HuggingFace Token** — for pushing datasets to HF Hub and fine-tuning

## Hardware Requirements (Local Mode)

The companion app detects your hardware and automatically selects the right model:

| Hardware | Model Selected | Download Size |
|----------|---------------|---------------|
| VRAM >= 8GB or RAM >= 32GB | `qwen3.5:8b` | ~5 GB |
| VRAM >= 4GB or RAM >= 16GB | `qwen3.5:4b` | ~2.7 GB |
| VRAM >= 2GB or RAM >= 8GB | `qwen3.5:1.5b` | ~1 GB |
| Minimal hardware | `qwen3.5:0.6b` | ~400 MB |

## Fine-Tuning Your Model

1. Capture pages with browsing capture or the Dataset Builder
2. Push your training data to HuggingFace (in the HuggingFace section)
3. Click **Fine-tune Model** in the Local tab
4. The companion sends your dataset to HuggingFace AutoTrain for QLoRA fine-tuning
5. When complete, the fine-tuned model is loaded into Ollama automatically

AutoTrain requires HuggingFace Pro ($9/mo) or pay-per-use compute.

## Export Formats

**ZIP Export** contains per-domain folders with Markdown notes and JSONL training data.

**JSONL** uses the conversation format compatible with fine-tuning:

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
│   │   ├── popup.html                  # Two-tab layout (Local / Third Party)
│   │   ├── popup.css
│   │   └── popup.js                    # Tab switching, companion polling, mode state
│   ├── background/
│   │   └── service-worker.js           # Mode-aware AI routing, voice commands, capture
│   ├── content/
│   │   ├── content.js                  # Page extraction + Markdown conversion
│   │   ├── mic-capture.js              # Push-to-talk WAV capture for Vosk STT
│   │   └── realtime-session.js         # OpenAI Realtime WebRTC session
│   └── lib/
│       ├── turndown.min.js             # HTML → Markdown
│       ├── defuddle.min.js             # Content cleaning
│       ├── jszip.min.js                # ZIP export
│       └── audio-worklet-processor.js  # Voice activity detection
├── companion/                          # Zahhak Companion app (Go, Windows)
│   ├── main.go                         # Entry point, hardware detection, health server
│   ├── services.go                     # PinchTab process manager + Ollama/Vosk status
│   ├── hardware.go                     # Windows hardware detection (RAM, CPU, GPU/VRAM)
│   ├── ollama.go                       # Ollama install, serve, model pull
│   ├── vosk.go                         # Vosk STT model management + /stt endpoint
│   ├── finetune.go                     # HuggingFace AutoTrain API integration
│   ├── chrome.go                       # Chrome CDP detection + restart
│   ├── installer.go                    # PinchTab binary downloader
│   ├── go.mod
│   └── build.sh                        # Build script (Windows target)
├── .github/workflows/
│   └── companion-release.yml           # Auto-build binary on tag push
└── .gitignore
```

## How the Companion App Works

The companion is a single Go binary (Windows) that manages all local AI services:

1. **Hardware detection**: Reads CPU, RAM, and GPU/VRAM via Windows APIs and wmic/nvidia-smi
2. **Model selection**: Picks the best Qwen 3.5 variant for your hardware
3. **Ollama**: Installs if needed, starts the server, pulls the recommended model
4. **Vosk STT**: Downloads a lightweight speech-to-text model (~40MB) and auto-installs the Python `vosk` package
5. **PinchTab**: Browser automation via Chrome DevTools Protocol (port 9867)
6. **Health API**: Extension polls `localhost:9868/health` for service status, hardware info, and model name
7. **STT endpoint**: `POST localhost:9868/stt` accepts WAV audio, returns transcribed text
8. **Fine-tune endpoints**: `/finetune/start` and `/finetune/status` for AutoTrain integration
9. **Bridge token**: Auto-generated auth token shared between companion and extension

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

Outputs `zahhak-companion-windows-amd64.exe` in `companion/dist/`.

## Contributing

This project is currently private but will be open-sourced soon. When it goes public:

- Fork the repo and submit PRs
- Open issues for bugs or feature requests
- All contributions will be reviewed before merging

## License

MIT
