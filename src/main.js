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
  setState('loading');                // spinner while mic opens

  try {
    await invoke('start_recording');  // opens cpal mic — native, no browser API
    state          = 'recording';
    pill.className = 'recording';
    anim.setRecording();              // animator transitions spinner → waveform
  } catch (err) {
    console.error('[ablativo] mic error:', err);
    pill.className = 'error';
    anim.setError?.();
    await new Promise((r) => setTimeout(r, 1200));
    await invoke('hide_window');
    setState('idle');
  }
}

async function finishCapture() {
  if (state !== 'recording') return;

  setState('transcribing');           // animator transitions waveform → dots

  try {
    // Rust stops capture, resamples, transcribes, and pastes — all in one call.
    // Audio never crosses the IPC bridge as JSON. Blocks until transcription done.
    // Rust emits 'paste-done' when text lands (or immediately if nothing to paste).
    await invoke('stop_and_transcribe');
  } catch (err) {
    console.error('[ablativo] transcribe error:', err);
    await invoke('hide_window');
    setState('idle');
  }
}

async function cancelCapture() {
  if (state === 'idle') return;
  invoke('cancel_recording');         // fire-and-forget — no audio to return
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

// RMS level from the native audio thread — drives waveform bars while recording
listen('audio-level', (e) => {
  anim.setLevel(e.payload);
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
