/**
 * main.js — Ablativo frontend state machine
 *
 * State machine:
 *   idle  ──[hotkey]──▶  recording  ──[hotkey / Enter]──▶  transcribing
 *                  ◀──[Escape]──          ──[done / error]──▶  idle (+ paste)
 *
 * Transcription is handled by whisper-cli sidecar (Rust side).
 * No model warmup needed — subprocess is spawned per recording.
 */

import { startRecording, stopRecording, cancelRecording } from './audio.js';

const { invoke } = window.__TAURI__.core;
const { listen }  = window.__TAURI__.event;

// ── State ─────────────────────────────────────────────────────────────────────

let state = 'idle'; // 'idle' | 'recording' | 'transcribing'
let rafId = null;

const pill = document.getElementById('pill');
let LANGUAGE = 'en'; // updated from settings on boot

// Fetch persisted language from settings (best-effort — defaults to 'en')
invoke('get_settings').then((s) => { LANGUAGE = s.language || 'en'; }).catch(() => {});

// ── State machine ─────────────────────────────────────────────────────────────

function setState(newState) {
  state = newState;
  pill.className = newState === 'idle' ? 'recording' : newState;
}

async function startCapture() {
  if (state !== 'idle') return;

  await invoke('show_window');
  setState('recording');

  try {
    const analyser = await startRecording();
    animateWaveform(analyser);
  } catch (err) {
    console.error('[ablativo] mic error:', err);
    await invoke('hide_window');
    setState('idle');
  }
}

async function finishCapture() {
  if (state !== 'recording') return;

  cancelAnimationFrame(rafId);
  setState('transcribing');

  let audio;
  try {
    audio = await stopRecording();
  } catch (err) {
    console.error('[ablativo] stop error:', err);
    await invoke('hide_window');
    setState('idle');
    return;
  }

  if (!audio || audio.length < 1600) {
    // Less than 0.1s — nothing to transcribe
    await invoke('hide_window');
    setState('idle');
    return;
  }

  try {
    const text = await invoke('transcribe', {
      audio: Array.from(audio), // Vec<f32> on the Rust side
      language: LANGUAGE,
    });

    if (text && text.trim()) {
      await invoke('paste_text', { text: text.trim() }); // paste_text also hides the window
    } else {
      await invoke('hide_window');
    }
  } catch (err) {
    console.error('[ablativo] transcribe error:', err);
    await invoke('hide_window');
  }

  setState('idle');
}

async function cancelCapture() {
  if (state === 'idle') return;
  cancelAnimationFrame(rafId);
  cancelRecording();
  await invoke('hide_window');
  setState('idle');
}

// ── Waveform ──────────────────────────────────────────────────────────────────

function animateWaveform(analyser) {
  const bars = pill.querySelectorAll('.waveform span');
  const data = new Uint8Array(analyser.frequencyBinCount);

  function draw() {
    rafId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(data);
    bars.forEach((bar, i) => {
      const idx = Math.floor((i * data.length) / bars.length);
      const h   = Math.max(4, (data[idx] / 255) * 22);
      bar.style.height = `${h}px`;
    });
  }
  draw();
}

// ── Rust events ───────────────────────────────────────────────────────────────

listen('hotkey', async () => {
  if (state === 'idle')      await startCapture();
  else if (state === 'recording') await finishCapture();
  // ignore if transcribing
});

// ── Keyboard ──────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && state === 'recording') {
    e.preventDefault();
    finishCapture();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelCapture();
  }
});
