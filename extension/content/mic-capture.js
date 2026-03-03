// Mic capture — injected into active tab for Voice Commander.
// Push-to-talk: hold Right Alt to record, release to send.
// Uses Web Speech API (cloud-based recognition).
// Chat overlay shows conversation on the page.

(function() {
  if (window.__vcMicActive) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_MIC_STARTED' });
    return;
  }
  window.__vcMicActive = true;

  let recognition = null;
  let listening = true;
  let keyHeld = false;
  let pendingText = '';

  const PTT_KEY = 'AltRight';
  const LANG = 'en-US';

  // --- Styles for indicator + chat overlay ---
  const style = document.createElement('style');
  style.textContent = `
    @keyframes __vc-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    @keyframes __vc-dots {
      0%, 80%, 100% { opacity: 0.3; }
      40% { opacity: 1; }
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

    #__vc-chat {
      position: fixed; bottom: 16px; right: 16px; z-index: 2147483646;
      width: 360px; max-height: 350px;
      background: rgba(8, 8, 12, 0.92);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
      font-family: system-ui, -apple-system, sans-serif;
      display: flex; flex-direction: column;
      overflow: hidden;
      transition: opacity 0.2s;
    }
    #__vc-chat.hidden { opacity: 0; pointer-events: none; }
    #__vc-chat-header {
      padding: 8px 12px;
      font-size: 11px; font-weight: 600; color: #888;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    #__vc-chat-messages {
      flex: 1; overflow-y: auto; padding: 8px;
      display: flex; flex-direction: column; gap: 6px;
      min-height: 40px; max-height: 280px;
    }
    #__vc-chat-messages::-webkit-scrollbar { width: 4px; }
    #__vc-chat-messages::-webkit-scrollbar-track { background: transparent; }
    #__vc-chat-messages::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }

    .__vc-msg {
      font-size: 12px; line-height: 1.4;
      padding: 6px 10px; border-radius: 8px;
      max-width: 88%; word-wrap: break-word;
    }
    .__vc-msg.user {
      background: #0a1500; border: 1px solid #1a2a10;
      color: #BDD164; align-self: flex-end;
    }
    .__vc-msg.assistant {
      background: #000D35; border: 1px solid #1a2550;
      color: #9b91f5; align-self: flex-start;
    }
    .__vc-msg.action {
      background: #0a0a0a; border: 1px solid #1a1a1a;
      color: #FF9153; align-self: flex-start;
      font-family: 'SF Mono', 'Consolas', 'Courier New', monospace;
      font-size: 11px;
    }

    #__vc-processing {
      padding: 6px 10px; font-size: 12px; color: #666;
      align-self: flex-start; display: none;
    }
    #__vc-processing.visible { display: block; }
    #__vc-processing span {
      animation: __vc-dots 1.4s infinite both;
    }
    #__vc-processing span:nth-child(2) { animation-delay: 0.2s; }
    #__vc-processing span:nth-child(3) { animation-delay: 0.4s; }
  `;
  document.documentElement.appendChild(style);

  // --- PTT indicator ---
  const indicator = document.createElement('div');
  indicator.id = '__vc-ptt-indicator';
  indicator.className = 'ready';
  indicator.textContent = 'Initializing speech...';
  document.body.appendChild(indicator);

  // --- Chat overlay ---
  const chat = document.createElement('div');
  chat.id = '__vc-chat';
  chat.className = 'hidden';
  chat.innerHTML = `
    <div id="__vc-chat-header">Voice Commander</div>
    <div id="__vc-chat-messages">
      <div id="__vc-processing"><span>.</span><span>.</span><span>.</span> Thinking</div>
    </div>
  `;
  document.body.appendChild(chat);

  const chatMessages = chat.querySelector('#__vc-chat-messages');
  const processingEl = chat.querySelector('#__vc-processing');

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  function appendChatMessage(entry) {
    // Show the chat overlay on first message
    chat.classList.remove('hidden');

    const div = document.createElement('div');
    div.className = `__vc-msg ${entry.role}`;

    let text = entry.text || '';
    if (entry.action && entry.role === 'action') {
      text = `[${entry.action}] ${text}`;
    }
    div.innerHTML = escapeHtml(text);

    // Insert before the processing indicator
    chatMessages.insertBefore(div, processingEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Hide processing when assistant or action arrives
    if (entry.role === 'assistant' || entry.role === 'action') {
      processingEl.classList.remove('visible');
    }
  }

  function showProcessing() {
    processingEl.classList.add('visible');
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // --- Listen for chat messages from service worker ---
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CONTENT_STOP_MIC') {
      stopCapture();
    }
    if (msg.type === 'VC_TRANSCRIPT' && msg.entry) {
      appendChatMessage(msg.entry);
    }
  });

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
    chat.remove();
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = LANG;
  recognition.interimResults = false;
  recognition.continuous = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
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
    if (event.error === 'no-speech' || event.error === 'aborted') {
      return;
    }
    console.error('[VoiceCmdr] Speech recognition error:', event.error);
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_MIC_ERROR',
      error: `Speech recognition error: ${event.error}`,
    });
  };

  recognition.onend = () => {
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
    } catch (e) {}
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
    setTimeout(flushText, 300);
  }, true);

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
    showProcessing();
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
    if (chat && chat.parentNode) chat.remove();
  }

  indicator.className = 'ready';
  indicator.textContent = 'Hold Right Alt to talk';
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_MIC_STARTED' });
  console.log('[VoiceCmdr] Push-to-talk ready. Hold Right Alt to speak.');
})();
