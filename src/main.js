/**
 * main.js — Ablativo frontend state machine
 *
 * State machine:
 *   idle  ──[hotkey]──▶  loading  ──[mic ready]──▶  recording
 *                 ◀──[Escape]──    ──[hotkey / Enter]──▶  transcribing
 *                                  ──[paste-done]──▶  idle
 *
 * All animation is handled by PillAnimator (canvas-based).
 * Rust emits 'paste-done' after clipboard paste completes, which drives
 * the final transition back to idle so the dots show until text lands.
 */

import { startRecording, stopRecording, cancelRecording } from './audio.js';
import { PillAnimator } from './animator.js';

const { invoke } = window.__TAURI__.core;
const { listen }  = window.__TAURI__.event;

// ── Elements & animator ───────────────────────────────────────────────────────

const pill    = document.getElementById('pill');
const canvas  = document.getElementById('pill-canvas');
const anim    = new PillAnimator(canvas);

// ── State ─────────────────────────────────────────────────────────────────────

let state        = 'idle'; // 'idle' | 'loading' | 'recording' | 'transcribing'
let LANGUAGE     = 'en';
let enterToStop  = true;  // mirrors Settings.enter_to_stop

invoke('get_settings').then((s) => {
  LANGUAGE    = s.language      || 'en';
  enterToStop = s.enter_to_stop !== false; // default true
}).catch(() => {});

// Keep in sync when changed from the Settings window
listen('settings-changed', (e) => {
  if (e.payload && typeof e.payload.enter_to_stop === 'boolean') {
    enterToStop = e.payload.enter_to_stop;
  }
});

// ── State machine ─────────────────────────────────────────────────────────────

function setState(newState) {
  state = newState;

  // Pill class drives CSS (glass effect on transcribing, etc.)
  pill.className = newState === 'idle' ? 'loading' : newState;

  // Sync animator — recording handled separately (needs analyser node)
  switch (newState) {
    case 'idle':
    case 'loading':
      anim.setLoading();
      break;
    case 'transcribing':
      anim.setTranscribing();
      break;
    // 'recording' is set explicitly in startCapture after analyser is ready
  }
}

async function startCapture() {
  if (state !== 'idle') return;

  await invoke('show_window');
  setState('loading');                // spinner while getUserMedia initialises

  try {
    const analyser = await startRecording();
    state          = 'recording';
    pill.className = 'recording';
    anim.setRecording(analyser);      // animator transitions spinner → waveform
  } catch (err) {
    console.error('[ablativo] mic error:', err);
    await invoke('hide_window');
    setState('idle');
  }
}

async function finishCapture() {
  if (state !== 'recording') return;

  setState('transcribing');           // animator transitions waveform → dots

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
    // Less than 0.1 s — nothing to transcribe
    await invoke('hide_window');
    setState('idle');
    return;
  }

  try {
    const text = await invoke('transcribe', {
      audio: Array.from(audio),   // Vec<f32> on the Rust side
      language: LANGUAGE,
    });

    if (text && text.trim()) {
      // paste_text hides the window and emits 'paste-done' after paste completes.
      // Do NOT call setState('idle') here — wait for the event so the dots
      // keep showing right up until the text lands in the target app.
      await invoke('paste_text', { text: text.trim() });
    } else {
      await invoke('hide_window');
      setState('idle');
    }
  } catch (err) {
    console.error('[ablativo] transcribe error:', err);
    await invoke('hide_window');
    setState('idle');
  }
}

async function cancelCapture() {
  if (state === 'idle') return;
  cancelRecording();
  await invoke('hide_window');
  setState('idle');
}

// ── Rust events ───────────────────────────────────────────────────────────────

listen('hotkey', async () => {
  if (state === 'idle')           await startCapture();
  else if (state === 'recording') await finishCapture();
  // ignore if loading or transcribing
});

// Fired by Rust after paste completes — resets state so next hotkey works
listen('paste-done', () => {
  setState('idle');
});

// ── Keyboard ──────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && enterToStop && state === 'recording') {
    e.preventDefault();
    finishCapture();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelCapture();
  }
});
