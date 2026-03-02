# Browsing Capture → Training Data

A Chrome extension that automatically captures web pages as Obsidian-style Markdown notes, with one-click export to JSONL format for AI model fine-tuning.

## Features

- **Auto-capture**: Automatically captures every page you visit when activated
- **Obsidian-style Markdown**: YAML frontmatter, tags, clean heading hierarchy
- **AI Enhancement** (optional): Use OpenAI, Anthropic, Ollama, or custom endpoints to improve extraction quality
- **JSONL Export**: Convert all captures to conversation-format training data
- **SPA Support**: Detects navigation in single-page applications
- **Smart Filtering**: Auto-skips login pages, banking sites, and other sensitive URLs
- **Duplicate Detection**: Won't re-capture the same URL in a session
- **IndexedDB Fallback**: Works without native host (stores in browser storage)

## Architecture

```
Chrome Extension (Manifest V3)
├── Popup UI          → Controls, stats, export button
├── Content Script    → Extracts HTML, converts to Markdown (Turndown.js + Readability.js)
├── Service Worker    → Orchestrates captures, AI calls, deduplication
└── Native Host       → Writes .md files to local filesystem
```

## Installation

### Step 1: Load the Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder from this project
5. Note your **Extension ID** (shown under the extension name)

### Step 2: Install the Native Messaging Host

The native host allows the extension to write `.md` files directly to your filesystem.

```bash
cd native-host
npm install
node install.js --extension-id=YOUR_EXTENSION_ID_HERE
```

Replace `YOUR_EXTENSION_ID_HERE` with the ID from Step 1.

**Supported browsers:** Chrome, Chromium, Microsoft Edge (auto-detected).

### Step 3: Configure the Extension

1. Click the extension icon in your toolbar
2. Enter your AI API token (optional — only needed for AI-enhanced extraction)
3. Select your provider (OpenAI, Anthropic, Ollama, or Custom)
4. Toggle **Capture Mode** ON to start capturing

## Usage

### Capturing Pages

1. Turn on **Capture Mode** via the popup toggle
2. Browse the web normally — every page is automatically captured
3. Watch the stats update in real-time (pages captured, word count, session time)
4. Recent captures appear in the popup's list

### Exporting Training Data

1. Click **Export to JSONL** in the popup
2. Optionally enable **Generate AI questions** for higher-quality Q&A training pairs
3. The JSONL file is saved to `~/BrowsingCapture/exports/`

### JSONL Format

Each entry uses the conversation format (compatible with OpenAI and Anthropic fine-tuning):

```json
{
  "messages": [
    {
      "role": "system",
      "content": "You are a knowledgeable assistant. Use the following reference material..."
    },
    {
      "role": "user",
      "content": "What information does this page provide about [topic]?"
    },
    {
      "role": "assistant",
      "content": "[Structured markdown content from the captured page]"
    }
  ]
}
```

## File Structure

```
browsing-capture-extension/
├── extension/                    # Chrome extension
│   ├── manifest.json
│   ├── popup/                    # Extension popup UI
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   ├── options/                  # Settings page
│   │   └── options.html
│   ├── background/
│   │   └── service-worker.js     # Background orchestrator
│   ├── content/
│   │   └── content.js            # Page extraction + Markdown conversion
│   ├── lib/
│   │   ├── turndown.min.js       # HTML → Markdown library
│   │   └── readability.min.js    # Article content extraction
│   └── icons/
│       ├── icon-16.png
│       ├── icon-48.png
│       └── icon-128.png
├── native-host/                  # Native messaging host (Node.js)
│   ├── package.json
│   ├── host.js                   # Filesystem operations
│   └── install.js                # Browser registration script
└── README.md
```

## Output Structure

```
~/BrowsingCapture/
├── captures/                     # Obsidian-style .md files
│   ├── 2026-02-28_example-com_page-title.md
│   └── ...
├── exports/                      # JSONL training data
│   └── training-data-2026-02-28.jsonl
└── index.json                    # Metadata index
```

## Configuration

Access **Settings** from the popup footer to configure:

- **URL Exclusions**: Custom regex patterns to skip specific pages
- **Minimum Word Count**: Skip pages below a word threshold
- **SPA Detection**: Toggle single-page app navigation detection
- **AI Settings**: Max tokens per page, rate limiting delay

## Uninstalling

```bash
cd native-host
node install.js --uninstall
```

Then remove the extension from `chrome://extensions`.

## Troubleshooting

**"Native host unavailable" warning**: The extension falls back to IndexedDB storage. Make sure you ran the install script with the correct extension ID and restarted Chrome.

**Pages not being captured**: Check that Capture Mode is toggled ON (green badge shows "ON"). Verify the page isn't matching an exclusion pattern.

**AI enhancement failing**: Verify your API token is correct. Check the browser console (F12 → Console) for error messages.

## License

MIT
