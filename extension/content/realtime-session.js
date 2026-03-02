// OpenAI Realtime WebRTC session — injected into active tab.
// Handles mic capture + WebRTC connection to OpenAI Realtime API.
// Uses server-side VAD (voice activity detection) — just talk freely.

(async function () {
  if (window.__vcRealtimeActive) {
    chrome.runtime.sendMessage({ type: 'REALTIME_SESSION_STARTED' });
    return;
  }
  window.__vcRealtimeActive = true;

  let pc = null;
  let audioStream = null;
  let dc = null;
  let audioEl = null;

  // Listen for stop/cleanup messages
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CONTENT_STOP_MIC' || msg.type === 'CONTENT_STOP_REALTIME') {
      cleanup();
    }
  });

  // --- Visual indicator ---
  const style = document.createElement('style');
  style.textContent = `
    @keyframes __vc-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    #__vc-realtime-indicator {
      position: fixed; top: 12px; right: 12px; z-index: 2147483647;
      padding: 8px 16px; border-radius: 8px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px; font-weight: 600;
      box-shadow: 0 2px 12px rgba(0,0,0,0.25);
      pointer-events: none; transition: opacity 0.15s;
    }
    #__vc-realtime-indicator.connecting {
      background: rgba(30,30,30,0.75); color: #f59e0b;
      backdrop-filter: blur(8px); opacity: 0.9;
    }
    #__vc-realtime-indicator.listening {
      background: #059669; color: white;
      animation: __vc-pulse 2s ease-in-out infinite;
      opacity: 1;
    }
    #__vc-realtime-indicator.error {
      background: #dc2626; color: white; opacity: 1;
    }
  `;
  document.documentElement.appendChild(style);

  const indicator = document.createElement('div');
  indicator.id = '__vc-realtime-indicator';
  indicator.className = 'connecting';
  indicator.textContent = 'Connecting to OpenAI...';
  document.body.appendChild(indicator);

  try {
    // Step 1: Get ephemeral token from service worker
    const tokenResp = await chrome.runtime.sendMessage({ type: 'VC_GET_EPHEMERAL_TOKEN' });
    if (!tokenResp.success) {
      throw new Error(tokenResp.error || 'Failed to get ephemeral token');
    }

    const ephemeralToken = tokenResp.client_secret?.value;
    if (!ephemeralToken) {
      throw new Error('No ephemeral token received');
    }

    // Step 2: Get mic access (works from content script, unlike popup)
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      }
    });

    // Step 3: Set up WebRTC peer connection
    pc = new RTCPeerConnection();

    // Add mic audio tracks to the connection
    audioStream.getTracks().forEach(track => pc.addTrack(track, audioStream));

    // Set up audio output (OpenAI sends voice responses via WebRTC)
    audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    pc.ontrack = (e) => {
      audioEl.srcObject = e.streams[0];
    };

    // Step 4: Create data channel for events
    dc = pc.createDataChannel('oai-events');
    dc.addEventListener('open', () => {
      console.log('[VC Realtime] Data channel open');
    });

    dc.addEventListener('message', (e) => {
      try {
        const event = JSON.parse(e.data);
        handleRealtimeEvent(event);
      } catch (err) {
        console.warn('[VC Realtime] Event parse error:', err);
      }
    });

    // Step 5: SDP exchange with OpenAI
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const model = 'gpt-4o-realtime-preview-2024-12-17';
    const sdpResp = await fetch(`https://api.openai.com/v1/realtime?model=${model}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ephemeralToken}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp,
    });

    if (!sdpResp.ok) {
      const errText = await sdpResp.text().catch(() => '');
      throw new Error(`WebRTC SDP exchange failed: ${sdpResp.status} ${errText}`);
    }

    const answerSdp = await sdpResp.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    // Success — update indicator
    indicator.className = 'listening';
    indicator.textContent = 'OpenAI Realtime — listening';

    chrome.runtime.sendMessage({ type: 'REALTIME_SESSION_STARTED' });
    console.log('[VC Realtime] Session active. Just speak — server VAD detects your voice.');

  } catch (err) {
    console.error('[VC Realtime] Setup error:', err);
    indicator.className = 'error';
    indicator.textContent = 'Realtime error: ' + err.message;

    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_MIC_ERROR',
      error: err.message,
    });

    // Auto-cleanup after showing error briefly
    setTimeout(() => cleanup(), 4000);
    return;
  }

  // --- Event handlers ---

  function handleRealtimeEvent(event) {
    switch (event.type) {
      case 'response.audio_transcript.done':
        if (event.transcript) {
          chrome.runtime.sendMessage({
            type: 'VC_REALTIME_TRANSCRIPT',
            role: 'assistant',
            text: event.transcript,
          });
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          chrome.runtime.sendMessage({
            type: 'VC_REALTIME_TRANSCRIPT',
            role: 'user',
            text: event.transcript,
          });
        }
        break;

      case 'response.function_call_arguments.done':
        handleToolCall(event);
        break;

      case 'error':
        console.error('[VC Realtime] Error from server:', event.error);
        chrome.runtime.sendMessage({
          type: 'VC_REALTIME_TRANSCRIPT',
          role: 'action',
          text: `Error: ${event.error?.message || 'Unknown'}`,
        });
        break;

      default:
        // Ignore other event types (session.created, response.audio.delta, etc.)
        break;
    }
  }

  async function handleToolCall(event) {
    try {
      const toolName = event.name;
      let toolArgs = {};
      try { toolArgs = JSON.parse(event.arguments || '{}'); } catch (e) {}

      // Execute via service worker (which talks to PinchTab)
      const result = await chrome.runtime.sendMessage({
        type: 'VC_TOOL_CALL',
        toolName,
        args: toolArgs,
      });

      // Send result back to OpenAI via data channel
      if (dc && dc.readyState === 'open') {
        dc.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: event.call_id,
            output: JSON.stringify(result?.result || { error: 'Tool execution failed' }),
          },
        }));

        // Tell model to continue generating response
        dc.send(JSON.stringify({ type: 'response.create' }));
      }
    } catch (err) {
      console.error('[VC Realtime] Tool call error:', err);
    }
  }

  // --- Cleanup ---

  function cleanup() {
    window.__vcRealtimeActive = false;

    if (dc) {
      try { dc.close(); } catch (e) {}
      dc = null;
    }
    if (pc) {
      pc.close();
      pc = null;
    }
    if (audioStream) {
      audioStream.getTracks().forEach(t => t.stop());
      audioStream = null;
    }
    if (audioEl) {
      audioEl.srcObject = null;
      audioEl.remove();
      audioEl = null;
    }
    if (indicator && indicator.parentNode) indicator.remove();
    if (style && style.parentNode) style.remove();
  }
})();
