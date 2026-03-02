/**
 * AudioWorklet processor for Voice Activity Detection (VAD).
 *
 * Runs off the main thread. Monitors RMS amplitude of audio frames
 * and sends messages when speech starts/stops.
 *
 * Usage:
 *   await audioContext.audioWorklet.addModule('lib/audio-worklet-processor.js');
 *   const vadNode = new AudioWorkletNode(audioContext, 'vad-processor');
 *   vadNode.port.onmessage = (e) => {
 *     if (e.data.type === 'speech_start') { ... }
 *     if (e.data.type === 'speech_end') { ... }
 *   };
 *   source.connect(vadNode);
 */

class VADProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.threshold = 0.015;    // RMS threshold for speech detection
    this.speechStartDelay = 200;   // ms of volume above threshold to trigger start
    this.silenceEndDelay = 800;    // ms of silence to trigger end

    this.isSpeech = false;
    this.speechStartTime = 0;
    this.silenceStartTime = 0;
    this.lastSpeechTime = 0;

    // Listen for threshold adjustments from main thread
    this.port.onmessage = (e) => {
      if (e.data.threshold !== undefined) {
        this.threshold = e.data.threshold;
      }
      if (e.data.silenceEndDelay !== undefined) {
        this.silenceEndDelay = e.data.silenceEndDelay;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    // Calculate RMS amplitude
    let sum = 0;
    for (let i = 0; i < channel.length; i++) {
      sum += channel[i] * channel[i];
    }
    const rms = Math.sqrt(sum / channel.length);
    const now = currentTime * 1000; // Convert to ms

    if (rms > this.threshold) {
      // Sound detected
      this.silenceStartTime = 0;

      if (!this.isSpeech) {
        if (!this.speechStartTime) {
          this.speechStartTime = now;
        } else if (now - this.speechStartTime >= this.speechStartDelay) {
          // Sustained speech — trigger start
          this.isSpeech = true;
          this.port.postMessage({ type: 'speech_start', time: now });
        }
      }

      this.lastSpeechTime = now;
    } else {
      // Silence
      this.speechStartTime = 0;

      if (this.isSpeech) {
        if (!this.silenceStartTime) {
          this.silenceStartTime = now;
        } else if (now - this.silenceStartTime >= this.silenceEndDelay) {
          // Sustained silence — trigger end
          this.isSpeech = false;
          this.port.postMessage({ type: 'speech_end', time: now, duration: now - this.lastSpeechTime });
          this.silenceStartTime = 0;
        }
      }
    }

    // Periodically send volume level for visualization
    this.port.postMessage({ type: 'volume', rms, isSpeech: this.isSpeech });

    return true; // Keep processor alive
  }
}

registerProcessor('vad-processor', VADProcessor);
