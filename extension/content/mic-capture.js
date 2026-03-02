// Mic capture — injected into active tab for Voice Commander.
// Push-to-talk: hold Right Alt to record, release to send.
// Captures raw PCM and encodes as WAV (Whisperfile doesn't support WebM).

(async function() {
  if (window.__vcMicActive) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_MIC_STARTED' });
    return;
  }
  window.__vcMicActive = true;

  let audioStream = null;
  let audioContext = null;
  let scriptNode = null;
  let pcmChunks = [];
  let recording = false;
  let listening = true;
  let keyHeld = false;

  const PTT_KEY = 'AltRight';

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
  `;
  document.documentElement.appendChild(style);

  const indicator = document.createElement('div');
  indicator.id = '__vc-ptt-indicator';
  indicator.className = 'ready';
  indicator.textContent = 'Hold Right Alt to talk';
  document.body.appendChild(indicator);

  // --- Push-to-talk key handlers ---
  document.addEventListener('keydown', (e) => {
    if (e.code !== PTT_KEY || !listening || keyHeld) return;
    e.preventDefault();
    e.stopPropagation();
    keyHeld = true;
    recording = true;
    pcmChunks = [];
    indicator.className = 'recording';
    indicator.textContent = 'Recording...';
  }, true);

  document.addEventListener('keyup', (e) => {
    if (e.code !== PTT_KEY || !keyHeld) return;
    e.preventDefault();
    e.stopPropagation();
    keyHeld = false;
    recording = false;
    indicator.className = 'ready';
    indicator.textContent = 'Hold Right Alt to talk';
    flushAudio();
  }, true);

  // Handle losing focus while key is held (e.g. Alt+Tab)
  window.addEventListener('blur', () => {
    if (keyHeld) {
      keyHeld = false;
      recording = false;
      indicator.className = 'ready';
      indicator.textContent = 'Hold Right Alt to talk';
      flushAudio();
    }
  });

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      }
    });

    // Use browser's native sample rate — Whisperfile handles resampling
    audioContext = new AudioContext();
    console.log('[VoiceCmdr] AudioContext sample rate:', audioContext.sampleRate);

    const source = audioContext.createMediaStreamSource(audioStream);

    // Capture raw PCM via ScriptProcessorNode
    scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
    source.connect(scriptNode);
    scriptNode.connect(audioContext.destination);

    scriptNode.onaudioprocess = (e) => {
      if (!recording) return;
      const input = e.inputBuffer.getChannelData(0);
      pcmChunks.push(new Float32Array(input));
    };

    chrome.runtime.sendMessage({ type: 'OFFSCREEN_MIC_STARTED' });
    console.log('[VoiceCmdr] Push-to-talk ready. Hold Right Alt to speak.');

  } catch (err) {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_MIC_ERROR',
      error: err.message,
    });
    window.__vcMicActive = false;
    if (indicator.parentNode) indicator.remove();
    if (style.parentNode) style.remove();
  }

  function flushAudio() {
    if (pcmChunks.length === 0) return;

    const chunks = pcmChunks;
    pcmChunks = [];

    let totalLength = 0;
    for (const c of chunks) totalLength += c.length;

    const rate = audioContext ? audioContext.sampleRate : 48000;
    const minSamples = Math.floor(rate * 0.1); // skip < 0.1s
    if (totalLength < minSamples) return;

    const samples = new Float32Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
      samples.set(c, offset);
      offset += c.length;
    }

    const wavBuffer = encodeWav(samples, rate);
    const base64 = arrayBufferToBase64(wavBuffer);

    console.log('[VoiceCmdr] Sending WAV:', totalLength, 'samples @', rate, 'Hz,',
      wavBuffer.byteLength, 'bytes, base64 len:', base64.length);

    chrome.runtime.sendMessage({
      type: 'VC_AUDIO_CHUNK',
      audio: base64,
      mimeType: 'audio/wav',
    });
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const CHUNK = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
      binary += String.fromCharCode.apply(null, slice);
    }
    return btoa(binary);
  }

  function encodeWav(samples, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = samples.length * (bitsPerSample / 8);
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeStr(off, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return buffer;
  }

  function stopCapture() {
    listening = false;
    recording = false;
    keyHeld = false;
    window.__vcMicActive = false;
    if (scriptNode) {
      scriptNode.disconnect();
      scriptNode = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    if (audioStream) {
      audioStream.getTracks().forEach(t => t.stop());
      audioStream = null;
    }
    if (indicator && indicator.parentNode) indicator.remove();
    if (style && style.parentNode) style.remove();
  }
})();
