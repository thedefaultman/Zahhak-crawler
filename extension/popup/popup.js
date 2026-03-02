const activateToggle = document.getElementById('activate-toggle');
const captureStatus = document.getElementById('capture-status');
const captureCount = document.getElementById('capture-count');
const sessionTime = document.getElementById('session-time');
const totalWords = document.getElementById('total-words');
const providerSelect = document.getElementById('provider-select');
const apiToken = document.getElementById('api-token');
const toggleTokenBtn = document.getElementById('toggle-token-visibility');
const customEndpointField = document.getElementById('custom-endpoint-field');
const customEndpoint = document.getElementById('custom-endpoint');
const modelField = document.getElementById('model-field');
const modelSelect = document.getElementById('model-select');
const saveApiBtn = document.getElementById('save-api');
const aiToggle = document.getElementById('ai-toggle');
const exportZipBtn = document.getElementById('export-zip');
const exportFolderBtn = document.getElementById('export-folder');
const exportFolderInput = document.getElementById('export-folder-name');
const aiQuestionsCheckbox = document.getElementById('ai-questions');
const sanitizeSelect = document.getElementById('sanitize-select');
const recentList = document.getElementById('recent-list');
const toast = document.getElementById('toast');

const crawlHeader = document.getElementById('crawl-header');
const crawlBody = document.getElementById('crawl-body');
const crawlUrlInput = document.getElementById('crawl-url');
const crawlUseCurrentBtn = document.getElementById('crawl-use-current');
const crawlMaxPages = document.getElementById('crawl-max-pages');
const crawlMaxDepth = document.getElementById('crawl-max-depth');
const crawlDelay = document.getElementById('crawl-delay');
const crawlStartBtn = document.getElementById('crawl-start');
const crawlStopBtn = document.getElementById('crawl-stop');
const crawlStatusDiv = document.getElementById('crawl-status');
const crawlDomain = document.getElementById('crawl-domain');
const crawlPagesCount = document.getElementById('crawl-pages-count');
const crawlQueueCount = document.getElementById('crawl-queue-count');

const enhanceStatusDiv = document.getElementById('enhance-status');
const enhanceStatusText = document.getElementById('enhance-status-text');

const hfHeader = document.getElementById('hf-header');
const hfBody = document.getElementById('hf-body');
const hfTokenInput = document.getElementById('hf-token');
const hfToggleTokenBtn = document.getElementById('toggle-hf-token');
const hfSaveTokenBtn = document.getElementById('hf-save-token');
const hfTokenStatus = document.getElementById('hf-token-status');
const hfDatasetSection = document.getElementById('hf-dataset-section');
const hfModeNew = document.getElementById('hf-mode-new');
const hfModeExisting = document.getElementById('hf-mode-existing');
const hfNewFields = document.getElementById('hf-new-fields');
const hfExistingFields = document.getElementById('hf-existing-fields');
const hfNewName = document.getElementById('hf-new-name');
const hfExistingSelect = document.getElementById('hf-existing-select');
const hfPrivateCheckbox = document.getElementById('hf-private');
const hfPushBtn = document.getElementById('hf-push');
const hfProgressDiv = document.getElementById('hf-progress');
const hfProgressText = document.getElementById('hf-progress-text');
const hfProgressDetail = document.getElementById('hf-progress-detail');
const hfProgressBar = document.getElementById('hf-progress-bar');
const hfLinksDiv = document.getElementById('hf-links');
const hfLinkDataset = document.getElementById('hf-link-dataset');
const hfLinkAutotrain = document.getElementById('hf-link-autotrain');

const dsHeader = document.getElementById('ds-header');
const dsBody = document.getElementById('ds-body');
const dsPrompt = document.getElementById('ds-prompt');
const dsBraveBanner = document.getElementById('ds-brave-banner');
const dsBraveBannerLink = document.getElementById('ds-brave-banner-link');
const dsConfigToggle = document.getElementById('ds-config-toggle');
const dsConfig = document.getElementById('ds-config');
const dsTargetSize = document.getElementById('ds-target-size');
const dsGoldThreshold = document.getElementById('ds-gold-threshold');
const dsSilverThreshold = document.getElementById('ds-silver-threshold');
const dsMaxSources = document.getElementById('ds-max-sources');
const dsQualityTier = document.getElementById('ds-quality-tier');
const dsBraveKey = document.getElementById('ds-brave-key');
const dsBraveKeyToggle = document.getElementById('ds-brave-key-toggle');
const dsSaveBraveKey = document.getElementById('ds-save-brave-key');
const dsStartBtn = document.getElementById('ds-start');
const dsStopBtn = document.getElementById('ds-stop');
const dsStatusDiv = document.getElementById('ds-status');
const dsPhase = document.getElementById('ds-phase');
const dsProgressBar = document.getElementById('ds-progress-bar');
const dsStatQueries = document.getElementById('ds-stat-queries');
const dsStatUrls = document.getElementById('ds-stat-urls');
const dsStatCrawled = document.getElementById('ds-stat-crawled');
const dsStatScored = document.getElementById('ds-stat-scored');
const dsStatGold = document.getElementById('ds-stat-gold');
const dsStatSilver = document.getElementById('ds-stat-silver');

const vcHeader = document.getElementById('vc-header');
const vcBody = document.getElementById('vc-body');
const vcTierSelect = document.getElementById('vc-tier');
const vcOpenaiNotice = document.getElementById('vc-openai-notice');
const vcSaveSettingsBtn = document.getElementById('vc-save-settings');
const vcStatusBar = document.getElementById('vc-status-bar');
const vcIndPinchtab = document.getElementById('vc-ind-pinchtab');
const vcIndStt = document.getElementById('vc-ind-stt');
const vcIndLlm = document.getElementById('vc-ind-llm');
const vcDownloadBanner = document.getElementById('vc-download-banner');
const vcDlRecommended = document.getElementById('vc-dl-recommended');
const vcDlRecommendedLabel = document.getElementById('vc-dl-recommended-label');
const vcCheckCompanion = document.getElementById('vc-check-companion');
const vcMicContainer = document.getElementById('vc-mic-container');
const vcMicBtn = document.getElementById('vc-mic-btn');
const vcMicLabel = document.getElementById('vc-mic-label');
const vcPttHint = document.getElementById('vc-ptt-hint');
const vcTranscript = document.getElementById('vc-transcript');

let vcListening = false;

const excludedUrls = document.getElementById('excluded-urls');
const minWords = document.getElementById('min-words');
const spaDetection = document.getElementById('spa-detection');
const captureImages = document.getElementById('capture-images');
const captureLinks = document.getElementById('capture-links');
const maxTokens = document.getElementById('max-tokens');
const aiDelay = document.getElementById('ai-delay');
const saveSettingsBtn = document.getElementById('save-settings');
const clearDataBtn = document.getElementById('clear-data');

const apiHeader = document.getElementById('api-header');
const apiBody = document.getElementById('api-body');
const settingsHeader = document.getElementById('settings-header');
const settingsBody = document.getElementById('settings-body');
const recentHeader = document.getElementById('recent-header');
const recentBody = document.getElementById('recent-body');

let sessionTimer = null;
let sessionStartTime = null;

const ALL_KEYS = [
  'isActive', 'useAI', 'provider', 'apiToken', 'customEndpoint',
  'model', 'captureCount', 'totalWords', 'sessionStart', 'recentCaptures',
  'exportFolder', 'aiQuestions',
  'excludedUrls', 'minWords', 'captureImages', 'captureLinks',
  'spaDetection', 'maxTokens', 'aiDelay', 'sanitizeMode',
  'huggingfaceToken', 'hfUsername', 'hfDatasetMode', 'hfDatasetRepo', 'hfPrivate',
  'braveApiKey',
  'vcTier', 'vcBridgeToken'
];

document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  setupEventListeners();
});

async function loadState() {
  const state = await chrome.storage.local.get(ALL_KEYS);

  activateToggle.checked = state.isActive || false;
  aiToggle.checked = state.useAI || false;

  providerSelect.value = state.provider || 'openai';
  apiToken.value = state.apiToken || '';
  customEndpoint.value = state.customEndpoint || '';
  // Store saved model before updateProviderFields populates the dropdown
  modelSelect.dataset.savedModel = state.model || '';

  exportFolderInput.value = state.exportFolder || 'BrowsingCapture';
  aiQuestionsCheckbox.checked = state.aiQuestions || false;
  sanitizeSelect.value = state.sanitizeMode || 'off';

  excludedUrls.value = (state.excludedUrls || []).join('\n');
  minWords.value = state.minWords ?? 50;
  spaDetection.checked = state.spaDetection ?? true;
  captureImages.checked = state.captureImages ?? true;
  captureLinks.checked = state.captureLinks ?? true;
  maxTokens.value = state.maxTokens ?? 8000;
  aiDelay.value = state.aiDelay ?? 2000;

  hfTokenInput.value = state.huggingfaceToken || '';
  hfPrivateCheckbox.checked = state.hfPrivate ?? true;
  if (state.hfDatasetMode === 'existing') {
    hfModeExisting.checked = true;
    hfNewFields.classList.add('hidden');
    hfExistingFields.classList.remove('hidden');
  } else {
    hfModeNew.checked = true;
  }
  hfNewName.value = state.hfDatasetRepo || '';
  // If token was previously validated, show connected state
  if (state.huggingfaceToken && state.hfUsername) {
    hfTokenStatus.textContent = `Connected as @${state.hfUsername}`;
    hfTokenStatus.className = 'hf-token-status valid';
    hfDatasetSection.style.display = '';
    hfPushBtn.style.display = '';
    if (!hfNewName.value) {
      hfNewName.value = (state.exportFolder || 'BrowsingCapture').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    }
  }

  if (state.braveApiKey) {
    dsBraveKey.value = state.braveApiKey;
    dsBraveBanner.classList.add('hidden');
  }

  if (state.vcTier) vcTierSelect.value = state.vcTier;
  updateVCTierFields();

  updateCaptureStatusUI(state.isActive || false);
  updateProviderFields();

  if (state.isActive && state.sessionStart) {
    sessionStartTime = state.sessionStart;
    startSessionTimer();
  }

  captureCount.textContent = state.captureCount || 0;
  totalWords.textContent = formatNumber(state.totalWords || 0);
  renderRecentCaptures(state.recentCaptures || []);
}

function setupEventListeners() {
  activateToggle.addEventListener('change', async () => {
    const isActive = activateToggle.checked;
    const now = Date.now();

    if (isActive) {
      sessionStartTime = now;
      await chrome.storage.local.set({
        isActive: true,
        sessionStart: now,
        captureCount: 0,
        totalWords: 0,
        recentCaptures: []
      });
      startSessionTimer();
      captureCount.textContent = '0';
      totalWords.textContent = '0';
      renderRecentCaptures([]);
    } else {
      await chrome.storage.local.set({ isActive: false });
      stopSessionTimer();
    }

    updateCaptureStatusUI(isActive);
    chrome.runtime.sendMessage({ type: 'TOGGLE_CAPTURE', isActive });
  });

  providerSelect.addEventListener('change', () => {
    updateProviderFields();
    chrome.storage.local.set({ provider: providerSelect.value });
  });

  toggleTokenBtn.addEventListener('click', () => {
    apiToken.type = apiToken.type === 'password' ? 'text' : 'password';
  });

  saveApiBtn.addEventListener('click', async () => {
    const settings = {
      provider: providerSelect.value,
      apiToken: apiToken.value.trim(),
      customEndpoint: customEndpoint.value.trim(),
      model: modelSelect.value
    };

    if (!settings.apiToken && settings.provider !== 'ollama') {
      showToast('Please enter an API token', 'error');
      return;
    }

    await chrome.storage.local.set(settings);
    chrome.runtime.sendMessage({ type: 'UPDATE_API_SETTINGS', settings });
    showToast('API settings saved!', 'success');
  });

  aiToggle.addEventListener('change', async () => {
    const useAI = aiToggle.checked;
    await chrome.storage.local.set({ useAI });
    chrome.runtime.sendMessage({ type: 'TOGGLE_AI', useAI });
  });

  exportFolderInput.addEventListener('change', async () => {
    const folder = exportFolderInput.value.trim() || 'BrowsingCapture';
    exportFolderInput.value = folder;
    await chrome.storage.local.set({ exportFolder: folder });
  });

  aiQuestionsCheckbox.addEventListener('change', async () => {
    await chrome.storage.local.set({ aiQuestions: aiQuestionsCheckbox.checked });
  });

  sanitizeSelect.addEventListener('change', async () => {
    await chrome.storage.local.set({ sanitizeMode: sanitizeSelect.value });
  });

  exportZipBtn.addEventListener('click', async () => {
    await doExport(exportZipBtn, 'zip');
  });

  exportFolderBtn.addEventListener('click', async () => {
    await doExport(exportFolderBtn, 'folder');
  });

  saveSettingsBtn.addEventListener('click', async () => {
    const urls = excludedUrls.value.split('\n').map(l => l.trim()).filter(Boolean);

    await chrome.storage.local.set({
      excludedUrls: urls,
      minWords: parseInt(minWords.value) || 50,
      spaDetection: spaDetection.checked,
      captureImages: captureImages.checked,
      captureLinks: captureLinks.checked,
      maxTokens: parseInt(maxTokens.value) || 8000,
      aiDelay: parseInt(aiDelay.value) || 2000,
    });

    showToast('Settings saved!', 'success');
  });

  clearDataBtn.addEventListener('click', async () => {
    if (confirm('Clear all captured data? This cannot be undone.')) {
      await chrome.storage.local.set({
        captureCount: 0,
        totalWords: 0,
        recentCaptures: [],
      });
      indexedDB.deleteDatabase('BrowsingCaptureDB');
      captureCount.textContent = '0';
      totalWords.textContent = '0';
      renderRecentCaptures([]);
      showToast('All data cleared.', 'success');
    }
  });

  apiHeader.addEventListener('click', () => toggleSection(apiHeader, apiBody));
  crawlHeader.addEventListener('click', () => toggleSection(crawlHeader, crawlBody));
  hfHeader.addEventListener('click', () => toggleSection(hfHeader, hfBody));
  settingsHeader.addEventListener('click', () => toggleSection(settingsHeader, settingsBody));
  recentHeader.addEventListener('click', () => toggleSection(recentHeader, recentBody));

  hfToggleTokenBtn.addEventListener('click', () => {
    hfTokenInput.type = hfTokenInput.type === 'password' ? 'text' : 'password';
  });

  hfSaveTokenBtn.addEventListener('click', async () => {
    const token = hfTokenInput.value.trim();
    if (!token) {
      showToast('Please enter a HuggingFace token', 'error');
      return;
    }
    hfSaveTokenBtn.disabled = true;
    hfSaveTokenBtn.textContent = 'Validating...';
    hfTokenStatus.classList.remove('hidden');
    hfTokenStatus.className = 'hf-token-status';
    hfTokenStatus.textContent = 'Checking token...';

    const result = await chrome.runtime.sendMessage({ type: 'VALIDATE_HF_TOKEN', token });
    hfSaveTokenBtn.disabled = false;
    hfSaveTokenBtn.textContent = 'Validate & Save Token';

    if (result && result.valid) {
      hfTokenStatus.textContent = `Connected as @${result.username}`;
      hfTokenStatus.className = 'hf-token-status valid';
      await chrome.storage.local.set({ huggingfaceToken: token, hfUsername: result.username });
      hfDatasetSection.style.display = '';
      hfPushBtn.style.display = '';
      if (!hfNewName.value) {
        const folder = exportFolderInput.value || 'BrowsingCapture';
        hfNewName.value = folder.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      }
      fetchHFDatasets(token, result.username);
      showToast(`Connected as @${result.username}`, 'success');
    } else {
      hfTokenStatus.textContent = result?.error || 'Invalid token';
      hfTokenStatus.className = 'hf-token-status invalid';
      hfDatasetSection.style.display = 'none';
      hfPushBtn.style.display = 'none';
      await chrome.storage.local.set({ huggingfaceToken: '', hfUsername: '' });
    }
  });

  hfModeNew.addEventListener('change', () => {
    hfNewFields.classList.remove('hidden');
    hfExistingFields.classList.add('hidden');
    chrome.storage.local.set({ hfDatasetMode: 'new' });
  });

  hfModeExisting.addEventListener('change', async () => {
    hfNewFields.classList.add('hidden');
    hfExistingFields.classList.remove('hidden');
    chrome.storage.local.set({ hfDatasetMode: 'existing' });
    const state = await chrome.storage.local.get(['huggingfaceToken', 'hfUsername']);
    if (state.huggingfaceToken && state.hfUsername) {
      fetchHFDatasets(state.huggingfaceToken, state.hfUsername);
    }
  });

  hfNewName.addEventListener('change', () => {
    chrome.storage.local.set({ hfDatasetRepo: hfNewName.value.trim() });
  });

  hfPrivateCheckbox.addEventListener('change', () => {
    chrome.storage.local.set({ hfPrivate: hfPrivateCheckbox.checked });
  });

  hfPushBtn.addEventListener('click', async () => {
    const state = await chrome.storage.local.get(['huggingfaceToken', 'hfUsername']);
    if (!state.huggingfaceToken || !state.hfUsername) {
      showToast('Please validate your HuggingFace token first', 'error');
      return;
    }

    const isNew = hfModeNew.checked;
    let repoId;
    if (isNew) {
      repoId = hfNewName.value.trim();
      if (!repoId) {
        showToast('Please enter a dataset name', 'error');
        return;
      }
    } else {
      repoId = hfExistingSelect.value;
      if (!repoId) {
        showToast('Please select a dataset', 'error');
        return;
      }
    }

    hfPushBtn.disabled = true;
    hfLinksDiv.classList.add('hidden');

    chrome.runtime.sendMessage({
      type: 'PUSH_TO_HF',
      token: state.huggingfaceToken,
      username: state.hfUsername,
      repoId,
      isNew,
      isPrivate: hfPrivateCheckbox.checked,
    });

    updateHFProgressUI({ active: true, phase: 'preparing', current: 0, total: 0, currentFile: '' });
  });


  crawlUseCurrentBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      crawlUrlInput.value = tab.url;
    }
  });

  crawlStartBtn.addEventListener('click', async () => {
    const url = crawlUrlInput.value.trim();
    if (!url) {
      showToast('Enter a URL to crawl', 'error');
      return;
    }

    try {
      new URL(url); // validate
    } catch (e) {
      showToast('Invalid URL', 'error');
      return;
    }

    crawlStartBtn.disabled = true;
    crawlStartBtn.textContent = 'Starting crawl...';

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'START_CRAWL',
        url,
        options: {
          maxPages: parseInt(crawlMaxPages.value) || 100,
          maxDepth: parseInt(crawlMaxDepth.value) || 5,
          delayMs: parseInt(crawlDelay.value) || 2000,
        },
      });

      if (result && result.success) {
        showToast(`Crawl started for ${result.seedDomain}`, 'success');
        updateCrawlUI(true, result.seedDomain, 0, 0);
      } else {
        showToast(result?.error || 'Failed to start crawl', 'error');
        crawlStartBtn.disabled = false;
        crawlStartBtn.innerHTML = crawlStartBtnOrigHTML;
      }
    } catch (err) {
      showToast('Crawl error: ' + err.message, 'error');
      crawlStartBtn.disabled = false;
      crawlStartBtn.innerHTML = crawlStartBtnOrigHTML;
    }
  });

  crawlStopBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'STOP_CRAWL' });
    updateCrawlUI(false);
    showToast('Crawl stopped', 'success');
  });

  const crawlStartBtnOrigHTML = crawlStartBtn.innerHTML;

  chrome.runtime.sendMessage({ type: 'GET_CRAWL_STATUS' }, (response) => {
    if (response && response.active) {
      updateCrawlUI(true, response.seedDomain, response.pagesCrawled, response.queueSize);
    }
  });

  dsHeader.addEventListener('click', () => toggleSection(dsHeader, dsBody));

  dsConfigToggle.addEventListener('click', () => {
    dsConfig.classList.toggle('hidden');
    const chevron = dsConfigToggle.querySelector('.chevron');
    if (chevron) {
      chevron.style.transform = dsConfig.classList.contains('hidden') ? 'rotate(-90deg)' : 'rotate(0deg)';
    }
  });

  dsBraveKeyToggle.addEventListener('click', () => {
    dsBraveKey.type = dsBraveKey.type === 'password' ? 'text' : 'password';
  });

  dsSaveBraveKey.addEventListener('click', async () => {
    const key = dsBraveKey.value.trim();
    await chrome.storage.local.set({ braveApiKey: key });
    chrome.runtime.sendMessage({ type: 'SAVE_BRAVE_API_KEY', key });
    if (key) {
      dsBraveBanner.classList.add('hidden');
      showToast('Brave API key saved!', 'success');
    } else {
      dsBraveBanner.classList.remove('hidden');
      showToast('Brave API key removed', 'success');
    }
  });

  dsBraveBannerLink.addEventListener('click', (e) => {
    e.preventDefault();
    dsConfig.classList.remove('hidden');
    const chevron = dsConfigToggle.querySelector('.chevron');
    if (chevron) chevron.style.transform = 'rotate(0deg)';
    dsBraveKey.focus();
    dsBraveKey.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  dsStartBtn.addEventListener('click', async () => {
    const prompt = dsPrompt.value.trim();
    if (!prompt) {
      showToast('Enter a prompt describing the dataset you want', 'error');
      return;
    }

    dsStartBtn.disabled = true;
    dsStartBtn.textContent = 'Starting...';

    const config = {
      targetSize: parseInt(dsTargetSize.value) || 100,
      goldThreshold: parseFloat(dsGoldThreshold.value) || 0.85,
      silverThreshold: parseFloat(dsSilverThreshold.value) || 0.65,
      maxSourcesPerQuery: parseInt(dsMaxSources.value) || 10,
      qualityTier: dsQualityTier.value || 'both',
    };

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'START_DATASET_BUILDER',
        prompt,
        config,
      });

      if (result && result.success) {
        updateDatasetBuilderUI(true, result);
      } else {
        showToast(result?.error || 'Failed to start dataset builder', 'error');
        dsStartBtn.disabled = false;
        dsStartBtn.innerHTML = dsStartBtnOrigHTML;
      }
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
      dsStartBtn.disabled = false;
      dsStartBtn.innerHTML = dsStartBtnOrigHTML;
    }
  });

  const dsStartBtnOrigHTML = dsStartBtn.innerHTML;

  dsStopBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'STOP_DATASET_BUILDER' });
    updateDatasetBuilderUI(false);
    showToast('Dataset builder stopped', 'success');
  });

  chrome.runtime.sendMessage({ type: 'GET_DATASET_BUILDER_STATUS' }, (response) => {
    if (response && response.active) {
      updateDatasetBuilderUI(true, response);
    }
  });

  chrome.runtime.sendMessage({ type: 'GET_EXPORT_STATUS' }, (response) => {
    if (response) updateExportProgressUI(response);
  });

  chrome.runtime.sendMessage({ type: 'GET_ENHANCE_STATUS' }, (response) => {
    if (response && response.active) updateEnhanceStatusUI(response);
  });

  chrome.runtime.sendMessage({ type: 'GET_HF_STATUS' }, (response) => {
    if (response) updateHFProgressUI(response);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CAPTURE_COMPLETE') {
      updateAfterCapture(msg.data);
    }
    if (msg.type === 'CRAWL_STATUS_UPDATE') {
      updateCrawlUI(msg.active, msg.seedDomain, msg.pagesCrawled, msg.queueSize);
    }
    if (msg.type === 'EXPORT_PROGRESS') {
      updateExportProgressUI(msg);
    }
    if (msg.type === 'ENHANCE_STATUS') {
      updateEnhanceStatusUI(msg);
    }
    if (msg.type === 'HF_UPLOAD_PROGRESS') {
      updateHFProgressUI(msg);
    }
    if (msg.type === 'DATASET_BUILDER_STATUS') {
      updateDatasetBuilderUI(msg.active, msg);
    }
    if (msg.type === 'VC_STATUS') {
      updateVCStatusUI(msg);
    }
    if (msg.type === 'VC_TRANSCRIPT') {
      appendVCTranscript(msg.entry);
    }
    if (msg.type === 'OFFSCREEN_MIC_ERROR') {
      showToast('Mic error: ' + msg.error, 'error');
      vcListening = false;
      vcMicBtn.classList.remove('listening', 'processing');
      vcMicLabel.textContent = 'Click to enable mic';
      vcPttHint.classList.add('hidden');
    }
  });

  vcHeader.addEventListener('click', () => toggleSection(vcHeader, vcBody));

  vcTierSelect.addEventListener('change', updateVCTierFields);

  vcSaveSettingsBtn.addEventListener('click', async () => {
    const settings = {
      tier: vcTierSelect.value,
    };
    await chrome.runtime.sendMessage({ type: 'VC_SAVE_SETTINGS', ...settings });
    showToast('Voice settings saved!', 'success');
  });

  vcMicBtn.addEventListener('click', () => {
    if (vcListening) {
      stopVCListening();
    } else {
      startVCListening();
    }
  });

  chrome.runtime.sendMessage({ type: 'VC_INIT' }, (response) => {
    if (response) {
      updateVCServiceIndicators(response);
    }
  });

  chrome.runtime.sendMessage({ type: 'VC_GET_STATUS' }, (response) => {
    if (response) {
      updateVCStatusUI(response);
      if (response.transcript) {
        for (const entry of response.transcript) {
          appendVCTranscript(entry);
        }
      }
    }
  });

  setupCompanionDownloadLinks();

  if (vcCheckCompanion) {
    vcCheckCompanion.addEventListener('click', async () => {
      vcCheckCompanion.textContent = 'Checking...';
      vcCheckCompanion.disabled = true;
      try {
        const resp = await fetch('http://localhost:9868/health', { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const data = await resp.json();
          showToast('Companion app connected!', 'success');
          chrome.runtime.sendMessage({ type: 'VC_INIT' }, (r) => {
            if (r) updateVCServiceIndicators(r);
          });
        } else {
          showToast('Companion app responded but with an error', 'error');
        }
      } catch (e) {
        showToast('Could not reach companion app. Is it running?', 'error');
      }
      vcCheckCompanion.textContent = 'Check Connection';
      vcCheckCompanion.disabled = false;
    });
  }
}

function updateCrawlUI(active, domain, pages, queued) {
  if (active) {
    crawlStartBtn.classList.add('hidden');
    crawlStatusDiv.classList.remove('hidden');
    crawlDomain.textContent = domain || '—';
    crawlPagesCount.textContent = pages || 0;
    crawlQueueCount.textContent = queued || 0;
  } else {
    crawlStartBtn.classList.remove('hidden');
    crawlStartBtn.disabled = false;
    crawlStartBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg> Start Crawl`;
    crawlStatusDiv.classList.add('hidden');
  }
}

const DS_PHASE_LABELS = {
  idle: 'Idle',
  decomposing: 'Decomposing prompt into queries...',
  searching: 'Searching Brave...',
  crawling: 'Crawling & extracting pages...',
  scoring: 'Scoring quality with LLM...',
  exporting: 'Exporting dataset...',
  done: 'Dataset complete!',
  error: 'Error',
};

function updateDatasetBuilderUI(active, data) {
  const dsStartBtnOrigHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> Start Building Dataset`;

  if (active) {
    dsStartBtn.classList.add('hidden');
    dsStatusDiv.classList.remove('hidden');

    const phase = data?.phase || 'idle';
    dsPhase.textContent = DS_PHASE_LABELS[phase] || phase;

    // Update stats
    const stats = data?.stats || {};
    dsStatQueries.textContent = stats.queriesGenerated || 0;
    dsStatUrls.textContent = stats.urlsFound || 0;
    dsStatCrawled.textContent = stats.urlsCrawled || 0;
    dsStatScored.textContent = stats.entriesScored || 0;
    dsStatGold.textContent = stats.goldCount || 0;
    dsStatSilver.textContent = stats.silverCount || 0;

    const phaseProgress = { idle: 0, decomposing: 10, searching: 30, crawling: 55, scoring: 75, exporting: 90, done: 100, error: 0 };
    dsProgressBar.style.width = `${phaseProgress[phase] || 0}%`;

    if (phase === 'done') {
      dsPhase.style.animation = 'none';
      dsPhase.style.color = '#D9FF6D';
      dsProgressBar.style.width = '100%';
      setTimeout(() => { updateDatasetBuilderUI(false); }, 5000);
    } else if (phase === 'error') {
      dsPhase.style.animation = 'none';
      dsPhase.style.color = '#FF9153';
      dsPhase.textContent = `Error: ${data?.error || 'Unknown error'}`;
    } else {
      dsPhase.style.animation = '';
      dsPhase.style.color = '';
    }
  } else {
    dsStartBtn.classList.remove('hidden');
    dsStartBtn.disabled = false;
    dsStartBtn.innerHTML = dsStartBtnOrigHTML;
    dsStatusDiv.classList.add('hidden');
  }
}

const exportProgressDiv = document.getElementById('export-progress');
const exportProgressPhase = document.getElementById('export-progress-phase');
const exportProgressDetail = document.getElementById('export-progress-detail');
const exportProgressBar = document.getElementById('export-progress-bar');

const PHASE_LABELS = {
  naming: 'Generating filenames...',
  processing: 'Processing pages...',
  sanitizing: 'Sanitizing sensitive data...',
  writing: 'Writing files...',
  done: 'Export complete!',
  error: 'Export failed',
};

function updateExportProgressUI(data) {
  if (data.active) {
    exportProgressDiv.classList.remove('hidden', 'done', 'error');
    exportZipBtn.disabled = true;
    exportFolderBtn.disabled = true;
    exportProgressPhase.textContent = PHASE_LABELS[data.phase] || data.phase;
    const pct = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;
    exportProgressBar.style.width = `${pct}%`;
    exportProgressDetail.textContent = data.total > 0
      ? `${data.current} / ${data.total} — ${data.currentTitle || ''}`
      : '';
  } else if (data.phase === 'done' && data.result) {
    exportProgressDiv.classList.remove('hidden', 'error');
    exportProgressDiv.classList.add('done');
    const r = data.result;
    const domainInfo = r.domains > 1 ? ` across ${r.domains} domains` : '';
    const sanitizeInfo = r.redactions ? ` (${r.redactions} items redacted)` : '';
    exportProgressPhase.textContent = `Exported ${r.count} pages${domainInfo}${sanitizeInfo}`;
    exportProgressDetail.textContent = '';
    exportProgressBar.style.width = '100%';
    exportZipBtn.disabled = false;
    exportFolderBtn.disabled = false;
    setTimeout(() => { exportProgressDiv.classList.add('hidden'); }, 5000);
  } else if (data.phase === 'error') {
    exportProgressDiv.classList.remove('hidden', 'done');
    exportProgressDiv.classList.add('error');
    exportProgressPhase.textContent = 'Export failed';
    exportProgressDetail.textContent = data.result?.error || 'Unknown error';
    exportProgressBar.style.width = '0%';
    exportZipBtn.disabled = false;
    exportFolderBtn.disabled = false;
    setTimeout(() => { exportProgressDiv.classList.add('hidden'); }, 5000);
  } else {
    exportProgressDiv.classList.add('hidden');
    exportZipBtn.disabled = false;
    exportFolderBtn.disabled = false;
  }
}

async function doExport(btn, mode) {
  const sanitizeMode = sanitizeSelect ? sanitizeSelect.value : 'off';
  const sanitizeVal = sanitizeMode !== 'off' ? sanitizeMode : false;

  chrome.runtime.sendMessage({
    type: 'EXPORT',
    mode,
    generateQuestions: aiQuestionsCheckbox.checked,
    sanitize: sanitizeVal,
  });

  updateExportProgressUI({ active: true, phase: 'naming', current: 0, total: 0, currentTitle: '' });
}

function updateCaptureStatusUI(isActive) {
  captureStatus.textContent = isActive ? 'Active — capturing pages' : 'Inactive';
  captureStatus.style.color = isActive ? '#BDD164' : '#666';
}

let enhanceDoneTimer = null;
function updateEnhanceStatusUI(data) {
  if (enhanceDoneTimer) { clearTimeout(enhanceDoneTimer); enhanceDoneTimer = null; }

  if (data.active) {
    enhanceStatusDiv.classList.remove('hidden', 'done');
    const title = data.currentTitle
      ? data.currentTitle.substring(0, 40) + (data.currentTitle.length > 40 ? '...' : '')
      : '';
    enhanceStatusText.textContent = data.total > 1
      ? `Enhancing ${data.current}/${data.total} — ${title}`
      : `Enhancing — ${title}`;
  } else if (data.total > 0) {
    // Just finished
    enhanceStatusDiv.classList.remove('hidden');
    enhanceStatusDiv.classList.add('done');
    enhanceStatusText.textContent = `Enhanced ${data.total} page${data.total > 1 ? 's' : ''}`;
    enhanceDoneTimer = setTimeout(() => { enhanceStatusDiv.classList.add('hidden'); }, 4000);
  } else {
    enhanceStatusDiv.classList.add('hidden');
  }
}

// Model options per provider: [value, label]
const PROVIDER_MODELS = {
  openai: [
    ['gpt-5-nano', 'GPT-5 Nano — fastest, cheapest'],
    ['gpt-5-mini', 'GPT-5 Mini — balanced'],
    ['gpt-5', 'GPT-5 — full reasoning power'],
  ],
  anthropic: [
    ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5 — fastest, cheapest'],
    ['claude-sonnet-4-6', 'Claude Sonnet 4.6 — balanced'],
    ['claude-opus-4-6', 'Claude Opus 4.6 — most intelligent'],
  ],
  ollama: [
    ['llama3.2', 'Llama 3.2 — general purpose'],
    ['mistral', 'Mistral — fast & capable'],
    ['phi3', 'Phi-3 — lightweight'],
    ['deepseek-r1', 'DeepSeek R1 — reasoning'],
    ['qwen2.5', 'Qwen 2.5 — multilingual'],
  ],
  custom: [
    ['', '(Enter model name below)'],
  ],
};

function updateProviderFields() {
  const provider = providerSelect.value;
  const savedModel = modelSelect.dataset.savedModel || '';

  customEndpointField.classList.toggle('hidden', provider !== 'custom');

  const placeholders = {
    openai: 'sk-...',
    anthropic: 'sk-ant-...',
    ollama: 'Not required for local',
    custom: 'Your API key'
  };
  apiToken.placeholder = placeholders[provider] || 'API Token';

  if (provider === 'ollama') {
    apiToken.value = '';
    apiToken.disabled = true;
  } else {
    apiToken.disabled = false;
  }

  const models = PROVIDER_MODELS[provider] || [];
  modelSelect.innerHTML = '';
  for (const [value, label] of models) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    modelSelect.appendChild(opt);
  }

  if (savedModel && models.some(([v]) => v === savedModel)) {
    modelSelect.value = savedModel;
  }
}

function updateAfterCapture(data) {
  const count = parseInt(captureCount.textContent) + 1;
  captureCount.textContent = count;

  const words = parseInt(totalWords.textContent.replace(/,/g, '')) + (data.wordCount || 0);
  totalWords.textContent = formatNumber(words);

  addRecentCapture(data);
}

function addRecentCapture(data) {
  const emptyState = recentList.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const item = document.createElement('div');
  item.className = 'recent-item';
  item.innerHTML = `
    <img class="favicon" src="https://www.google.com/s2/favicons?domain=${data.domain}&sz=32" alt="">
    <div class="info">
      <div class="title" title="${escapeHtml(data.title)}">${escapeHtml(data.title)}</div>
      <div class="domain">${escapeHtml(data.domain)}</div>
    </div>
    <span class="time">just now</span>
  `;

  recentList.insertBefore(item, recentList.firstChild);

  while (recentList.children.length > 20) {
    recentList.removeChild(recentList.lastChild);
  }
}

function renderRecentCaptures(captures) {
  if (!captures || captures.length === 0) {
    recentList.innerHTML = '<div class="empty-state">No captures yet. Activate and start browsing!</div>';
    return;
  }

  recentList.innerHTML = '';
  captures.slice(0, 20).forEach(data => {
    const item = document.createElement('div');
    item.className = 'recent-item';
    const timeAgo = formatTimeAgo(data.timestamp);
    item.innerHTML = `
      <img class="favicon" src="https://www.google.com/s2/favicons?domain=${data.domain}&sz=32" alt="">
      <div class="info">
        <div class="title" title="${escapeHtml(data.title)}">${escapeHtml(data.title)}</div>
        <div class="domain">${escapeHtml(data.domain)}</div>
      </div>
      <span class="time">${timeAgo}</span>
    `;
    recentList.appendChild(item);
  });
}

function toggleSection(header, body) {
  header.classList.toggle('collapsed');
  body.classList.toggle('hidden');
}

function startSessionTimer() {
  updateSessionTime();
  sessionTimer = setInterval(updateSessionTime, 60000);
}

function stopSessionTimer() {
  if (sessionTimer) clearInterval(sessionTimer);
  sessionTime.textContent = '0m';
}

function updateSessionTime() {
  if (!sessionStartTime) return;
  const elapsed = Date.now() - sessionStartTime;
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 60) {
    sessionTime.textContent = `${minutes}m`;
  } else {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    sessionTime.textContent = `${hours}h ${mins}m`;
  }
}

function showToast(message, type = 'success') {
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

function formatNumber(num) {
  return num.toLocaleString();
}

function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

async function fetchHFDatasets(token, username) {
  hfExistingSelect.innerHTML = '<option value="">Loading...</option>';
  const result = await chrome.runtime.sendMessage({ type: 'FETCH_HF_DATASETS', token, username });
  if (result && result.success && result.datasets) {
    hfExistingSelect.innerHTML = '';
    if (result.datasets.length === 0) {
      hfExistingSelect.innerHTML = '<option value="">No datasets found</option>';
    } else {
      for (const ds of result.datasets) {
        const opt = document.createElement('option');
        opt.value = ds.id;
        opt.textContent = ds.name + (ds.private ? ' (private)' : '');
        hfExistingSelect.appendChild(opt);
      }
    }
  } else {
    hfExistingSelect.innerHTML = `<option value="">Error: ${result?.error || 'Failed'}</option>`;
  }
}

const HF_PHASE_LABELS = {
  preparing: 'Preparing training data...',
  creating: 'Creating dataset repo...',
  uploading: 'Uploading files...',
  done: 'Upload complete!',
  error: 'Upload failed',
};


function updateVCTierFields() {
  const tier = vcTierSelect.value;
  vcOpenaiNotice.classList.toggle('hidden', tier !== 'openai_realtime');

  if (tier === 'openai_realtime') {
    vcIndStt.querySelector('.vc-dot').nextSibling.textContent = 'Realtime';
    vcIndLlm.classList.add('hidden');
  } else {
    vcIndStt.innerHTML = '<span class="vc-dot"></span>STT';
    vcIndLlm.classList.remove('hidden');
  }
}

function updateVCServiceIndicators(data) {
  if (data.pinchtab) {
    vcIndPinchtab.classList.add('connected');
    vcDownloadBanner.classList.add('hidden');
    vcMicContainer.classList.remove('hidden');
  } else {
    vcIndPinchtab.classList.remove('connected');
    vcDownloadBanner.classList.remove('hidden');
    vcMicContainer.classList.add('hidden');
  }

  const tier = vcTierSelect.value;
  if (tier === 'local') {
    vcIndStt.classList.toggle('connected', !!data.whisper);
    vcIndLlm.classList.toggle('connected', !!data.llamafile);
  } else if (tier === 'openai_realtime') {
    vcIndStt.classList.toggle('connected', true);
  }
}

function updateVCStatusUI(data) {
  if (data.listening) {
    vcMicBtn.classList.add('listening');
    vcMicBtn.classList.remove('processing');
    vcMicLabel.textContent = 'Mic active — click to stop';
    vcPttHint.classList.remove('hidden');
  } else if (data.processing) {
    vcMicBtn.classList.remove('listening');
    vcMicBtn.classList.add('processing');
    vcMicLabel.textContent = 'Processing...';
    vcPttHint.classList.add('hidden');
  } else {
    vcMicBtn.classList.remove('listening', 'processing');
    vcMicLabel.textContent = 'Click to enable mic';
    vcPttHint.classList.add('hidden');
  }
}

function appendVCTranscript(entry) {
  vcTranscript.classList.remove('hidden');

  const div = document.createElement('div');
  div.className = `vc-msg ${entry.role}`;

  let text = entry.text || '';
  if (entry.action) {
    text = `[${entry.action}] ${text}`;
  }

  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `${escapeHtml(text)}<span class="vc-msg-time">${time}</span>`;

  vcTranscript.appendChild(div);
  vcTranscript.scrollTop = vcTranscript.scrollHeight;
}


const COMPANION_REPO = 'thedefaultman/Zahhak-crawler';
const COMPANION_TAG = 'latest';

function getCompanionDownloadURL(platform) {
  const base = `https://github.com/${COMPANION_REPO}/releases/${COMPANION_TAG}/download`;
  const map = {
    'windows': `${base}/voice-commander-windows-amd64.exe`,
    'mac-intel': `${base}/voice-commander-darwin-amd64`,
    'mac-arm': `${base}/voice-commander-darwin-arm64`,
    'linux': `${base}/voice-commander-linux-amd64`,
  };
  return map[platform] || map['windows'];
}

function detectPlatform() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return { key: 'windows', label: 'Download for Windows' };
  if (ua.includes('mac')) {
    // Can't perfectly detect ARM vs Intel from UA, but Apple Silicon is much more common now
    return { key: 'mac-arm', label: 'Download for macOS (Apple Silicon)' };
  }
  if (ua.includes('linux')) return { key: 'linux', label: 'Download for Linux' };
  return { key: 'windows', label: 'Download' };
}

function setupCompanionDownloadLinks() {
  const platform = detectPlatform();

  if (vcDlRecommended) {
    vcDlRecommended.href = getCompanionDownloadURL(platform.key);
    vcDlRecommendedLabel.textContent = platform.label;
  }

  const platformLinks = document.querySelectorAll('.vc-platform-link');
  platformLinks.forEach(link => {
    const plat = link.getAttribute('data-platform');
    if (plat) {
      link.href = getCompanionDownloadURL(plat);
      link.target = '_blank';
    }
  });
}

async function startVCListening() {
  const tier = vcTierSelect.value;

  try {
    // All tiers use content script injection (popups can't access getUserMedia)
    vcMicBtn.classList.add('listening');
    vcMicLabel.textContent = 'Starting mic...';

    const result = await chrome.runtime.sendMessage({ type: 'VC_REQUEST_MIC', tier });
    if (result && result.success === false) {
      throw new Error(result.error || 'Failed to start mic capture');
    }

    vcListening = true;
    vcMicLabel.textContent = 'Mic active — click to stop';

    // Show PTT hint for local mode only (OpenAI Realtime uses server VAD)
    if (tier === 'openai_realtime') {
      vcPttHint.classList.add('hidden');
    } else {
      vcPttHint.classList.remove('hidden');
    }

    chrome.runtime.sendMessage({ type: 'VC_START_LISTENING', tier });
  } catch (err) {
    vcMicBtn.classList.remove('listening', 'processing');
    vcMicLabel.textContent = 'Click to enable mic';
    vcPttHint.classList.add('hidden');
    showToast('Mic error: ' + err.message, 'error');
  }
}

function stopVCListening() {
  vcListening = false;

  chrome.runtime.sendMessage({ type: 'VC_STOP_MIC' });

  vcMicBtn.classList.remove('listening', 'processing');
  vcMicLabel.textContent = 'Click to enable mic';
  vcPttHint.classList.add('hidden');

  chrome.runtime.sendMessage({ type: 'VC_STOP_LISTENING' });
}

function updateHFProgressUI(data) {
  if (data.active) {
    hfProgressDiv.classList.remove('hidden', 'done', 'error');
    hfPushBtn.disabled = true;
    hfLinksDiv.classList.add('hidden');
    hfProgressText.textContent = HF_PHASE_LABELS[data.phase] || data.phase;
    const pct = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;
    hfProgressBar.style.width = `${pct}%`;
    hfProgressDetail.textContent = data.currentFile || '';
  } else if (data.phase === 'done' && data.result && data.result.success) {
    hfProgressDiv.classList.remove('hidden', 'error');
    hfProgressDiv.classList.add('done');
    hfProgressText.textContent = `Uploaded ${data.result.captureCount} pages (${data.result.fileCount} files)`;
    hfProgressDetail.textContent = data.result.repoId;
    hfProgressBar.style.width = '100%';
    hfPushBtn.disabled = false;
    hfLinksDiv.classList.remove('hidden');
    hfLinkDataset.href = data.result.datasetUrl;
    hfLinkAutotrain.href = data.result.autotrainUrl;
    setTimeout(() => { hfProgressDiv.classList.add('hidden'); }, 8000);
  } else if (data.phase === 'error') {
    hfProgressDiv.classList.remove('hidden', 'done');
    hfProgressDiv.classList.add('error');
    hfProgressText.textContent = 'Upload failed';
    hfProgressDetail.textContent = data.result?.error || 'Unknown error';
    hfProgressBar.style.width = '0%';
    hfPushBtn.disabled = false;
    setTimeout(() => { hfProgressDiv.classList.add('hidden'); }, 6000);
  } else {
    hfProgressDiv.classList.add('hidden');
    hfPushBtn.disabled = false;
  }
}
