/**
 * audio.js — microphone capture + resampling to 16 kHz
 *
 * Uses MediaRecorder (well-supported in WebView2) for capture,
 * then decodes and resamples the result to 16 kHz PCM for Whisper.
 *
 * Usage:
 *   const analyser = await startRecording();
 *   // ... user speaks ...
 *   const pcm16k = await stopRecording();  // Float32Array at 16 kHz
 *   cancelRecording();                     // discard without output
 */

const TARGET_RATE = 16_000;

let mediaRecorder = null;
let stream       = null;
let analyser     = null;
let audioCtx     = null;
let chunks       = [];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Request mic access, start capturing audio.
 * Returns an AnalyserNode so the caller can drive the waveform UI.
 */
export async function startRecording() {
  chunks = [];

  stream   = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  audioCtx = new AudioContext();

  // AnalyserNode — for real-time waveform visualisation only (not capture)
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024; // more bins = better per-bar frequency resolution
  source.connect(analyser);

  // MediaRecorder — reliable in WebView2, replaces deprecated ScriptProcessorNode
  const mimeType = pickMimeType();
  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  // Collect data every 250 ms so we always have something even for short clips
  mediaRecorder.start(250);

  return analyser;
}

/**
 * Stop capture, decode + resample to 16 kHz, return Float32Array for Whisper.
 */
export function stopRecording() {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      resolve(null);
      return;
    }

    mediaRecorder.onstop = async () => {
      try {
        // Stop all mic tracks
        if (stream) stream.getTracks().forEach((t) => t.stop());

        if (chunks.length === 0) {
          resolve(null);
          return;
        }

        // Decode the recorded Blob → AudioBuffer
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        const arrayBuffer = await blob.arrayBuffer();

        const decodeCtx = new AudioContext();
        let decoded;
        try {
          decoded = await decodeCtx.decodeAudioData(arrayBuffer);
        } finally {
          await decodeCtx.close();
        }

        // Mix down to mono if stereo, then resample to 16 kHz
        const mono = mixDownToMono(decoded);
        const resampled = await resample(mono, decoded.sampleRate, TARGET_RATE);

        resolve(resampled); // Float32Array @ 16 kHz
      } catch (err) {
        reject(err);
      } finally {
        _cleanup();
      }
    };

    mediaRecorder.stop();
  });
}

/**
 * Discard current recording without producing output.
 */
export function cancelRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = null; // prevent the promise callback from firing
    mediaRecorder.stop();
  }
  _cleanup();
}

export function getAnalyser() {
  return analyser;
}

// ── Internal ──────────────────────────────────────────────────────────────────

/** Pick the best supported MIME type for MediaRecorder. */
function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || null;
}

/** Mix a possibly-stereo AudioBuffer down to a single Float32Array. */
function mixDownToMono(audioBuffer) {
  const ch = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  if (ch === 1) return audioBuffer.getChannelData(0);

  const out = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  for (let i = 0; i < len; i++) out[i] /= ch;
  return out;
}

/** Resample a Float32Array from fromRate to toRate via OfflineAudioContext. */
async function resample(data, fromRate, toRate) {
  if (fromRate === toRate) return data;

  const outLength = Math.ceil((data.length * toRate) / fromRate);
  const offCtx = new OfflineAudioContext(1, outLength, toRate);

  const buf = offCtx.createBuffer(1, data.length, fromRate);
  buf.getChannelData(0).set(data);

  const src = offCtx.createBufferSource();
  src.buffer = buf;
  src.connect(offCtx.destination);
  src.start(0);

  const rendered = await offCtx.startRendering();
  return rendered.getChannelData(0);
}

function _cleanup() {
  if (audioCtx) audioCtx.close();
  audioCtx     = null;
  stream       = null;
  analyser     = null;
  chunks       = [];
  mediaRecorder = null;
}
