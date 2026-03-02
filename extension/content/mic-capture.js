// Mic capture — injected into active tab for Voice Commander.
// Extension popups can't show the mic permission prompt, so we inject this into the active tab.

(async function() {
  if (window.__vcMicActive) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_MIC_STARTED' });
    return;
  }
  window.__vcMicActive = true;

  let mediaRecorder = null;
  let audioStream = null;
  let audioChunks = [];
  let listening = true;

  const SILENCE_TIMEOUT = 1500;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CONTENT_STOP_MIC') {
      stopCapture();
    }
  });

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      }
    });

    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(audioStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    mediaRecorder = new MediaRecorder(audioStream, { mimeType });
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      if (audioChunks.length === 0) return;
      const blob = new Blob(audioChunks, { type: mimeType });
      audioChunks = [];
      if (blob.size < 1000) return;

      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        chrome.runtime.sendMessage({
          type: 'VC_AUDIO_CHUNK',
          audio: base64,
          mimeType: mimeType,
        });
      };
      reader.readAsDataURL(blob);
    };

    mediaRecorder.start(1000);

    chrome.runtime.sendMessage({ type: 'OFFSCREEN_MIC_STARTED' });

    let speaking = false;
    let silenceStart = null;

    const vadInterval = setInterval(() => {
      if (!listening || !mediaRecorder || mediaRecorder.state === 'inactive') {
        clearInterval(vadInterval);
        return;
      }

      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;

      if (avg > 15) {
        speaking = true;
        silenceStart = null;
      } else if (speaking) {
        if (!silenceStart) silenceStart = Date.now();
        if (Date.now() - silenceStart > SILENCE_TIMEOUT) {
          speaking = false;
          silenceStart = null;
          if (mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
            setTimeout(() => {
              if (listening && audioStream && audioStream.active) {
                audioChunks = [];
                try { mediaRecorder.start(1000); } catch(e) {}
              }
            }, 100);
          }
        }
      }
    }, 100);

  } catch (err) {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_MIC_ERROR',
      error: err.message,
    });
    window.__vcMicActive = false;
  }

  function stopCapture() {
    listening = false;
    window.__vcMicActive = false;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch(e) {}
    }
    if (audioStream) {
      audioStream.getTracks().forEach(t => t.stop());
      audioStream = null;
    }
  }
})();
