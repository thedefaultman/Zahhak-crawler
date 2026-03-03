// Mic capture — injected into active tab for Voice Commander.
// Push-to-talk: hold Right Alt to record, release to send.
// Uses Web Speech API with on-device processing (processLocally).

(async function() {
  if (window.__vcMicActive) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_MIC_STARTED' });
    return;
  }
  window.__vcMicActive = true;

  let recognition = null;
  let listening = true;
  let keyHeld = false;
  let pendingText = '';
  let useLocalProcessing = false;

  const PTT_KEY = 'AltRight';
  const LANG = 'en-US';

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CONTENT_STOP_MIC') {
      stopCapture();
    }
  });

  // --- Visual indicator ---
  const style = document.createElement('style');
  style.textContent = `
    @keyframes __vc-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    #__vc-ptt-indicator {
      position: fixed; top: 12px; right: 12px; z-index: 2147483647;
      padding: 8px 16px; border-radius: 8px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px; font-weight: 600;
      box-shadow: 0 2px 12px rgba(0,0,0,0.25);
      pointer-events: none; transition: opacity 0.15s;
    }
    #__vc-ptt-indicator.ready {
      background: rgba(30,30,30,0.75); color: #ccc;
      backdrop-filter: blur(8px); opacity: 0.7;
    }
    #__vc-ptt-indicator.recording {
      background: #dc2626; color: white;
      animation: __vc-pulse 1s ease-in-out infinite;
      opacity: 1;
    }
    #__vc-ptt-indicator.installing {
      background: #2563eb; color: white;
      animation: __vc-pulse 1.5s ease-in-out infinite;
      opacity: 1;
    }
  `;
  document.documentElement.appendChild(style);

  const indicator = document.createElement('div');
  indicator.id = '__vc-ptt-indicator';
  indicator.className = 'ready';
  indicator.textContent = 'Initializing speech...';
  document.body.appendChild(indicator);

  // --- Web Speech API setup ---
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_MIC_ERROR',
      error: 'Web Speech API not supported in this browser',
    });
    window.__vcMicActive = false;
    indicator.remove();
    style.remove();
    return;
  }

  // Check if on-device language pack is available, install if needed
  if (typeof SpeechRecognition.available === 'function') {
    try {
      const status = await SpeechRecognition.available({
        langs: [LANG],
        processLocally: true,
      });
      console.log('[VoiceCmdr] On-device STT availability:', status);

      if (status === 'available') {
        useLocalProcessing = true;
      } else if (status === 'downloadable' || status === 'downloading') {
        // Install the language pack
        indicator.className = 'installing';
        indicator.textContent = 'Installing speech pack...';
        console.log('[VoiceCmdr] Installing on-device language pack for', LANG);

        const installed = await SpeechRecognition.install({ langs: [LANG] });
        if (installed) {
          useLocalProcessing = true;
          console.log('[VoiceCmdr] Language pack installed successfully');
        } else {
          console.warn('[VoiceCmdr] Language pack install failed, falling back to cloud STT');
        }
      } else {
        console.log('[VoiceCmdr] On-device STT unavailable for', LANG, '— using cloud STT');
      }
    } catch (e) {
      console.warn('[VoiceCmdr] Error checking on-device availability:', e.message);
    }
  } else {
    console.log('[VoiceCmdr] SpeechRecognition.available() not supported');
  }

  recognition = new SpeechRecognition();
  recognition.lang = LANG;
  recognition.interimResults = false;
  recognition.continuous = true;
  recognition.maxAlternatives = 1;

  if (useLocalProcessing && 'processLocally' in recognition) {
    recognition.processLocally = true;
    console.log('[VoiceCmdr] On-device speech recognition enabled');
  } else {
    console.log('[VoiceCmdr] Using cloud speech recognition');
  }

  recognition.onresult = (event) => {
    // Collect all new final results since last check
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        const text = event.results[i][0].transcript.trim();
        if (text) {
          pendingText += (pendingText ? ' ' : '') + text;
        }
      }
    }
  };

  recognition.onerror = (event) => {
    // 'no-speech' and 'aborted' are expected during push-to-talk
    if (event.error === 'no-speech' || event.error === 'aborted') {
      console.log('[VoiceCmdr] Recognition:', event.error);
      return;
    }
    console.error('[VoiceCmdr] Speech recognition error:', event.error);
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_MIC_ERROR',
      error: `Speech recognition error: ${event.error}`,
    });
  };

  recognition.onend = () => {
    // If key is still held, recognition ended unexpectedly — restart it
    if (keyHeld && listening) {
      try { recognition.start(); } catch (e) {}
    }
  };

  // --- Push-to-talk key handlers ---
  document.addEventListener('keydown', (e) => {
    if (e.code !== PTT_KEY || !listening || keyHeld) return;
    e.preventDefault();
    e.stopPropagation();
    keyHeld = true;
    pendingText = '';
    indicator.className = 'recording';
    indicator.textContent = 'Recording...';
    try {
      recognition.start();
    } catch (e) {
      // Already started — ignore
    }
  }, true);

  document.addEventListener('keyup', (e) => {
    if (e.code !== PTT_KEY || !keyHeld) return;
    e.preventDefault();
    e.stopPropagation();
    keyHeld = false;
    indicator.className = 'ready';
    indicator.textContent = 'Hold Right Alt to talk';
    try {
      recognition.stop();
    } catch (e) {}
    // Small delay to let final results arrive before flushing
    setTimeout(flushText, 300);
  }, true);

  // Handle losing focus while key is held (e.g. Alt+Tab)
  window.addEventListener('blur', () => {
    if (keyHeld) {
      keyHeld = false;
      indicator.className = 'ready';
      indicator.textContent = 'Hold Right Alt to talk';
      try { recognition.stop(); } catch (e) {}
      setTimeout(flushText, 300);
    }
  });

  function flushText() {
    const text = pendingText.trim();
    pendingText = '';
    if (!text) return;

    console.log('[VoiceCmdr] Recognized:', text);
    chrome.runtime.sendMessage({
      type: 'VC_TEXT_RESULT',
      text: text,
    });
  }

  function stopCapture() {
    listening = false;
    keyHeld = false;
    window.__vcMicActive = false;
    if (recognition) {
      try { recognition.stop(); } catch (e) {}
      recognition = null;
    }
    if (indicator && indicator.parentNode) indicator.remove();
    if (style && style.parentNode) style.remove();
  }

  indicator.className = 'ready';
  indicator.textContent = 'Hold Right Alt to talk';
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_MIC_STARTED' });
  console.log('[VoiceCmdr] Push-to-talk ready (local:', useLocalProcessing, '). Hold Right Alt to speak.');
})();
