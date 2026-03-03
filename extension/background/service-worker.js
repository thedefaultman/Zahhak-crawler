
importScripts('../lib/jszip.min.js');

let isActive = false;
let useAI = false;
let apiSettings = {};
let activeMode = 'local'; // 'local' | 'thirdparty'
let localModelName = ''; // populated from companion /health
let capturedUrls = new Set();
let captureQueue = [];
let isProcessingQueue = false;
var settingsReady = null; // Promise that resolves when settings are loaded (var to avoid TDZ)

let exportProgress = {
  active: false,
  phase: '',       // 'naming' | 'processing' | 'sanitizing' | 'writing' | 'done' | 'error'
  current: 0,
  total: 0,
  currentTitle: '',
  result: null,    // final result when done
};

function broadcastExportProgress() {
  const msg = { type: 'EXPORT_PROGRESS', ...exportProgress };
  if (exportProgress.active) {
    const pct = exportProgress.total > 0
      ? Math.round((exportProgress.current / exportProgress.total) * 100)
      : 0;
    chrome.action.setBadgeText({ text: `${pct}%` });
    chrome.action.setBadgeBackgroundColor({ color: '#7C6FF2' });
  } else {
    chrome.action.setBadgeText({ text: isActive ? 'ON' : '' });
  }
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) {}
}

async function startBackgroundExport(mode, generateQuestions, sanitize) {
  if (exportProgress.active) return;
  exportProgress = { active: true, phase: 'naming', current: 0, total: 0, currentTitle: '', result: null };
  broadcastExportProgress();
  try {
    const result = await handleExport(mode, generateQuestions, sanitize);
    exportProgress.active = false;
    exportProgress.phase = result.success ? 'done' : 'error';
    exportProgress.result = result;
  } catch (err) {
    exportProgress.active = false;
    exportProgress.phase = 'error';
    exportProgress.result = { success: false, error: err.message };
  }
  broadcastExportProgress();
  setTimeout(() => {
    if (!exportProgress.active) {
      chrome.action.setBadgeText({ text: isActive ? 'ON' : '' });
    }
  }, 5000);
}

let crawlState = {
  active: false,
  seedDomain: '',       // The root domain we're crawling (same-domain constraint)
  queue: [],            // BFS queue of URLs to visit
  visited: new Set(),   // URLs we've already crawled
  tabId: null,          // The background tab we use for crawling
  maxPages: 100,        // Safety limit
  maxDepth: 5,          // Max link-follow depth
  delayMs: 2000,        // Delay between page loads (politeness)
  pagesCrawled: 0,
  depthMap: {},         // url → depth
  _linksResolver: null, // Callback to wake crawlLoop when links arrive
};

let datasetBuilderState = {
  active: false,
  phase: 'idle',           // 'idle'|'decomposing'|'searching'|'crawling'|'scoring'|'exporting'|'done'|'error'
  prompt: '',
  config: {
    targetSize: 100,
    goldThreshold: 0.85,
    silverThreshold: 0.65,
    maxSourcesPerQuery: 10,
    maxCrawlDepth: 2,
    outputFormat: 'jsonl',
    qualityTier: 'both',    // 'gold'|'silver'|'both'
    braveApiKey: '',
  },
  queries: [],               // LLM-generated search queries
  currentQuery: '',          // query currently being searched
  searchResults: [],         // [{ url, title, snippet }] from Brave
  urls: [],                  // deduplicated URLs to crawl
  visited: new Set(),
  capturedPages: [],         // pages captured during this build session
  entries: [],               // scored dataset entries
  stats: {
    queriesGenerated: 0,
    urlsFound: 0,
    urlsCrawled: 0,
    entriesScored: 0,
    goldCount: 0,
    silverCount: 0,
    discardCount: 0,
  },
  tabId: null,               // background tab (shared for search + crawl)
  _searchResolver: null,     // promise resolver for browser-mode search results
  _startedAt: null,          // timestamp for filtering captures
};

const DB_NAME = 'BrowsingCaptureDB';
const DB_VERSION = 1;
const STORE_NAME = 'captures';

chrome.runtime.onInstalled.addListener(() => {
  loadSettings();
});

loadSettings();

function loadSettings() {
  settingsReady = new Promise((resolve) => {
    chrome.storage.local.get(
      ['isActive', 'useAI', 'apiToken', 'model', 'activeMode', 'tpApiToken', 'tpModel'],
      (state) => {
        isActive = state.isActive || false;
        useAI = state.useAI || false;
        activeMode = state.activeMode || 'local';
        apiSettings = {
          provider: activeMode === 'local' ? 'ollama' : 'openai',
          apiToken: state.tpApiToken || state.apiToken || '',
          model: state.tpModel || state.model || '',
        };
        updateBadge();
        resolve();
      }
    );
  });
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'filename' });
        store.createIndex('timestamp', 'metadata.timestamp');
        store.createIndex('domain', 'metadata.domain');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveToDB(filename, content, metadata) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ filename, content, metadata, savedAt: Date.now() });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function getAllCaptures() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => { db.close(); resolve(request.result); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'TOGGLE_CAPTURE':
      isActive = msg.isActive;
      capturedUrls.clear();
      updateBadge();
      // When toggled ON, tell all open tabs to retry capture
      if (isActive) {
        chrome.tabs.query({}, (tabs) => {
          for (const tab of tabs) {
            if (tab.url && /^https?:/.test(tab.url)) {
              chrome.tabs.sendMessage(tab.id, { type: 'RETRY_CAPTURE' }).catch(() => {});
            }
          }
        });
      }
      break;

    case 'TOGGLE_AI':
      useAI = msg.useAI;
      break;

    case 'UPDATE_API_SETTINGS':
      apiSettings = msg.settings;
      break;

    case 'SET_MODE':
      activeMode = msg.mode;
      apiSettings.provider = msg.mode === 'local' ? 'ollama' : 'openai';
      chrome.storage.local.set({ activeMode: msg.mode });
      break;

    case 'FINETUNE_START':
      handleFinetuneStart(msg)
        .then(result => {})
        .catch(err => console.error('[Finetune] Error:', err));
      sendResponse({ started: true });
      break;

    case 'FINETUNE_STATUS':
      handleFinetuneStatus()
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;

    case 'PAGE_CAPTURED':
      handlePageCapture(msg.data);
      break;

    case 'EXPORT':
      // Fire-and-forget: export runs in background, popup can close
      startBackgroundExport(msg.mode, msg.generateQuestions, msg.sanitize);
      sendResponse({ started: true });
      break;

    case 'GET_EXPORT_STATUS':
      sendResponse({ ...exportProgress });
      break;

    case 'GET_ENHANCE_STATUS':
      sendResponse({
        active: isEnhancing,
        current: 0,
        total: aiEnhanceQueue.length,
        currentTitle: '',
      });
      break;

    case 'GET_CAPTURE_COUNT':
      getAllCaptures()
        .then(captures => sendResponse({ count: captures.length }))
        .catch(() => sendResponse({ count: 0 }));
      return true;

    case 'START_CRAWL':
      startCrawl(msg.url, msg.options || {})
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'STOP_CRAWL':
      stopCrawl();
      sendResponse({ success: true });
      break;

    case 'GET_CRAWL_STATUS':
      sendResponse({
        active: crawlState.active,
        pagesCrawled: crawlState.pagesCrawled,
        queueSize: crawlState.queue.length,
        seedDomain: crawlState.seedDomain,
      });
      break;

    case 'CRAWL_LINKS_DISCOVERED':
      // Content script found same-domain links on a crawled page
      if (crawlState.active) {
        handleCrawlLinksDiscovered(msg.links, msg.fromUrl);
      }
      break;

    case 'VALIDATE_HF_TOKEN':
      validateHFToken(msg.token)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ valid: false, error: err.message }));
      return true;

    case 'FETCH_HF_DATASETS':
      fetchUserDatasets(msg.token, msg.username)
        .then(datasets => sendResponse({ success: true, datasets }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'PUSH_TO_HF':
      pushToHuggingFace(msg.token, msg.username, msg.repoId, msg.isNew, msg.isPrivate);
      sendResponse({ started: true });
      break;

    case 'GET_HF_STATUS':
      sendResponse({ ...hfUploadProgress });
      break;

    case 'START_DATASET_BUILDER':
      startDatasetBuilder(msg.prompt, msg.config)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'STOP_DATASET_BUILDER':
      stopDatasetBuilder();
      sendResponse({ success: true });
      break;

    case 'GET_DATASET_BUILDER_STATUS':
      sendResponse({
        active: datasetBuilderState.active,
        phase: datasetBuilderState.phase,
        stats: { ...datasetBuilderState.stats },
        currentQuery: datasetBuilderState.currentQuery,
        entriesCount: datasetBuilderState.entries.length,
      });
      break;

    case 'DATASET_SEARCH_RESULTS':
      // Content script extracted results from search.brave.com
      if (datasetBuilderState.active && datasetBuilderState._searchResolver) {
        datasetBuilderState._searchResolver(msg.results || []);
        datasetBuilderState._searchResolver = null;
      }
      break;

    case 'SAVE_BRAVE_API_KEY':
      chrome.storage.local.set({ braveApiKey: msg.key });
      datasetBuilderState.config.braveApiKey = msg.key;
      sendResponse({ success: true });
      break;

    case 'VC_INIT':
      (async () => {
        try {
          // Load saved settings
          const vcSettings = await chrome.storage.local.get(['vcTier', 'vcBridgeToken']);
          voiceCommanderState.tier = vcSettings.vcTier || 'local';
          if (vcSettings.vcBridgeToken) {
            voiceCommanderState.bridgeToken = vcSettings.vcBridgeToken;
          }

          // Check companion app health
          const health = await ptHealthCheck();
          if (health) {
            voiceCommanderState.pinchtabConnected = health.pinchtab?.status === 'running';
            if (health.bridgeToken) {
              voiceCommanderState.bridgeToken = health.bridgeToken;
              await chrome.storage.local.set({ vcBridgeToken: health.bridgeToken });
            }
            // Populate local model name from companion
            if (health.modelName) {
              localModelName = health.modelName;
            }
            sendResponse({
              success: true,
              pinchtab: health.pinchtab?.status === 'running',
              vosk: health.vosk?.status === 'running',
              ollama: health.ollama?.status === 'running',
              tier: voiceCommanderState.tier,
            });
          } else {
            voiceCommanderState.pinchtabConnected = false;
            sendResponse({
              success: true,
              pinchtab: false,
              vosk: false,
              ollama: false,
              tier: voiceCommanderState.tier,
            });
          }
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;

    case 'VC_REQUEST_MIC':
      // Inject mic capture script into active tab (local or realtime)
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab || !tab.id) {
            sendResponse({ success: false, error: 'No active tab found' });
            return;
          }
          // Skip chrome:// and other restricted URLs
          if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:'))) {
            sendResponse({ success: false, error: 'Cannot capture mic on this page. Navigate to a regular website first.' });
            return;
          }
          voiceCommanderState.micTabId = tab.id;

          // Choose script based on tier
          const script = msg.tier === 'openai_realtime'
            ? 'content/realtime-session.js'
            : 'content/mic-capture.js';

          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: [script],
          });
          sendResponse({ success: true });
        } catch (err) {
          console.error('[VoiceCommander] Mic injection error:', err);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;

    case 'VC_STOP_MIC':
      // Tell the content script to stop capturing
      if (voiceCommanderState.micTabId) {
        chrome.tabs.sendMessage(voiceCommanderState.micTabId, { type: 'CONTENT_STOP_MIC' }).catch(() => {});
        voiceCommanderState.micTabId = null;
      }
      sendResponse({ success: true });
      break;

    case 'OFFSCREEN_MIC_STARTED':
    case 'REALTIME_SESSION_STARTED':
      // Content script confirms mic/realtime session is active — notify popup
      broadcastVCStatus();
      break;

    case 'VC_REALTIME_TRANSCRIPT':
      // Transcript events from the realtime content script
      addTranscriptEntry(msg.role || 'assistant', msg.text || '', msg.role === 'action' ? 'error' : undefined);
      break;

    case 'OFFSCREEN_MIC_ERROR':
      addTranscriptEntry('action', `Mic error: ${msg.error}`, 'error');
      broadcastVCStatus();
      break;

    case 'VC_START_LISTENING':
      voiceCommanderState.active = true;
      voiceCommanderState.listening = true;
      voiceCommanderState.tier = msg.tier || voiceCommanderState.tier;
      broadcastVCStatus();
      sendResponse({ success: true });
      break;

    case 'VC_STOP_LISTENING':
      voiceCommanderState.active = false;
      voiceCommanderState.listening = false;
      voiceCommanderState.processing = false;
      voiceCommanderState.conversationHistory = [];
      broadcastVCStatus();
      sendResponse({ success: true });
      break;

    case 'VC_AUDIO_CHUNK':
      // Route audio to appropriate tier pipeline
      (async () => {
        try {
          await processAudioLocal(msg.audio);
          sendResponse({ success: true });
        } catch (err) {
          console.error('[VoiceCommander] Audio processing error:', err);
          addTranscriptEntry('action', `Error: ${err.message}`, 'error');
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;

    case 'VC_TOOL_CALL':
      // From OpenAI Realtime tier — popup sends tool call, we execute
      (async () => {
        try {
          const result = await executeVCTool(msg.toolName, msg.args || {});
          addTranscriptEntry('action', result.output, msg.toolName);
          sendResponse({ success: true, result });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;

    case 'VC_GET_STATUS':
      sendResponse({
        active: voiceCommanderState.active,
        tier: voiceCommanderState.tier,
        listening: voiceCommanderState.listening,
        processing: voiceCommanderState.processing,
        pinchtabConnected: voiceCommanderState.pinchtabConnected,
        transcript: voiceCommanderState.transcript.slice(-20),
      });
      break;

    case 'VC_SAVE_SETTINGS':
      (async () => {
        const toSave = {};
        if (msg.tier) {
          voiceCommanderState.tier = msg.tier;
          toSave.vcTier = msg.tier;
        }
        await chrome.storage.local.set(toSave);
        sendResponse({ success: true });
      })();
      return true;

    case 'VC_GET_EPHEMERAL_TOKEN':
      // OpenAI Realtime — get ephemeral token for WebRTC
      (async () => {
        try {
          const sessionData = await getRealtimeEphemeralToken();
          sendResponse({ success: true, ...sessionData });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;

    default:
      break;
  }
});

async function handlePageCapture(pageData) {
  if (settingsReady) await settingsReady;
  if (!isActive) return;

  const urlKey = normalizeUrl(pageData.url);
  if (capturedUrls.has(urlKey)) return;

  // Skip pages with too few words (likely app UI, not content)
  const wordCount = pageData.metadata?.wordCount || 0;
  if (wordCount < 50) return;

  capturedUrls.add(urlKey);

  captureQueue.push(pageData);
  processQueue();
}

async function processQueue() {
  if (isProcessingQueue || captureQueue.length === 0) return;
  isProcessingQueue = true;

  while (captureQueue.length > 0) {
    const pageData = captureQueue.shift();

    try {
      // Save immediately with raw markdown — no LLM wait
      pageData.aiEnhanced = false;
      const finalMarkdown = pageData.markdownContent;
      const obsidianMd = buildObsidianMarkdown(pageData, finalMarkdown);
      const filename = generateFilename(pageData.url, pageData.title, pageData.timestamp);

      await saveToDB(filename, obsidianMd, {
        url: pageData.url,
        title: pageData.title,
        domain: pageData.domain,
        timestamp: pageData.timestamp,
        wordCount: pageData.metadata.wordCount,
        contentType: pageData.contentType,
      });

      await updateCaptureStats(pageData);

      // Notify popup instantly — user sees the capture right away
      chrome.runtime.sendMessage({
        type: 'CAPTURE_COMPLETE',
        data: {
          title: pageData.title,
          domain: pageData.domain,
          wordCount: pageData.metadata.wordCount,
          timestamp: Date.now(),
        },
      }).catch(() => {});

      if (useAI && apiSettings.apiToken) {
        aiEnhanceQueue.push({ filename, pageData });
        scheduleAIEnhancement();
      }

    } catch (err) {
      console.error('[BrowsingCapture] Capture processing error:', err);
    }
  }

  isProcessingQueue = false;
}

let aiEnhanceQueue = [];
let isEnhancing = false;
let enhanceTimer = null;

// Batch enhancement — wait 3s after last capture before starting
function scheduleAIEnhancement() {
  if (enhanceTimer) clearTimeout(enhanceTimer);
  enhanceTimer = setTimeout(() => { processAIEnhanceQueue(); }, 3000);
}

async function processAIEnhanceQueue() {
  if (isEnhancing || aiEnhanceQueue.length === 0) return;
  isEnhancing = true;

  const batch = aiEnhanceQueue.splice(0);
  const total = batch.length;
  let completed = 0;

  broadcastEnhanceStatus({ active: true, current: 0, total, currentTitle: '' });

  for (const item of batch) {
    const { filename, pageData } = item;
    completed++;
    broadcastEnhanceStatus({
      active: true,
      current: completed,
      total,
      currentTitle: pageData.title,
    });

    try {
      const enhanced = await enhanceWithAI(pageData);
      if (enhanced) {
        pageData.aiEnhanced = true;
        const obsidianMd = buildObsidianMarkdown(pageData, enhanced);
        await saveToDB(filename, obsidianMd, {
          url: pageData.url,
          title: pageData.title,
          domain: pageData.domain,
          timestamp: pageData.timestamp,
          wordCount: pageData.metadata.wordCount,
          contentType: pageData.contentType,
        });
      }
    } catch (err) {
      console.warn('[BrowsingCapture] AI enhancement failed for', pageData.title, ':', err.message);
    }

    // Delay between API calls to avoid rate limits
    if (completed < total) await sleep(1500);
  }

  broadcastEnhanceStatus({ active: false, current: total, total, currentTitle: '' });
  isEnhancing = false;

  if (aiEnhanceQueue.length > 0) {
    scheduleAIEnhancement();
  }
}

function broadcastEnhanceStatus(status) {
  const msg = { type: 'ENHANCE_STATUS', ...status };
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) {}
}

function buildObsidianMarkdown(pageData, markdownContent) {
  const fm = pageData.metadata;
  const tags = generateTags(pageData);

  let md = '---\n';
  md += `title: "${escapeYaml(pageData.title)}"\n`;
  md += `source: "${pageData.url}"\n`;
  md += `domain: "${pageData.domain}"\n`;

  if (fm.author) md += `author: "${escapeYaml(fm.author)}"\n`;
  if (fm.datePublished) md += `date_published: "${fm.datePublished}"\n`;

  md += `date_captured: "${pageData.timestamp}"\n`;

  if (tags.length > 0) {
    md += 'tags:\n';
    tags.forEach(tag => { md += `  - ${tag}\n`; });
  }

  md += `content_type: "${pageData.contentType}"\n`;
  md += `word_count: ${fm.wordCount}\n`;
  md += `ai_enhanced: ${pageData.aiEnhanced || false}\n`;
  md += '---\n\n';

  md += `# ${pageData.title}\n\n`;

  if (fm.description) {
    md += `> ${fm.description}\n\n`;
  }

  md += markdownContent;
  md += '\n\n';

  md += '---\n\n';
  md += `*Captured from [${pageData.domain}](${pageData.url}) on ${new Date(pageData.timestamp).toLocaleDateString()}.*\n`;

  return md;
}

function generateTags(pageData) {
  const tags = [];
  tags.push(pageData.contentType);

  // Use normalized domain for consistent tags (e.g., gmail.mcp.claude.com → claude-com)
  const normalizedDomain = normalizeSubdomain(pageData.domain);
  const domainTag = normalizedDomain.replace(/\./g, '-');
  tags.push(`source/${domainTag}`);

  if (pageData.metadata.keywords) {
    pageData.metadata.keywords.slice(0, 5).forEach(kw => {
      const tag = kw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
      if (tag.length > 2) tags.push(tag);
    });
  }

  return [...new Set(tags)];
}

async function enhanceWithAI(pageData) {
  const systemPrompt = `You are a content structuring assistant. Your job is to take raw markdown extracted from a web page and produce a clean, well-organized Obsidian-style markdown note.

Rules:
- Preserve ALL factual information from the original
- Clean up formatting artifacts, navigation remnants, and boilerplate
- Create a clear heading hierarchy
- Add a brief "Summary" section at the top with 2-3 key takeaways
- Preserve code blocks, tables, and lists
- Remove duplicate content
- Do NOT add information that wasn't in the original
- Output ONLY the cleaned markdown content (no frontmatter, no explanations)`;

  const userPrompt = `Clean and structure this web page content into well-organized markdown:

Page Title: ${pageData.title}
Source: ${pageData.url}
Content Type: ${pageData.contentType}

--- Raw Content ---
${pageData.markdownContent.substring(0, 12000)}`;

  return await callAIAPI(systemPrompt, userPrompt);
}

// OpenAI reasoning models: no temperature, no top_p, use max_completion_tokens
const OPENAI_REASONING_MODELS = /^(gpt-5|gpt-4\.?5|o[1-9]|o[1-9]-|chatgpt-)/i;

function isOpenAIReasoningModel(model) {
  return OPENAI_REASONING_MODELS.test(model);
}

async function callAIAPI(systemPrompt, userPrompt) {
  if (activeMode === 'local') {
    return callLocalLLM(systemPrompt, userPrompt);
  }
  return callOpenAI(systemPrompt, userPrompt);
}

async function callLocalLLM(systemPrompt, userPrompt) {
  // Use Ollama's OpenAI-compatible endpoint
  const model = localModelName || 'qwen3.5:4b';
  const url = 'http://localhost:11434/v1/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 4000,
    temperature: 0.3,
  };

  console.log(`[BrowsingCapture] API call → local (Ollama) | model: ${model}`);

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Local LLM error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callOpenAI(systemPrompt, userPrompt) {
  const model = apiSettings.model || 'gpt-5-nano';
  const isReasoning = isOpenAIReasoningModel(model);
  const url = 'https://api.openai.com/v1/chat/completions';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiSettings.apiToken}`,
  };
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };
  if (isReasoning) {
    body.max_completion_tokens = 4000;
  } else {
    body.max_tokens = 4000;
    body.temperature = 0.3;
  }

  console.log(`[BrowsingCapture] API call → openai | model: ${model} | reasoning: ${isReasoning ? 'yes' : 'no'}`);

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// Two-layer approach: fast regex patterns + optional LLM for context-aware detection.
// Inspired by redact-pii and OpenRedaction patterns, built directly into the extension.

const PII_PATTERNS = [
  // Email addresses
  { name: 'EMAIL', pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, replacement: '[EMAIL_REDACTED]' },

  // Phone numbers (US/international formats)
  // Negative lookbehind avoids matching inside UUIDs or hex strings (preceded by hex + hyphen)
  { name: 'PHONE', pattern: /(?<![0-9a-f]-|[0-9a-f]{2})(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/gi, replacement: '[PHONE_REDACTED]' },
  { name: 'PHONE_INTL', pattern: /\+\d{1,4}[-.\s]?\d{2,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/g, replacement: '[PHONE_REDACTED]' },

  // Credit card numbers (Visa, MC, Amex, Discover — 13-19 digits with optional separators)
  { name: 'CREDIT_CARD', pattern: /\b(?:\d{4}[-\s]?){3}\d{1,7}\b/g, replacement: '[CREDIT_CARD_REDACTED]' },

  // Social Security Numbers (US)
  { name: 'SSN', pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g, replacement: '[SSN_REDACTED]' },

  // IP addresses (IPv4)
  { name: 'IP_ADDRESS', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: '[IP_REDACTED]' },

  // API keys / tokens (common patterns: long alphanumeric strings with prefixes)
  { name: 'API_KEY_SK', pattern: /\b(?:sk|pk|ak|rk)-[A-Za-z0-9_\-]{20,}\b/g, replacement: '[API_KEY_REDACTED]' },
  { name: 'API_KEY_PREFIX', pattern: /\b(?:sk-ant-api|sk-proj|ghp_|gho_|ghs_|ghr_|glpat-|xoxb-|xoxp-|xoxs-)[A-Za-z0-9_\-]{10,}\b/g, replacement: '[API_KEY_REDACTED]' },
  // Bearer tokens in actual auth headers (not prose like "Bearer Authentication")
  { name: 'BEARER_TOKEN', pattern: /Bearer\s+[A-Za-z0-9_\-.]{20,}\b/g, replacement: 'Bearer [TOKEN_REDACTED]' },

  // Masked/partial API keys from dashboards (e.g., sk-..._00A, sk-...wKsA)
  { name: 'MASKED_KEY', pattern: /\b(?:sk|pk|ak|rk)-\.{2,}[A-Za-z0-9_]{2,}\b/g, replacement: '[API_KEY_REDACTED]' },

  // AWS keys
  { name: 'AWS_KEY', pattern: /\b(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}\b/g, replacement: '[AWS_KEY_REDACTED]' },
  { name: 'AWS_SECRET', pattern: /\b[A-Za-z0-9/+=]{40}\b(?=\s|$)/g, replacement: '[AWS_SECRET_REDACTED]' },

  // Generic secrets (long hex strings — require 40+ chars to avoid matching UUIDs which are 32 hex with hyphens)
  { name: 'HEX_SECRET', pattern: /\b[0-9a-f]{40,64}\b/gi, replacement: '[SECRET_REDACTED]' },

  // Private keys (PEM format)
  { name: 'PRIVATE_KEY', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g, replacement: '[PRIVATE_KEY_REDACTED]' },

  // Password patterns in config/env
  { name: 'PASSWORD_FIELD', pattern: /(?:password|passwd|pwd|secret|token|api_key|apikey|access_key|private_key)\s*[:=]\s*["']?[^\s"']{4,}["']?/gi, replacement: '[CREDENTIAL_REDACTED]' },

  // Connection strings (database URLs)
  { name: 'DB_CONNECTION', pattern: /(?:mongodb|postgres|mysql|redis|amqp|smtp):\/\/[^\s"']+/gi, replacement: '[CONNECTION_STRING_REDACTED]' },

  // Street addresses (basic US pattern)
  { name: 'ADDRESS', pattern: /\b\d{1,5}\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Rd|Road|Way|Ct|Court|Pl|Place)\b\.?/g, replacement: '[ADDRESS_REDACTED]' },
];

function sanitizeWithRegex(text) {
  if (!text) return { text: text || '', redactionCount: 0 };
  let sanitized = text;
  let redactionCount = 0;

  for (const { pattern, replacement } of PII_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = sanitized.match(pattern);
    if (matches) {
      redactionCount += matches.length;
      sanitized = sanitized.replace(pattern, replacement);
    }
  }

  return { text: sanitized, redactionCount };
}

// LLM-based sanitization (deep, context-aware — catches company names, project names, internal jargon)
async function sanitizeWithLLM(text) {
  const systemPrompt = `You are a data sanitization assistant. Your job is to identify and redact sensitive/private information from text that will be used for AI training data.

REDACT the following types of information by replacing them with bracketed labels:
- Personal names → [NAME_REDACTED]
- Company/organization names (NOT well-known public companies like Google, Microsoft, GitHub) → [COMPANY_REDACTED]
- Internal project/product codenames → [PROJECT_REDACTED]
- Internal URLs, intranet links, or staging/dev environment URLs → [INTERNAL_URL_REDACTED]
- Slack channel names, internal team names → [TEAM_REDACTED]
- Customer names or client references → [CLIENT_REDACTED]
- Financial figures tied to specific deals/contracts → [AMOUNT_REDACTED]
- Employee IDs, badge numbers, internal identifiers → [ID_REDACTED]

KEEP the following UNCHANGED (do NOT redact):
- Well-known public companies (Google, Microsoft, GitHub, Amazon, etc.)
- Open source project names and public repositories
- Technical terms, library names, framework names
- Public documentation content
- Generic job titles
- Public URLs to documentation, blog posts, etc.

Output ONLY the sanitized text. Do not add explanations or wrap in code blocks.`;

  const userPrompt = `Sanitize this text. Only redact genuinely private/sensitive items. Keep all public technical content intact:\n\n${text.substring(0, 10000)}`;

  try {
    const result = await callAIAPI(systemPrompt, userPrompt);
    if (result && result.length > text.length * 0.3) {
      return result;
    }
  } catch (e) {
    console.warn('[BrowsingCapture] LLM sanitization failed:', e.message);
  }
  return null; // Fallback: caller uses regex-only result
}

async function sanitizeContent(text, useLLM = false) {
  const { text: regexSanitized, redactionCount } = sanitizeWithRegex(text);

  if (useLLM && apiSettings.apiToken) {
    const llmResult = await sanitizeWithLLM(regexSanitized);
    if (llmResult) {
      return { text: llmResult, redactionCount, llmUsed: true };
    }
  }

  return { text: regexSanitized, redactionCount, llmUsed: false };
}

// mode: 'zip' = single .zip download | 'folder' = individual files to Downloads folder
// sanitize: false | 'regex' | 'llm' — data sanitization level
async function handleExport(mode, generateQuestions, sanitize) {
  console.log('[BrowsingCapture] handleExport called — mode:', mode, 'sanitize:', sanitize, 'type:', typeof sanitize);
  console.log('[BrowsingCapture] apiSettings at export time:', JSON.stringify({ provider: apiSettings.provider, hasToken: !!apiSettings.apiToken, tokenLen: apiSettings.apiToken?.length, model: apiSettings.model }));
  if (settingsReady) await settingsReady;
  console.log('[BrowsingCapture] apiSettings AFTER settingsReady:', JSON.stringify({ provider: apiSettings.provider, hasToken: !!apiSettings.apiToken, tokenLen: apiSettings.apiToken?.length, model: apiSettings.model }));

  const captures = await getAllCaptures();
  if (captures.length === 0) {
    return { success: false, error: 'No captures to export. Start capturing pages first!' };
  }

  exportProgress.total = captures.length;
  exportProgress.phase = 'naming';
  broadcastExportProgress();

  const storageState = await chrome.storage.local.get(['exportFolder']);
  const baseFolder = storageState.exportFolder || 'BrowsingCapture';
  const byDomain = groupCapturesByDomain(captures);

  // Try LLM-based smart filenames (returns {} if no API key)
  const smartNames = await generateSmartFilenames(captures);

  exportProgress.phase = 'processing';
  broadcastExportProgress();

  // Build all file entries: { path, content } for every file
  const files = [];
  let totalPages = 0;
  let totalRedactions = 0;

  for (const [domain, domainCaptures] of Object.entries(byDomain)) {
    for (const capture of domainCaptures) {
      totalPages++;
      exportProgress.current = totalPages;
      exportProgress.currentTitle = capture.metadata?.title || 'Untitled';
      exportProgress.phase = sanitize ? 'sanitizing' : 'processing';
      broadcastExportProgress();

      // Generate the base filename (without extension) — shared between .md and .jsonl
      const date = new Date(capture.metadata?.timestamp || Date.now()).toISOString().split('T')[0];
      const smartName = smartNames[capture.filename];
      const titleSlug = smartName
        ? smartName.replace(/\.md$/, '')
        : generateCleanFilename(capture.metadata?.title).replace(/\.md$/, '');
      const baseName = `${date}_${titleSlug}`;

      let mdContent = capture.content;
      if (sanitize) {
        const useLLM = sanitize === 'llm';
        console.log('[BrowsingCapture] Sanitizing page:', capture.metadata?.title, '| useLLM:', useLLM, '| apiToken exists:', !!apiSettings.apiToken);
        const result = await sanitizeContent(mdContent, useLLM);
        console.log('[BrowsingCapture] Sanitization result — redactions:', result.redactionCount, '| llmUsed:', result.llmUsed);
        mdContent = result.text;
        totalRedactions += result.redactionCount;
      } else {
        console.log('[BrowsingCapture] Sanitization SKIPPED — sanitize value is:', sanitize);
      }

      files.push({
        path: `${domain}/notes/${baseName}.md`,
        content: mdContent,
      });

      const jsonlLines = [];

      const sanitizedCapture = sanitize
        ? { ...capture, content: mdContent }
        : capture;

      if (generateQuestions && apiSettings.apiToken) {
        try {
          const questions = await generateQuestionsForContent(sanitizedCapture);
          if (questions && questions.length > 0) {
            for (const q of questions) {
              let answer = q.answer;
              if (sanitize) {
                const ansResult = await sanitizeContent(answer, false); // regex only for speed
                answer = ansResult.text;
              }
              jsonlLines.push(JSON.stringify({
                messages: [
                  { role: 'system', content: buildSystemMessage(capture.metadata) },
                  { role: 'user', content: q.question },
                  { role: 'assistant', content: answer },
                ],
              }));
            }
          }
        } catch (e) {
          console.warn('[BrowsingCapture] AI Q&A failed:', capture.filename, e.message);
        }
      }

      // Fallback or add template entry if AI didn't produce anything
      if (jsonlLines.length === 0) {
        jsonlLines.push(JSON.stringify(buildJsonlEntry(sanitizedCapture)));
      }

      files.push({
        path: `${domain}/training-data/${baseName}.jsonl`,
        content: jsonlLines.join('\n') + '\n',
      });
    }
  }

  exportProgress.phase = 'writing';
  exportProgress.currentTitle = mode === 'zip' ? 'Creating ZIP...' : 'Writing files...';
  broadcastExportProgress();

  const domainCount = Object.keys(byDomain).length;
  let result;
  if (mode === 'zip') {
    result = await exportAsZip(baseFolder, files, totalPages, domainCount);
  } else {
    result = await exportToFolder(baseFolder, files, totalPages, domainCount);
  }

  if (sanitize && result.success) {
    result.redactions = totalRedactions;
  }

  return result;
}

async function exportAsZip(baseFolder, files, totalPages, domainCount) {
  const zip = new JSZip();

  for (const file of files) {
    zip.file(`${baseFolder}/${file.path}`, file.content);
  }

  const base64 = await zip.generateAsync({ type: 'base64' });
  const timestamp = new Date().toISOString().split('T')[0];
  const dataUrl = 'data:application/zip;base64,' + base64;

  return new Promise((resolve) => {
    chrome.downloads.download({
      url: dataUrl,
      filename: `${baseFolder}-${timestamp}.zip`,
      saveAs: true,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve({ success: true, count: totalPages, domains: domainCount });
      }
    });
  });
}

// Export as individual files to Downloads folder (additive — won't overwrite existing)
async function exportToFolder(baseFolder, files, totalPages, domainCount) {
  let downloadedCount = 0;

  for (const file of files) {
    const dataUrl = 'data:application/octet-stream;base64,' + btoa(unescape(encodeURIComponent(file.content)));

    await new Promise((resolve) => {
      chrome.downloads.download({
        url: dataUrl,
        filename: `${baseFolder}/${file.path}`,
        conflictAction: 'uniquify',
      }, () => {
        downloadedCount++;
        resolve();
      });
    });
  }

  return { success: true, count: totalPages, domains: domainCount, files: downloadedCount };
}

function buildSystemMessage(meta) {
  return [
    'You are a knowledgeable assistant. Use the following reference material to answer questions accurately.',
    '',
    `Source: ${meta.url || ''}`,
    `Title: ${meta.title || ''}`,
    `Domain: ${meta.domain || ''}`,
    meta.contentType ? `Content Type: ${meta.contentType}` : '',
  ].filter(Boolean).join('\n');
}

function stripFrontmatter(text) {
  if (!text) return '';
  return text.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
}

function extractContentHeadings(text) {
  const headings = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/^#{2,3}\s+(.+)/);
    if (match) headings.push(match[1].trim());
  }
  return headings;
}

function buildJsonlEntry(capture) {
  const meta = capture.metadata || {};
  const cleanContent = stripFrontmatter(capture.content || '');
  const headings = extractContentHeadings(cleanContent);
  return {
    messages: [
      {
        role: 'system',
        content: buildSystemMessage(meta),
      },
      {
        role: 'user',
        content: generateTemplateQuestion(meta, headings, cleanContent),
      },
      {
        role: 'assistant',
        content: cleanContent,
      },
    ],
  };
}

function generateTemplateQuestion(meta, headings = [], content = '') {
  const contentType = meta.contentType || 'general';
  const title = meta.title || 'this page';

  // Try to build a content-aware question from headings or key terms
  const contentAwareQuestions = [];

  if (headings.length > 0) {
    // Use actual section headings for specific questions
    const randomHeading = headings[Math.floor(Math.random() * headings.length)];
    contentAwareQuestions.push(
      `What does the section on "${randomHeading}" cover in "${title}"?`,
      `Explain the concept of "${randomHeading}" as described in "${title}".`,
    );
    if (headings.length >= 2) {
      contentAwareQuestions.push(
        `What are the main topics covered in "${title}", including ${headings.slice(0, 3).map(h => `"${h}"`).join(', ')}?`,
      );
    }
  }

  // Extract key terms from content for more targeted questions
  if (content.length > 100) {
    // Look for defined terms (bold text, "What is X?" patterns)
    const definedTerms = [];
    const defPatterns = content.matchAll(/(?:what is |what are |\*\*)([\w\s-]{3,30})(?:\*\*|\?)/gi);
    for (const m of defPatterns) {
      definedTerms.push(m[1].trim());
    }
    if (definedTerms.length > 0) {
      const term = definedTerms[Math.floor(Math.random() * definedTerms.length)];
      contentAwareQuestions.push(`What is ${term} and how is it described in "${title}"?`);
    }
  }

  // Fallback to content-type templates
  const templates = {
    article: [
      `Summarize the key points from "${title}".`,
      `What are the main arguments or findings discussed in "${title}"?`,
    ],
    documentation: [
      `Explain the process or system described in "${title}".`,
      `What are the key concepts and steps outlined in "${title}"?`,
    ],
    tutorial: [
      `Walk me through the steps described in "${title}".`,
      `What will I learn by following "${title}" and what are the prerequisites?`,
    ],
    forum: [
      `What is the best answer to the question in "${title}"?`,
      `What solutions were proposed in the discussion "${title}"?`,
    ],
    code: [
      `Explain the code and its purpose as shown in "${title}".`,
      `How does the implementation in "${title}" work?`,
    ],
    wiki: [
      `Explain the key concepts and phases described in "${title}".`,
      `What are the important details and processes outlined in "${title}"?`,
    ],
    general: [
      `What are the main points covered in "${title}"?`,
      `Provide a comprehensive overview of what "${title}" describes.`,
    ],
  };

  // Prefer content-aware questions when available (70% chance)
  if (contentAwareQuestions.length > 0 && Math.random() < 0.7) {
    return contentAwareQuestions[Math.floor(Math.random() * contentAwareQuestions.length)];
  }

  const options = templates[contentType] || templates.general;
  return options[Math.floor(Math.random() * options.length)];
}

async function generateQuestionsForContent(capture) {
  const systemPrompt = `You are a training data generator. Given a web page's content, generate 2-3 natural questions that a user might ask about this content, along with comprehensive answers based on the content.

Output as JSON array: [{"question": "...", "answer": "..."}]

Rules:
- Questions should be natural and diverse (factual, how-to, conceptual)
- Answers should be thorough and based ONLY on the provided content
- Output ONLY valid JSON, no other text`;

  const content = stripFrontmatter(capture.content || '').substring(0, 6000);
  const userPrompt = `Generate Q&A training pairs for this content:

Title: ${capture.metadata.title}
Source: ${capture.metadata.url}

Content:
${content}`;

  const response = await callAIAPI(systemPrompt, userPrompt);
  return JSON.parse(response);
}


async function startCrawl(seedUrl, options = {}) {
  if (crawlState.active) {
    return { success: false, error: 'A crawl is already in progress.' };
  }

  // Mutual exclusion with Dataset Builder
  if (datasetBuilderState.active) {
    return { success: false, error: 'Cannot start crawl while Dataset Builder is running. Stop it first.' };
  }

  if (!isActive) {
    isActive = true;
    await chrome.storage.local.set({ isActive: true });
    updateBadge();
  }

  let seedUrlObj;
  try {
    seedUrlObj = new URL(seedUrl);
  } catch (e) {
    return { success: false, error: 'Invalid URL: ' + seedUrl };
  }

  const seedDomain = normalizeSubdomain(seedUrlObj.hostname.replace(/^www\./, ''));

  crawlState.active = true;
  crawlState.seedDomain = seedDomain;
  crawlState.queue = [];  // Seed URL is handled by chrome.tabs.create, not the queue
  crawlState.visited = new Set();
  crawlState.pagesCrawled = 0;
  crawlState.maxPages = options.maxPages || 100;
  crawlState.maxDepth = options.maxDepth || 5;
  crawlState.delayMs = options.delayMs || 2000;
  crawlState.depthMap = { [seedUrl]: 0 };
  crawlState.tabId = null;

  try {
    const tab = await chrome.tabs.create({ url: seedUrl, active: false });
    crawlState.tabId = tab.id;
  } catch (e) {
    crawlState.active = false;
    return { success: false, error: 'Failed to create crawl tab: ' + e.message };
  }

  broadcastCrawlStatus();

  // Start the crawl loop (don't await — runs in background)
  crawlState.visited.add(normalizeUrl(seedUrl));
  // The first page will be captured by the content script injected automatically.
  // We wait for it, then continue with the queue.
  crawlLoop();

  return { success: true, seedDomain, maxPages: crawlState.maxPages, maxDepth: crawlState.maxDepth };
}

function stopCrawl() {
  crawlState.active = false;

  if (crawlState.tabId) {
    chrome.tabs.remove(crawlState.tabId).catch(() => {});
    crawlState.tabId = null;
  }

  broadcastCrawlStatus();
}

function broadcastCrawlStatus() {
  chrome.runtime.sendMessage({
    type: 'CRAWL_STATUS_UPDATE',
    active: crawlState.active,
    pagesCrawled: crawlState.pagesCrawled,
    queueSize: crawlState.queue.length,
    seedDomain: crawlState.seedDomain,
  }).catch(() => { /* popup may not be open */ });
}

function handleCrawlLinksDiscovered(links, fromUrl) {
  const fromDepth = crawlState.depthMap[fromUrl] ?? 0;
  const nextDepth = fromDepth + 1;

  if (nextDepth > crawlState.maxDepth) return;

  let added = 0;
  for (const link of links) {
    const normalized = normalizeUrl(link);
    if (crawlState.visited.has(normalized)) continue;

    // Same-domain check
    try {
      const linkDomain = normalizeSubdomain(new URL(link).hostname.replace(/^www\./, ''));
      if (linkDomain !== crawlState.seedDomain) continue;
    } catch (e) {
      continue;
    }

    crawlState.visited.add(normalized);
    crawlState.depthMap[link] = nextDepth;
    crawlState.queue.push(link);
    added++;
  }

  if (added > 0) {
    broadcastCrawlStatus();
    // Wake up the crawl loop if it's waiting for links
    if (crawlState._linksResolver) {
      crawlState._linksResolver();
      crawlState._linksResolver = null;
    }
  }
}

// Wait for links to arrive in the queue (with timeout).
// The content script has a ~2500ms delay before extraction, plus processing time,
// so we need to actively wait for CRAWL_LINKS_DISCOVERED rather than just sleeping.
function waitForLinks(timeoutMs = 10000) {
  return new Promise((resolve) => {
    // If queue already has items, resolve immediately
    if (crawlState.queue.length > 0) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      crawlState._linksResolver = null;
      resolve(); // Resolve even if no links arrived (page might have none)
    }, timeoutMs);

    // Store resolver so handleCrawlLinksDiscovered can wake us up
    crawlState._linksResolver = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
}

async function crawlLoop() {
  try {
    await waitForTabLoad(crawlState.tabId);
  } catch (e) {
    console.warn('[BrowsingCapture] Seed page load failed:', e.message);
    stopCrawl();
    return;
  }

  // Wait for content script to extract content and discover links.
  // Content script has CAPTURE_DELAY_MS (2500ms) + extraction time + link discovery.
  // We use a promise-based wait that resolves when links actually arrive.
  await waitForLinks(12000);

  crawlState.pagesCrawled++;
  broadcastCrawlStatus();

  if (crawlState.queue.length === 0) {
    console.log('[BrowsingCapture] Seed page had no same-domain links to follow.');
    stopCrawl();
    return;
  }

  while (crawlState.active && crawlState.queue.length > 0) {
    if (crawlState.pagesCrawled >= crawlState.maxPages) {
      console.log(`[BrowsingCapture] Crawl hit max pages limit (${crawlState.maxPages})`);
      break;
    }

    const nextUrl = crawlState.queue.shift();

    // Navigate the crawl tab
    try {
      if (!crawlState.tabId) break;

      await chrome.tabs.update(crawlState.tabId, { url: nextUrl });

      // Wait for page to fully load
      await waitForTabLoad(crawlState.tabId);

      // Give content script time to extract and capture (CAPTURE_DELAY_MS = 2500ms + processing)
      // Even if queue already has items, we must wait for the page to be captured
      await sleep(3500);

      // If queue is empty, wait longer for link discovery to arrive
      if (crawlState.queue.length === 0) {
        await waitForLinks(8000);
      }

      crawlState.pagesCrawled++;
      broadcastCrawlStatus();

    } catch (err) {
      console.warn('[BrowsingCapture] Crawl navigation error:', err.message);
      // Tab might have been closed by user
      if (err.message?.includes('No tab')) {
        break;
      }
      // Skip this URL and continue
      continue;
    }
  }

  const total = crawlState.pagesCrawled;
  stopCrawl();
  console.log(`[BrowsingCapture] Crawl complete. ${total} pages captured.`);
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // Resolve anyway after timeout
    }, 15000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    // Check if tab still exists
    chrome.tabs.get(tabId).catch(() => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('No tab with id: ' + tabId));
    });
  });
}


function broadcastDatasetStatus() {
  chrome.runtime.sendMessage({
    type: 'DATASET_BUILDER_STATUS',
    active: datasetBuilderState.active,
    phase: datasetBuilderState.phase,
    stats: { ...datasetBuilderState.stats },
    currentQuery: datasetBuilderState.currentQuery,
    entriesCount: datasetBuilderState.entries.length,
  }).catch(() => {});
}

async function startDatasetBuilder(prompt, config = {}) {
  if (datasetBuilderState.active) {
    return { success: false, error: 'Dataset builder is already running.' };
  }
  if (crawlState.active) {
    return { success: false, error: 'Cannot start dataset builder while crawl mode is active.' };
  }
  if (!prompt || prompt.trim().length === 0) {
    return { success: false, error: 'Prompt cannot be empty.' };
  }

  // Load saved Brave API key if not in config
  if (!config.braveApiKey) {
    const stored = await chrome.storage.local.get('braveApiKey');
    config.braveApiKey = stored.braveApiKey || '';
  }

  datasetBuilderState.active = true;
  datasetBuilderState.phase = 'decomposing';
  datasetBuilderState.prompt = prompt.trim();
  datasetBuilderState.config = {
    targetSize: config.targetSize || 100,
    goldThreshold: config.goldThreshold ?? 0.85,
    silverThreshold: config.silverThreshold ?? 0.65,
    maxSourcesPerQuery: config.maxSourcesPerQuery || 10,
    maxCrawlDepth: config.maxCrawlDepth || 2,
    outputFormat: config.outputFormat || 'jsonl',
    qualityTier: config.qualityTier || 'both',
    braveApiKey: config.braveApiKey || '',
  };
  datasetBuilderState.queries = [];
  datasetBuilderState.currentQuery = '';
  datasetBuilderState.searchResults = [];
  datasetBuilderState.urls = [];
  datasetBuilderState.visited.clear();
  datasetBuilderState.capturedPages = [];
  datasetBuilderState.entries = [];
  datasetBuilderState.stats = {
    queriesGenerated: 0, urlsFound: 0, urlsCrawled: 0,
    entriesScored: 0, goldCount: 0, silverCount: 0, discardCount: 0,
  };
  datasetBuilderState.tabId = null;
  datasetBuilderState._searchResolver = null;
  datasetBuilderState._startedAt = Date.now();

  if (!isActive) {
    isActive = true;
    await chrome.storage.local.set({ isActive: true });
    updateBadge();
  }

  broadcastDatasetStatus();

  datasetBuilderPipeline().catch(err => {
    console.error('[DatasetBuilder] Pipeline error:', err);
    datasetBuilderState.phase = 'error';
    datasetBuilderState.active = false;
    broadcastDatasetStatus();
  });

  return { success: true, phase: 'decomposing' };
}

function stopDatasetBuilder() {
  datasetBuilderState.active = false;
  datasetBuilderState.phase = 'idle';
  if (datasetBuilderState.tabId) {
    chrome.tabs.remove(datasetBuilderState.tabId).catch(() => {});
    datasetBuilderState.tabId = null;
  }
  if (datasetBuilderState._searchResolver) {
    datasetBuilderState._searchResolver([]);
    datasetBuilderState._searchResolver = null;
  }
  broadcastDatasetStatus();
}

async function datasetBuilderPipeline() {
  try {
    // Phase 1: Decompose prompt into search queries
    await dsDecomposePrompt();
    if (!datasetBuilderState.active) return;

    // Phase 2: Search Brave for URLs
    await dsSearchAllQueries();
    if (!datasetBuilderState.active) return;

    // Phase 3: Crawl and extract content from URLs
    await dsCrawlSources();
    if (!datasetBuilderState.active) return;

    // Phase 4: Score entries for quality
    await dsScoreEntries();
    if (!datasetBuilderState.active) return;

    // Phase 5: Classify and export
    dsClassifyEntries();
    await dsExportDataset();

    datasetBuilderState.phase = 'done';
    datasetBuilderState.active = false;
    broadcastDatasetStatus();
    console.log('[DatasetBuilder] Pipeline complete.', datasetBuilderState.stats);
  } catch (err) {
    console.error('[DatasetBuilder] Pipeline error:', err);
    datasetBuilderState.phase = 'error';
    datasetBuilderState.active = false;
    broadcastDatasetStatus();
  }
}

async function dsDecomposePrompt() {
  datasetBuilderState.phase = 'decomposing';
  broadcastDatasetStatus();

  const systemPrompt = `You are a dataset creation expert. Given a user's request to create a dataset, decompose it into 5-8 specific search queries that would find relevant high-quality content on the web.

Rules:
- Each query should target a specific subtopic or angle
- Queries should be 3-7 words, optimized for search engines
- Include a mix of: tutorials, documentation, examples, best practices
- Output ONLY a JSON array of strings: ["query1", "query2", ...]`;

  const userPrompt = `Create search queries for this dataset request:\n\n"${datasetBuilderState.prompt}"\n\nReturn 5-8 focused search queries as a JSON array.`;

  const response = await callAIAPI(systemPrompt, userPrompt);

  // Parse JSON from response (handle potential markdown wrapping)
  let queries;
  try {
    const jsonMatch = response.match(/\[[\s\S]*?\]/);
    queries = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(response);
  } catch (e) {
    throw new Error('Failed to parse search queries from LLM response');
  }

  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error('LLM returned no search queries');
  }

  datasetBuilderState.queries = queries.slice(0, 8);
  datasetBuilderState.stats.queriesGenerated = datasetBuilderState.queries.length;
  console.log('[DatasetBuilder] Generated queries:', datasetBuilderState.queries);
  broadcastDatasetStatus();
}

async function dsSearchAllQueries() {
  datasetBuilderState.phase = 'searching';
  broadcastDatasetStatus();

  const apiKey = datasetBuilderState.config.braveApiKey;
  const allUrls = new Map(); // url → { url, title, snippet }

  // Create background tab for browser-mode search
  if (!apiKey) {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    datasetBuilderState.tabId = tab.id;
  }

  for (const query of datasetBuilderState.queries) {
    if (!datasetBuilderState.active) break;

    datasetBuilderState.currentQuery = query;
    broadcastDatasetStatus();

    try {
      let results;
      if (apiKey) {
        results = await dsSearchBraveAPI(query, apiKey);
      } else {
        results = await dsSearchBraveBrowser(query);
      }

      for (const r of results) {
        if (!allUrls.has(r.url)) {
          allUrls.set(r.url, r);
        }
      }

      // Politeness delay between queries (shorter for API mode)
      await sleep(apiKey ? 200 : 2000);
    } catch (err) {
      console.warn(`[DatasetBuilder] Search failed for "${query}":`, err.message);
    }
  }

  datasetBuilderState.urls = Array.from(allUrls.values());
  datasetBuilderState.stats.urlsFound = datasetBuilderState.urls.length;
  datasetBuilderState.currentQuery = '';
  console.log('[DatasetBuilder] Found', datasetBuilderState.urls.length, 'unique URLs');
  broadcastDatasetStatus();
}

async function dsSearchBraveAPI(query, apiKey) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20`;
  const resp = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!resp.ok) {
    throw new Error(`Brave API returned ${resp.status}`);
  }

  const data = await resp.json();
  return (data.web?.results || []).map(r => ({
    url: r.url,
    title: r.title || '',
    snippet: r.description || '',
  }));
}

async function dsSearchBraveBrowser(query) {
  const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;

  if (!datasetBuilderState.tabId) {
    const tab = await chrome.tabs.create({ url: searchUrl, active: false });
    datasetBuilderState.tabId = tab.id;
  } else {
    await chrome.tabs.update(datasetBuilderState.tabId, { url: searchUrl });
  }

  await waitForTabLoad(datasetBuilderState.tabId);

  // Wait for content script to send DATASET_SEARCH_RESULTS
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      datasetBuilderState._searchResolver = null;
      console.warn('[DatasetBuilder] Search extraction timed out for:', query);
      resolve([]);
    }, 8000);

    datasetBuilderState._searchResolver = (results) => {
      clearTimeout(timeout);
      resolve(results);
    };
  });
}

async function dsCrawlSources() {
  datasetBuilderState.phase = 'crawling';
  broadcastDatasetStatus();

  // Reuse existing tab or create one
  if (!datasetBuilderState.tabId) {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    datasetBuilderState.tabId = tab.id;
  }

  const maxToCrawl = Math.min(
    datasetBuilderState.urls.length,
    datasetBuilderState.config.targetSize * 2 // Crawl 2x target for quality filtering headroom
  );

  for (let i = 0; i < maxToCrawl; i++) {
    if (!datasetBuilderState.active) break;

    const source = datasetBuilderState.urls[i];
    const normalized = normalizeUrl(source.url);

    if (datasetBuilderState.visited.has(normalized)) continue;
    datasetBuilderState.visited.add(normalized);

    try {
      await chrome.tabs.update(datasetBuilderState.tabId, { url: source.url });
      await waitForTabLoad(datasetBuilderState.tabId);

      // Wait for content script to extract and send PAGE_CAPTURED
      await sleep(4000);

      datasetBuilderState.stats.urlsCrawled++;
      broadcastDatasetStatus();
    } catch (err) {
      console.warn(`[DatasetBuilder] Failed to crawl ${source.url}:`, err.message);
    }

    // Politeness delay
    await sleep(datasetBuilderState.config.maxCrawlDepth > 0 ? 2000 : 1000);
  }

  // Collect pages captured during this session from IndexedDB
  const allCaptures = await getAllCaptures();
  datasetBuilderState.capturedPages = allCaptures.filter(
    c => c.timestamp >= datasetBuilderState._startedAt
  );
  console.log('[DatasetBuilder] Captured', datasetBuilderState.capturedPages.length, 'pages');
}

async function dsScoreEntries() {
  datasetBuilderState.phase = 'scoring';
  broadcastDatasetStatus();

  for (const page of datasetBuilderState.capturedPages) {
    if (!datasetBuilderState.active) break;

    try {
      const score = await dsScoreEntry(page);
      datasetBuilderState.entries.push({
        url: page.url || page.metadata?.url || '',
        title: page.title || page.metadata?.title || '',
        domain: page.domain || page.metadata?.domain || '',
        content: stripFrontmatter(page.content || ''),
        contentType: page.contentType || page.metadata?.contentType || 'general',
        wordCount: page.metadata?.wordCount || 0,
        timestamp: page.timestamp || Date.now(),
        quality_score: score,
      });
      datasetBuilderState.stats.entriesScored++;
      broadcastDatasetStatus();
    } catch (err) {
      console.warn('[DatasetBuilder] Score failed for:', page.url, err.message);
    }

    // Rate limit LLM calls
    await sleep(500);
  }
}

async function dsScoreEntry(page) {
  const content = stripFrontmatter(page.content || '').substring(0, 3000);
  if (content.length < 100) return 0.2; // Too short = low quality

  const systemPrompt = `You are a training data quality evaluator. Score content quality for AI training on a scale of 0.0 to 1.0.

Consider: clarity, technical accuracy, practical usefulness, structure, noise level, relevance to "${datasetBuilderState.prompt}"

Output ONLY valid JSON: {"score": 0.85, "reason": "brief reason"}`;

  const userPrompt = `Rate this content:\n\nTitle: ${page.title || 'Unknown'}\nURL: ${page.url || 'Unknown'}\n\n${content}`;

  try {
    const response = await callAIAPI(systemPrompt, userPrompt);
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(response);
    return Math.min(1.0, Math.max(0.0, result.score ?? 0.5));
  } catch (err) {
    console.warn('[DatasetBuilder] Score parse error, defaulting to 0.5:', err.message);
    return 0.5;
  }
}

function dsClassifyEntries() {
  const { goldThreshold, silverThreshold, qualityTier } = datasetBuilderState.config;
  let gold = 0, silver = 0, discard = 0;

  for (const entry of datasetBuilderState.entries) {
    if (entry.quality_score >= goldThreshold) {
      entry.quality_tier = 'gold';
      gold++;
    } else if (entry.quality_score >= silverThreshold) {
      entry.quality_tier = 'silver';
      silver++;
    } else {
      entry.quality_tier = 'discard';
      discard++;
    }
  }

  datasetBuilderState.stats.goldCount = gold;
  datasetBuilderState.stats.silverCount = silver;
  datasetBuilderState.stats.discardCount = discard;

  // Filter to requested tier
  if (qualityTier === 'gold') {
    datasetBuilderState.entries = datasetBuilderState.entries.filter(e => e.quality_tier === 'gold');
  } else if (qualityTier === 'silver') {
    datasetBuilderState.entries = datasetBuilderState.entries.filter(e => e.quality_tier === 'silver');
  } else {
    // 'both' — keep gold + silver, remove discards
    datasetBuilderState.entries = datasetBuilderState.entries.filter(e => e.quality_tier !== 'discard');
  }

  broadcastDatasetStatus();
}

async function dsExportDataset() {
  datasetBuilderState.phase = 'exporting';
  broadcastDatasetStatus();

  const entries = datasetBuilderState.entries;
  if (entries.length === 0) {
    console.warn('[DatasetBuilder] No entries to export');
    return;
  }

  // Build manifest
  const manifest = {
    prompt: datasetBuilderState.prompt,
    created_at: new Date().toISOString(),
    config: datasetBuilderState.config,
    stats: { ...datasetBuilderState.stats },
    quality_report: {
      total_entries: entries.length,
      avg_score: entries.reduce((s, e) => s + e.quality_score, 0) / entries.length,
    },
  };

  // Build JSONL content
  let jsonl = '';
  for (const entry of entries) {
    jsonl += JSON.stringify({
      source_url: entry.url,
      title: entry.title,
      domain: entry.domain,
      quality_score: entry.quality_score,
      quality_tier: entry.quality_tier,
      content_type: entry.contentType,
      word_count: entry.wordCount,
      content: entry.content,
      metadata: {
        captured_at: new Date(entry.timestamp).toISOString(),
        prompt: datasetBuilderState.prompt,
      },
    }) + '\n';
  }

  // Build manifest JSON
  const manifestJson = JSON.stringify(manifest, null, 2);

  // Create ZIP with both files
  const zip = new JSZip();
  const dateStr = new Date().toISOString().split('T')[0];
  const folderName = `dataset-${dateStr}`;
  zip.file(`${folderName}/dataset.jsonl`, jsonl);
  zip.file(`${folderName}/manifest.json`, manifestJson);
  zip.file(`${folderName}/quality-report.md`, dsGenerateQualityReport(manifest, entries));

  const blob = await zip.generateAsync({ type: 'base64' });
  const dataUrl = 'data:application/zip;base64,' + blob;

  await chrome.downloads.download({
    url: dataUrl,
    filename: `${folderName}.zip`,
    saveAs: true,
  });

  console.log('[DatasetBuilder] Export complete:', entries.length, 'entries');
}

function dsGenerateQualityReport(manifest, entries) {
  const gold = entries.filter(e => e.quality_tier === 'gold');
  const silver = entries.filter(e => e.quality_tier === 'silver');

  return `# Dataset Quality Report

**Prompt:** ${manifest.prompt}
**Created:** ${manifest.created_at}
**Total Entries:** ${entries.length}

## Quality Distribution

| Tier | Count | Avg Score |
|------|-------|-----------|
| Gold | ${gold.length} | ${gold.length ? (gold.reduce((s, e) => s + e.quality_score, 0) / gold.length).toFixed(2) : 'N/A'} |
| Silver | ${silver.length} | ${silver.length ? (silver.reduce((s, e) => s + e.quality_score, 0) / silver.length).toFixed(2) : 'N/A'} |
| Discarded | ${manifest.stats.discardCount} | — |

## Configuration

- Gold threshold: ${manifest.config.goldThreshold}
- Silver threshold: ${manifest.config.silverThreshold}
- Target size: ${manifest.config.targetSize}
- Quality tier: ${manifest.config.qualityTier}
- Search queries generated: ${manifest.stats.queriesGenerated}
- URLs found: ${manifest.stats.urlsFound}
- URLs crawled: ${manifest.stats.urlsCrawled}

## Sources

${entries.map(e => `- [${e.title}](${e.url}) — ${e.quality_tier} (${e.quality_score.toFixed(2)})`).join('\n')}
`;
}

async function updateCaptureStats(pageData) {
  const state = await chrome.storage.local.get(['captureCount', 'totalWords', 'recentCaptures']);
  const count = (state.captureCount || 0) + 1;
  const words = (state.totalWords || 0) + (pageData.metadata.wordCount || 0);
  const recent = state.recentCaptures || [];

  recent.unshift({
    title: pageData.title,
    domain: pageData.domain,
    url: pageData.url,
    timestamp: Date.now(),
    wordCount: pageData.metadata.wordCount,
  });

  if (recent.length > 50) recent.length = 50;

  await chrome.storage.local.set({
    captureCount: count,
    totalWords: words,
    recentCaptures: recent,
  });
}

function updateBadge() {
  if (isActive) {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#BDD164' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.searchParams.delete('utm_source');
    u.searchParams.delete('utm_medium');
    u.searchParams.delete('utm_campaign');
    u.searchParams.delete('ref');
    return u.toString();
  } catch (e) {
    return url;
  }
}


// Common multi-part TLDs that should NOT be stripped
const MULTI_PART_TLDS = new Set([
  'co.uk', 'co.jp', 'co.kr', 'co.in', 'co.nz', 'co.za',
  'com.au', 'com.br', 'com.cn', 'com.mx', 'com.sg', 'com.tw',
  'org.uk', 'net.au', 'ac.uk', 'gov.uk', 'edu.au',
]);

function normalizeSubdomain(domain) {
  if (!domain) return 'unknown';
  domain = domain.replace(/^www\./, '');
  const parts = domain.split('.');
  if (parts.length <= 2) return domain;

  // Check for multi-part TLDs (e.g., co.uk, com.au)
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) {
    // Keep 3 parts: example.co.uk
    return parts.slice(-3).join('.');
  }

  // Otherwise keep last 2 parts: docs.github.com → github.com
  return parts.slice(-2).join('.');
}

function sanitizeDomainForPath(domain) {
  // Replace characters not allowed in folder names
  return (domain || 'unknown').replace(/[:\\/<>"|?*]+/g, '-');
}

function groupCapturesByDomain(captures) {
  const grouped = {};
  for (const capture of captures) {
    const rawDomain = capture.metadata?.domain || 'unknown';
    const domain = sanitizeDomainForPath(normalizeSubdomain(rawDomain));
    if (!grouped[domain]) grouped[domain] = [];
    grouped[domain].push(capture);
  }
  return Object.fromEntries(
    Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b))
  );
}


function generateCleanFilename(title) {
  const slug = (title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Truncate at word boundary (hyphen) if over 50 chars
  if (slug.length > 50) {
    const truncated = slug.substring(0, 51);
    const lastHyphen = truncated.lastIndexOf('-');
    if (lastHyphen > 20) {
      return truncated.substring(0, lastHyphen) + '.md';
    }
    return truncated.substring(0, 50) + '.md';
  }
  return slug + '.md';
}

// Legacy filename (still used as IndexedDB key)
function generateFilename(url, title, timestamp) {
  const date = new Date(timestamp).toISOString().split('T')[0];
  let domain;
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    domain = 'unknown';
  }
  const slug = (title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);

  return `${date}_${domain}_${slug}.md`;
}

// LLM-based smart naming — batched per domain at export time
async function generateSmartFilenames(captures) {
  if (!apiSettings.apiToken) return {};

  const byDomain = groupCapturesByDomain(captures);
  const filenameMap = {}; // old filename → new clean filename

  for (const [domain, domainCaptures] of Object.entries(byDomain)) {
    const titles = domainCaptures.map(c => c.metadata?.title || 'Untitled');

    // Batch prompt: ask LLM for clean filenames for all titles at once
    const systemPrompt = 'You generate short, descriptive kebab-case filenames from web page titles. Output ONLY a valid JSON array of strings, nothing else.';
    const userPrompt = `Generate a short, clean, descriptive kebab-case filename (max 50 chars, no extension) for each of these ${titles.length} page titles. The filenames should capture what the page is about.\n\nTitles:\n${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nReturn a JSON array of ${titles.length} filename strings, e.g. ["fix-bash-shebang", "react-hooks-guide"]`;

    try {
      const response = await callAIAPI(systemPrompt, userPrompt);
      // Extract JSON from response (handle possible markdown wrapping)
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const filenames = JSON.parse(jsonMatch[0]);
        domainCaptures.forEach((cap, i) => {
          if (filenames[i]) {
            let clean = filenames[i]
              .toLowerCase()
              .replace(/[^a-z0-9-]+/g, '-')
              .replace(/^-+|-+$/g, '');
            // Truncate at word boundary
            if (clean.length > 50) {
              const lastHyphen = clean.substring(0, 51).lastIndexOf('-');
              clean = lastHyphen > 20 ? clean.substring(0, lastHyphen) : clean.substring(0, 50);
            }
            filenameMap[cap.filename] = clean + '.md';
          }
        });
      }
    } catch (e) {
      console.warn(`[BrowsingCapture] Smart naming failed for ${domain}:`, e.message);
      // Fallback handled by caller
    }
  }

  return filenameMap;
}

function escapeYaml(str) {
  return (str || '').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let hfUploadProgress = {
  active: false,
  phase: '',       // 'preparing' | 'creating' | 'uploading' | 'done' | 'error'
  current: 0,
  total: 0,
  currentFile: '',
  result: null,
};

function broadcastHFProgress() {
  const msg = { type: 'HF_UPLOAD_PROGRESS', ...hfUploadProgress };
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) {}
}

async function validateHFToken(token) {
  const resp = await fetch('https://huggingface.co/api/whoami-v2', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { valid: false, error: resp.status === 401 ? 'Invalid token' : `HTTP ${resp.status}: ${text}` };
  }
  const data = await resp.json();
  return { valid: true, username: data.name || data.user };
}

async function fetchUserDatasets(token, username) {
  const resp = await fetch(`https://huggingface.co/api/datasets?author=${encodeURIComponent(username)}&limit=100`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Failed to fetch datasets: HTTP ${resp.status}`);
  const datasets = await resp.json();
  return datasets.map(d => ({ id: d.id, name: d.id.split('/').pop(), private: d.private }));
}

async function createDatasetRepo(token, repoId, isPrivate) {
  const resp = await fetch('https://huggingface.co/api/repos/create', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: repoId.includes('/') ? repoId.split('/').pop() : repoId,
      type: 'dataset',
      private: isPrivate,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Failed to create repo: HTTP ${resp.status} — ${text}`);
  }
  return await resp.json();
}

async function uploadFilesToDataset(token, repoId, files) {
  // HuggingFace commit API: upload files in one atomic commit
  // files = [ { path: 'train/file.jsonl', content: '...' } ]
  const operations = files.map(f => ({
    key: 'file',
    value: new Blob([f.content], { type: 'application/octet-stream' }),
    path: f.path,
  }));

  // Build multipart form data for the commit
  const formData = new FormData();

  // Each operation: { key: "file", path: "...", content: blob }
  // The HF API expects a specific format for the commit endpoint
  const headerPayload = {
    summary: `Upload training data from BrowsingCapture — ${new Date().toISOString().split('T')[0]}`,
    parentCommit: undefined,
  };

  // Use the lfs-based upload approach via the commit API
  const lfsOps = files.map(f => ({
    key: 'file',
    value: { content: f.content, path: f.path },
  }));

  // Build the operations payload
  const opsPayload = files.map(f => ({
    operation: 'addOrUpdate',
    path: f.path,
    content: f.content,
  }));

  // Use the simple create-commit API
  const boundary = '----HFBoundary' + Date.now();
  const parts = [];

  // Header part
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="header"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    JSON.stringify({ summary: headerPayload.summary }) + '\r\n'
  );

  // File parts
  for (const f of files) {
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${f.path}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n` +
      f.content + '\r\n'
    );
  }

  parts.push(`--${boundary}--\r\n`);

  const bodyStr = parts.join('');

  const resp = await fetch(`https://huggingface.co/api/datasets/${repoId}/commit/main`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: bodyStr,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Upload failed: HTTP ${resp.status} — ${text}`);
  }
  return await resp.json();
}


let voiceCommanderState = {
  active: false,
  tier: 'local',             // 'local' | 'openai_realtime'
  listening: false,
  processing: false,
  pinchtabConnected: false,
  bridgeToken: '',
  pinchtabPort: 9867,
  companionHealthPort: 9868,
  openaiRealtimeModel: 'gpt-4o-realtime-preview-2024-12-17',
  transcript: [],             // {role, text, timestamp, action?}[]
  conversationHistory: [],    // {role, content}[] for multi-turn context
  maxHistoryTurns: 10,
  micTabId: null,             // Tab ID where mic capture is injected
};


async function ensureBridgeToken() {
  if (voiceCommanderState.bridgeToken) return;
  // Try loading from storage first
  try {
    const stored = await chrome.storage.local.get(['vcBridgeToken']);
    if (stored.vcBridgeToken) {
      voiceCommanderState.bridgeToken = stored.vcBridgeToken;
      return;
    }
  } catch (e) {}
  // Fall back to fetching from companion health endpoint
  try {
    const resp = await fetch(`http://localhost:${voiceCommanderState.companionHealthPort}/health`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.bridgeToken) {
        voiceCommanderState.bridgeToken = data.bridgeToken;
        await chrome.storage.local.set({ vcBridgeToken: data.bridgeToken });
      }
    }
  } catch (e) {}
}

async function ptFetch(path, options = {}) {
  await ensureBridgeToken();
  const port = voiceCommanderState.pinchtabPort;
  const token = voiceCommanderState.bridgeToken;
  const url = `http://localhost:${port}${path}`;

  const headers = { ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const resp = await fetch(url, { ...options, headers });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`PinchTab ${path}: HTTP ${resp.status} — ${text}`);
  }
  return resp;
}

async function ptNavigate(targetUrl) {
  const resp = await ptFetch('/navigate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: targetUrl }),
  });
  return resp.json();
}

async function ptSnapshot() {
  // filter=interactive: only buttons/links/inputs (~75% fewer nodes)
  // format=compact: ~60% token reduction
  const resp = await ptFetch('/snapshot?filter=interactive&format=compact');
  return resp.json();
}

async function ptAction(kind, ref, extra) {
  const body = { kind };
  if (ref) body.ref = ref;

  // PinchTab uses different keys per action kind
  if (extra !== undefined) {
    switch (kind) {
      case 'fill':
      case 'type':
      case 'humanType':
        body.text = extra;
        break;
      case 'scroll':
        body.direction = extra;
        break;
      case 'press':
        body.key = extra;
        break;
      case 'select':
        body.value = extra;
        break;
      default:
        body.value = extra;
    }
  }

  const resp = await ptFetch('/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function ptEvaluate(expression) {
  const resp = await ptFetch('/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expression }),
  });
  return resp.json();
}

async function ptText() {
  const resp = await ptFetch('/text');
  return resp.json();
}

async function ptHealthCheck() {
  try {
    const resp = await fetch(`http://localhost:${voiceCommanderState.companionHealthPort}/health`);
    if (!resp.ok) return null;
    return resp.json();
  } catch (e) {
    return null;
  }
}


const VC_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'navigate_to',
      description: 'Navigate the browser to a URL. Use this when the user wants to go to a website.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to navigate to (include https://)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click_element',
      description: 'Click on an interactive element identified by its ref ID from a page snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Reference ID of the element to click (e.g. "ref_12")' },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: 'Type text into an input field or textarea identified by its ref ID.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Reference ID of the input element' },
          text: { type: 'string', description: 'Text to type into the element' },
        },
        required: ['ref', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_page',
      description: 'Get the text content of the current page. Use when you need to understand what is on the page.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_snapshot',
      description: 'Get a snapshot of all interactive elements on the current page with their ref IDs. Use before clicking or typing.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll_page',
      description: 'Scroll the page up or down.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'go_back',
      description: 'Go back to the previous page in browser history.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search the web using a query. Opens a search engine with the query.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
  },
];


async function executeVCTool(name, args) {
  const result = { tool: name, success: false, output: '' };

  try {
    switch (name) {
      case 'navigate_to': {
        let url = args.url || '';
        if (!url.startsWith('http')) url = 'https://' + url;
        await ptNavigate(url);
        result.success = true;
        result.output = `Navigated to ${url}`;
        break;
      }
      case 'click_element': {
        await ptAction('click', args.ref);
        result.success = true;
        result.output = `Clicked element ${args.ref}`;
        break;
      }
      case 'type_text': {
        await ptAction('fill', args.ref, args.text);
        result.success = true;
        result.output = `Typed "${args.text}" into ${args.ref}`;
        break;
      }
      case 'read_page': {
        const pageText = await ptText();
        result.success = true;
        result.output = typeof pageText === 'string'
          ? pageText.substring(0, 3000)
          : JSON.stringify(pageText).substring(0, 3000);
        break;
      }
      case 'get_snapshot': {
        const snapshot = await ptSnapshot();
        result.success = true;
        result.output = typeof snapshot === 'string'
          ? snapshot.substring(0, 3000)
          : JSON.stringify(snapshot).substring(0, 3000);
        break;
      }
      case 'scroll_page': {
        await ptAction('scroll', '', args.direction);
        result.success = true;
        result.output = `Scrolled ${args.direction}`;
        break;
      }
      case 'go_back': {
        await ptEvaluate('window.history.back()');
        result.success = true;
        result.output = 'Went back';
        break;
      }
      case 'search_web': {
        const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent(args.query)}`;
        await ptNavigate(searchUrl);
        // Wait for results to load, then read them back
        try {
          const searchText = await ptText();
          const textStr = typeof searchText === 'string' ? searchText : JSON.stringify(searchText);
          result.output = `Search results for "${args.query}":\n${textStr.substring(0, 3000)}`;
        } catch (e) {
          result.output = `Searched for: ${args.query} (results page loaded)`;
        }
        result.success = true;
        break;
      }
      default:
        result.output = `Unknown tool: ${name}`;
    }
  } catch (err) {
    result.output = `Error: ${err.message}`;
  }

  return result;
}


function getVCSystemPrompt(pageContext) {
  return `You are a voice-controlled browser assistant. The user speaks commands and you execute them using browser tools.

IMPORTANT RULES:
1. Be concise in your spoken responses — the user is listening to you speak.
2. When the user asks to go somewhere, use navigate_to.
3. Before clicking or typing, use get_snapshot to see what's on the page.
4. When performing multi-step tasks, explain each step briefly.
5. If something fails, explain and try an alternative approach.
6. Keep responses under 2 sentences when possible.

${pageContext ? `CURRENT PAGE CONTEXT:\n${pageContext}\n` : ''}

You have these browser control tools available. Use them to fulfill the user's requests.`;
}


async function processAudioLocal(audioBase64) {
  voiceCommanderState.processing = true;
  broadcastVCStatus();

  try {
    const audioBlob = base64ToBlob(audioBase64, 'audio/wav');
    console.log('[VoiceCommander] Sending WAV to Vosk STT: base64 len =', audioBase64.length,
      ', blob size =', audioBlob.size, 'bytes');

    // Send raw WAV binary — companion reads r.Body directly
    const sttResp = await fetch(`http://127.0.0.1:${voiceCommanderState.companionHealthPort}/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: audioBlob,
    });

    if (!sttResp.ok) {
      const errBody = await sttResp.text().catch(() => '');
      console.error('[VoiceCommander] STT response:', sttResp.status, errBody);
      throw new Error(`Local STT failed: ${sttResp.status} ${errBody}`);
    }

    const sttResult = await sttResp.json();
    const userText = (sttResult.text || '').trim();
    console.log('[VoiceCommander] STT result:', JSON.stringify(sttResult).substring(0, 300));
    console.log('[VoiceCommander] Transcribed text:', userText);

    if (!userText) {
      console.log('[VoiceCommander] Empty transcription, skipping');
      voiceCommanderState.processing = false;
      broadcastVCStatus();
      return;
    }

    addTranscriptEntry('user', userText);

    // Step 2: Get page context
    let pageContext = '';
    try {
      const snapshot = await ptSnapshot();
      pageContext = typeof snapshot === 'string'
        ? snapshot.substring(0, 1500)
        : JSON.stringify(snapshot).substring(0, 1500);
      console.log('[VoiceCommander] Page context length:', pageContext.length);
    } catch (e) {
      console.warn('[VoiceCommander] Failed to get page context:', e.message);
    }

    // Step 3: LLM via Ollama (OpenAI-compatible format)
    const systemPrompt = getVCSystemPrompt(pageContext) +
      '\n\nIMPORTANT: When you want to use a tool, respond ONLY with the JSON object: {"tool": "tool_name", "args": {...}}. ' +
      'Do NOT wrap it in code blocks or add any text before or after the JSON. ' +
      'When you want to speak to the user (no tool needed), respond with plain text only.';

    const messages = [
      { role: 'system', content: systemPrompt },
      ...voiceCommanderState.conversationHistory.slice(-voiceCommanderState.maxHistoryTurns * 2),
      { role: 'user', content: userText },
    ];

    let assistantReply = '';
    let maxToolRounds = 5;

    for (let round = 0; round < maxToolRounds; round++) {
      console.log(`[VoiceCommander] LLM round ${round + 1}/${maxToolRounds}`);

      let chatResp;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000); // 2 min timeout
        chatResp = await fetch('http://localhost:11434/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: localModelName || 'qwen3.5:4b',
            messages,
            max_tokens: 150,
            temperature: 0.2,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
      } catch (fetchErr) {
        const msg = fetchErr.name === 'AbortError'
          ? 'Ollama took too long (>2 min). Check companion terminal for GPU issues.'
          : 'Ollama not reachable on port 11434 — is it running? Check companion terminal.';
        console.error('[VoiceCommander] LLM fetch error:', fetchErr.message);
        throw new Error(msg);
      }

      if (!chatResp.ok) {
        const errBody = await chatResp.text().catch(() => '');
        console.error('[VoiceCommander] LLM error:', chatResp.status, errBody);
        throw new Error(`Local LLM failed: ${chatResp.status}`);
      }

      const chatResult = await chatResp.json();
      const content = chatResult.choices?.[0]?.message?.content || '';
      console.log('[VoiceCommander] LLM response:', content.substring(0, 300));

      // Try to extract a tool call JSON from the response
      const toolCall = extractToolCallJSON(content);
      if (toolCall) {
        console.log('[VoiceCommander] Tool call:', toolCall.tool, JSON.stringify(toolCall.args));
        const toolResult = await executeVCTool(toolCall.tool, toolCall.args || {});
        console.log('[VoiceCommander] Tool result:', toolResult.output);
        addTranscriptEntry('action', toolResult.output, toolCall.tool);
        messages.push(
          { role: 'assistant', content },
          { role: 'user', content: `Tool result: ${JSON.stringify(toolResult)}. Continue or respond to the user.` }
        );
        continue;
      }

      assistantReply = content;
      break;
    }

    if (assistantReply) {
      console.log('[VoiceCommander] Final reply:', assistantReply.substring(0, 200));
      addTranscriptEntry('assistant', assistantReply);
      voiceCommanderState.conversationHistory.push(
        { role: 'user', content: userText },
        { role: 'assistant', content: assistantReply }
      );
      if (voiceCommanderState.conversationHistory.length > voiceCommanderState.maxHistoryTurns * 2) {
        voiceCommanderState.conversationHistory = voiceCommanderState.conversationHistory.slice(-voiceCommanderState.maxHistoryTurns * 2);
      }
    }

  } catch (err) {
    console.error('[VoiceCommander] Pipeline error:', err);
    addTranscriptEntry('action', `Error: ${err.message}`, 'error');
  } finally {
    voiceCommanderState.processing = false;
    broadcastVCStatus();
  }
}

// Extract a {"tool": "...", "args": {...}} object from LLM output,
// even if it's wrapped in markdown code blocks or surrounded by text.
function extractToolCallJSON(text) {
  // 1. Try direct parse
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && parsed.tool) return parsed;
  } catch (e) {}

  // 2. Try extracting from markdown code blocks: ```json ... ``` or ``` ... ```
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && parsed.tool) return parsed;
    } catch (e) {}
  }

  // 3. Try finding a JSON object with "tool" key anywhere in the text
  const jsonMatch = text.match(/\{[^{}]*"tool"\s*:\s*"[^"]+?"[^{}]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed && parsed.tool) return parsed;
    } catch (e) {}
  }

  // 4. Try finding nested JSON (args might contain objects)
  const braceStart = text.indexOf('{');
  if (braceStart !== -1) {
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) {
      try {
        const parsed = JSON.parse(text.substring(braceStart, end + 1));
        if (parsed && parsed.tool) return parsed;
      } catch (e) {}
    }
  }

  return null;
}


async function getRealtimeEphemeralToken() {
  // Use the Third Party OpenAI API key
  const settings = await chrome.storage.local.get(['tpApiToken', 'apiToken']);
  const apiKey = settings.tpApiToken || settings.apiToken;
  if (!apiKey) {
    throw new Error('OpenAI API key not configured. Set it in the Third Party tab.');
  }

  const resp = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: voiceCommanderState.openaiRealtimeModel,
      voice: 'alloy',
      instructions: getVCSystemPrompt(''),
      tools: VC_TOOLS.map(t => ({
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
      input_audio_transcription: { model: 'whisper-1' },
      turn_detection: { type: 'server_vad' },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`OpenAI Realtime session failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  return data; // Contains client_secret.value for ephemeral token
}
function broadcastVCStatus() {
  const msg = {
    type: 'VC_STATUS',
    active: voiceCommanderState.active,
    tier: voiceCommanderState.tier,
    listening: voiceCommanderState.listening,
    processing: voiceCommanderState.processing,
    pinchtabConnected: voiceCommanderState.pinchtabConnected,
    transcript: voiceCommanderState.transcript.slice(-20),
  };
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) {}
}

function broadcastVCMessage(type, data) {
  try { chrome.runtime.sendMessage({ type, ...data }).catch(() => {}); } catch (e) {}
}

function addTranscriptEntry(role, text, action) {
  const entry = {
    role,
    text,
    timestamp: Date.now(),
  };
  if (action) entry.action = action;
  voiceCommanderState.transcript.push(entry);

  // Keep last 50 entries
  if (voiceCommanderState.transcript.length > 50) {
    voiceCommanderState.transcript = voiceCommanderState.transcript.slice(-50);
  }

  broadcastVCMessage('VC_TRANSCRIPT', { entry });
  broadcastVCStatus();
}


function base64ToBlob(base64, mimeType) {
  const byteChars = atob(base64);
  const byteArray = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteArray[i] = byteChars.charCodeAt(i);
  }
  return new Blob([byteArray], { type: mimeType });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}




async function pushToHuggingFace(token, username, repoId, isNew, isPrivate) {
  if (hfUploadProgress.active) return;

  hfUploadProgress = { active: true, phase: 'preparing', current: 0, total: 0, currentFile: '', result: null };
  broadcastHFProgress();

  try {
    // Step 1: Get all captures from IndexedDB
    const captures = await getAllCaptures();
    if (captures.length === 0) {
      throw new Error('No captured pages to upload. Start browsing first!');
    }

    // Step 2: Build JSONL files grouped by domain
    hfUploadProgress.phase = 'preparing';
    hfUploadProgress.total = captures.length;
    broadcastHFProgress();

    const domainGroups = {};
    for (const cap of captures) {
      const domain = (cap.metadata?.domain || 'unknown').replace(/[^a-zA-Z0-9.-]/g, '_');
      if (!domainGroups[domain]) domainGroups[domain] = [];
      domainGroups[domain].push(cap);
    }

    const filesToUpload = [];
    let processed = 0;

    for (const [domain, domainCaptures] of Object.entries(domainGroups)) {
      const jsonlLines = [];
      for (const cap of domainCaptures) {
        processed++;
        hfUploadProgress.current = processed;
        hfUploadProgress.currentFile = cap.metadata?.title || cap.filename;
        broadcastHFProgress();

        const entry = buildJsonlEntry(cap);
        jsonlLines.push(JSON.stringify(entry));
      }
      const jsonlContent = jsonlLines.join('\n') + '\n';
      filesToUpload.push({
        path: `training-data/${domain}.jsonl`,
        content: jsonlContent,
      });
    }

    // Step 3: Create repo if new
    const fullRepoId = repoId.includes('/') ? repoId : `${username}/${repoId}`;
    if (isNew) {
      hfUploadProgress.phase = 'creating';
      hfUploadProgress.currentFile = fullRepoId;
      broadcastHFProgress();
      await createDatasetRepo(token, fullRepoId, isPrivate);
      // Small delay for repo to propagate
      await sleep(1500);
    }

    // Step 4: Upload all files
    hfUploadProgress.phase = 'uploading';
    hfUploadProgress.current = 0;
    hfUploadProgress.total = filesToUpload.length;
    broadcastHFProgress();

    await uploadFilesToDataset(token, fullRepoId, filesToUpload);

    // Step 5: Done!
    const datasetUrl = `https://huggingface.co/datasets/${fullRepoId}`;
    const autotrainUrl = `https://huggingface.co/autotrain?dataset=${encodeURIComponent(fullRepoId)}`;

    hfUploadProgress = {
      active: false,
      phase: 'done',
      current: filesToUpload.length,
      total: filesToUpload.length,
      currentFile: '',
      result: {
        success: true,
        repoId: fullRepoId,
        datasetUrl,
        autotrainUrl,
        fileCount: filesToUpload.length,
        captureCount: captures.length,
      },
    };
    broadcastHFProgress();

  } catch (err) {
    console.error('[BrowsingCapture] HF upload failed:', err);
    hfUploadProgress = {
      active: false,
      phase: 'error',
      current: 0,
      total: 0,
      currentFile: '',
      result: { success: false, error: err.message },
    };
    broadcastHFProgress();
  }
}


// ── Fine-tuning via companion → HuggingFace AutoTrain ──

async function handleFinetuneStart(msg) {
  const { hfToken, datasetRepoId, baseModel } = msg;
  if (!hfToken || !datasetRepoId) {
    throw new Error('Missing HuggingFace token or dataset repo ID');
  }

  const resp = await fetch(`http://localhost:${voiceCommanderState.companionHealthPort}/finetune/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hfToken,
      datasetRepoId,
      baseModel: baseModel || localModelName || 'qwen3.5:4b',
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Fine-tune start failed: ${resp.status} ${text}`);
  }

  return resp.json();
}

async function handleFinetuneStatus() {
  try {
    const resp = await fetch(`http://localhost:${voiceCommanderState.companionHealthPort}/finetune/status`);
    if (!resp.ok) {
      return { status: 'error', error: `HTTP ${resp.status}` };
    }
    return resp.json();
  } catch (e) {
    return { status: 'unavailable', error: 'Companion not connected' };
  }
}
