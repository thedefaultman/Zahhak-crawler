#!/usr/bin/env node

// ===== Browsing Capture — Native Messaging Host =====
// Receives messages from the Chrome extension via stdin/stdout.
// Writes .md files to disk and handles JSONL export.

const fs = require('fs');
const path = require('path');
const os = require('os');

// ===== Configuration =====
const CONFIG_PATH = path.join(os.homedir(), '.browsing-capture', 'config.json');
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), 'BrowsingCapture');

let config = loadConfig();

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (e) { /* use defaults */ }

  const defaultConfig = {
    outputDir: DEFAULT_OUTPUT_DIR,
    capturesSubdir: 'captures',
    exportsSubdir: 'exports',
  };

  // Ensure config dir exists
  const configDir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
  return defaultConfig;
}

function ensureDirectories() {
  const dirs = [
    config.outputDir,
    path.join(config.outputDir, config.capturesSubdir),
    path.join(config.outputDir, config.exportsSubdir),
  ];
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

// ===== Native Messaging Protocol =====
// Chrome sends/receives messages as: [4-byte length][JSON payload]

function readMessage() {
  return new Promise((resolve, reject) => {
    let headerBuf = Buffer.alloc(0);

    function readHeader() {
      const chunk = process.stdin.read(4 - headerBuf.length);
      if (!chunk) {
        process.stdin.once('readable', readHeader);
        return;
      }

      headerBuf = Buffer.concat([headerBuf, chunk]);

      if (headerBuf.length < 4) {
        process.stdin.once('readable', readHeader);
        return;
      }

      const messageLength = headerBuf.readUInt32LE(0);

      if (messageLength === 0) {
        resolve(null);
        return;
      }

      let bodyBuf = Buffer.alloc(0);

      function readBody() {
        const remaining = messageLength - bodyBuf.length;
        const chunk = process.stdin.read(remaining);
        if (!chunk) {
          process.stdin.once('readable', readBody);
          return;
        }

        bodyBuf = Buffer.concat([bodyBuf, chunk]);

        if (bodyBuf.length < messageLength) {
          process.stdin.once('readable', readBody);
          return;
        }

        try {
          const message = JSON.parse(bodyBuf.toString('utf-8'));
          resolve(message);
        } catch (e) {
          reject(new Error('Failed to parse message: ' + e.message));
        }
      }

      readBody();
    }

    readHeader();
  });
}

function sendMessage(message) {
  const json = JSON.stringify(message);
  const buf = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(header);
  process.stdout.write(buf);
}

// ===== Message Handlers =====
async function handleMessage(message) {
  ensureDirectories();

  switch (message.type) {
    case 'WRITE_MD':
      return handleWriteMd(message);

    case 'EXPORT_JSONL':
      return handleExportJsonl(message);

    case 'GET_STATS':
      return handleGetStats();

    case 'GET_CONFIG':
      return { success: true, config };

    case 'SET_CONFIG':
      return handleSetConfig(message);

    default:
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}

function handleWriteMd(message) {
  try {
    const captureDir = path.join(config.outputDir, config.capturesSubdir);
    const filename = sanitizeFilename(message.filename);
    const filepath = path.join(captureDir, filename);

    fs.writeFileSync(filepath, message.content, 'utf-8');

    // Update index
    updateIndex(filename, message.metadata);

    return {
      success: true,
      filepath: filepath,
      filename: filename,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function handleExportJsonl(message) {
  try {
    const captureDir = path.join(config.outputDir, config.capturesSubdir);
    const exportDir = path.join(config.outputDir, config.exportsSubdir);

    // Read all .md files
    const mdFiles = fs.readdirSync(captureDir)
      .filter(f => f.endsWith('.md'))
      .sort();

    if (mdFiles.length === 0) {
      return { success: false, error: 'No captures found to export' };
    }

    const jsonlLines = [];

    for (const file of mdFiles) {
      const filepath = path.join(captureDir, file);
      const content = fs.readFileSync(filepath, 'utf-8');

      // Parse frontmatter and content
      const parsed = parseFrontmatter(content);
      const fm = parsed.frontmatter;
      const body = parsed.content;

      // Build conversation-format training entry
      const entry = {
        messages: [
          {
            role: 'system',
            content: [
              'You are a knowledgeable assistant. Use the following reference material to answer questions accurately.',
              '',
              `Source: ${fm.source || ''}`,
              `Title: ${fm.title || ''}`,
              `Domain: ${fm.domain || ''}`,
              fm.content_type ? `Content Type: ${fm.content_type}` : '',
            ].filter(Boolean).join('\n'),
          },
          {
            role: 'user',
            content: generateQuestion(fm),
          },
          {
            role: 'assistant',
            content: body.trim(),
          },
        ],
      };

      jsonlLines.push(JSON.stringify(entry));
    }

    // Write JSONL file
    const timestamp = new Date().toISOString().split('T')[0];
    const exportFilename = `training-data-${timestamp}.jsonl`;
    const exportPath = path.join(exportDir, exportFilename);

    fs.writeFileSync(exportPath, jsonlLines.join('\n') + '\n', 'utf-8');

    return {
      success: true,
      count: jsonlLines.length,
      filepath: exportPath,
      filename: exportFilename,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function handleGetStats() {
  try {
    const captureDir = path.join(config.outputDir, config.capturesSubdir);
    const exportDir = path.join(config.outputDir, config.exportsSubdir);

    const mdFiles = fs.existsSync(captureDir)
      ? fs.readdirSync(captureDir).filter(f => f.endsWith('.md'))
      : [];

    const exports = fs.existsSync(exportDir)
      ? fs.readdirSync(exportDir).filter(f => f.endsWith('.jsonl'))
      : [];

    let totalWords = 0;
    for (const file of mdFiles) {
      const content = fs.readFileSync(path.join(captureDir, file), 'utf-8');
      totalWords += content.split(/\s+/).length;
    }

    return {
      success: true,
      stats: {
        totalCaptures: mdFiles.length,
        totalExports: exports.length,
        totalWords: totalWords,
        outputDir: config.outputDir,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function handleSetConfig(message) {
  try {
    if (message.outputDir) config.outputDir = message.outputDir;
    if (message.capturesSubdir) config.capturesSubdir = message.capturesSubdir;
    if (message.exportsSubdir) config.exportsSubdir = message.exportsSubdir;

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    ensureDirectories();

    return { success: true, config };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ===== Index Management =====
function updateIndex(filename, metadata) {
  const indexPath = path.join(config.outputDir, 'index.json');
  let index = {};

  try {
    if (fs.existsSync(indexPath)) {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    }
  } catch (e) { /* fresh index */ }

  if (!index.captures) index.captures = {};

  index.captures[filename] = {
    ...metadata,
    addedAt: Date.now(),
  };

  index.lastUpdated = Date.now();
  index.totalCaptures = Object.keys(index.captures).length;

  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

// ===== Frontmatter Parser (simple, no deps needed at runtime) =====
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, content: content };
  }

  const fmRaw = match[1];
  const body = match[2];
  const frontmatter = {};

  // Simple YAML parser for flat key-value pairs
  const lines = fmRaw.split('\n');
  let currentKey = null;

  for (const line of lines) {
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      let value = kvMatch[2].trim();

      // Remove quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (/^\d+$/.test(value)) value = parseInt(value);

      frontmatter[currentKey] = value;
      continue;
    }

    // Array items
    const arrayMatch = line.match(/^\s+-\s+(.+)$/);
    if (arrayMatch && currentKey) {
      if (!Array.isArray(frontmatter[currentKey])) {
        frontmatter[currentKey] = [];
      }
      frontmatter[currentKey].push(arrayMatch[1].trim());
    }
  }

  return { frontmatter, content: body };
}

// ===== Question Generation (template-based, no AI) =====
function generateQuestion(fm) {
  const contentType = fm.content_type || 'general';
  const title = fm.title || 'this page';

  const templates = {
    article: [
      `Summarize the key points from "${title}".`,
      `What does the article "${title}" discuss?`,
    ],
    documentation: [
      `How does this work according to the documentation from ${fm.domain || 'the source'}?`,
      `What does "${title}" explain?`,
    ],
    tutorial: [
      `Walk me through the steps described in "${title}".`,
      `How do you accomplish what "${title}" teaches?`,
    ],
    forum: [
      `What is the best answer to the question discussed in "${title}"?`,
    ],
    code: [
      `Explain the code shown in "${title}".`,
    ],
    wiki: [
      `What information does the wiki page "${title}" provide?`,
    ],
    general: [
      `What information does ${fm.domain || 'this page'} provide about "${title}"?`,
    ],
  };

  const options = templates[contentType] || templates.general;
  return options[Math.floor(Math.random() * options.length)];
}

// ===== Utilities =====
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 200);
}

// ===== Main Loop =====
async function main() {
  process.stdin.resume();

  while (true) {
    try {
      const message = await readMessage();
      if (!message) break;

      const response = await handleMessage(message);
      sendMessage(response);
    } catch (err) {
      sendMessage({ success: false, error: err.message });
    }
  }
}

main().catch(err => {
  process.stderr.write(`[BrowsingCapture Host] Fatal error: ${err.message}\n`);
  process.exit(1);
});
