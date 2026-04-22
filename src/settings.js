/**
 * settings.js — Ablativo Settings window
 */

const { invoke } = window.__TAURI__.core;
const { listen }  = window.__TAURI__.event;

// ── State ─────────────────────────────────────────────────────────────────────

let pendingHotkey = null;
let captureMode   = false;

// ── Elements ──────────────────────────────────────────────────────────────────

const hotkeyDisplay = document.getElementById('hotkeyDisplay');
const hotkeyHint    = document.getElementById('hotkeyHint');
const modelStatus   = document.getElementById('modelStatus');
const downloadBtn   = document.getElementById('downloadBtn');
const historyList   = document.getElementById('historyList');
const saveBtn       = document.getElementById('saveBtn');

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const [settings, modelReady, history] = await Promise.all([
      invoke('get_settings'),
      invoke('check_model'),
      invoke('get_history'),
    ]);

    hotkeyDisplay.textContent = formatHotkey(settings.hotkey);
    updateModelUI(modelReady ? 'ready' : 'not-found');
    renderHistory(history);
  } catch (err) {
    console.error('[settings] init error:', err);
  }
}

// ── Model status ──────────────────────────────────────────────────────────────

function updateModelUI(status) {
  const labels = {
    'ready':       { text: '✓ Ready',       show: false },
    'not-found':   { text: 'Not downloaded', show: true  },
    'downloading': { text: 'Downloading…',  show: false },
    'extracting':  { text: 'Extracting…',   show: false },
    'error':       { text: 'Error — retry', show: true  },
  };
  const s = labels[status] || { text: status, show: false };
  modelStatus.textContent = s.text;
  downloadBtn.style.display = s.show ? 'block' : 'none';
}

// Listen for model status events from Rust
listen('model-status', (e) => updateModelUI(e.payload));
listen('model-ready',  ()  => updateModelUI('ready'));

downloadBtn.addEventListener('click', async () => {
  downloadBtn.disabled = true;
  try {
    await invoke('download_model');
  } catch (err) {
    console.error('[settings] download error:', err);
    updateModelUI('error');
    downloadBtn.disabled = false;
  }
});

// ── Hotkey capture ────────────────────────────────────────────────────────────

hotkeyDisplay.addEventListener('click', () => {
  if (captureMode) return;
  captureMode = true;
  hotkeyDisplay.textContent = 'Press shortcut…';
  hotkeyDisplay.classList.add('capturing');
  hotkeyHint.textContent = 'press Escape to cancel';
});

document.addEventListener('keydown', (e) => {
  if (!captureMode) return;
  e.preventDefault();

  if (e.code === 'Escape') {
    cancelCapture();
    return;
  }

  const modifierCodes = ['ControlLeft','ControlRight','AltLeft','AltRight',
                         'ShiftLeft','ShiftRight','MetaLeft','MetaRight'];
  if (modifierCodes.includes(e.code)) return;

  const parts = [];
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.altKey)   parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey)  parts.push('Meta');
  parts.push(codeToName(e.code));

  pendingHotkey = parts.join('+');
  hotkeyDisplay.textContent = formatHotkey(pendingHotkey);
  hotkeyDisplay.classList.remove('capturing');
  hotkeyHint.textContent = 'click to reconfigure';
  captureMode = false;
});

function cancelCapture() {
  captureMode = false;
  hotkeyDisplay.classList.remove('capturing');
  invoke('get_settings').then((s) => {
    hotkeyDisplay.textContent = formatHotkey(pendingHotkey || s.hotkey);
  });
  hotkeyHint.textContent = 'click to reconfigure';
}

// ── History ───────────────────────────────────────────────────────────────────

function renderHistory(items) {
  if (!items || items.length === 0) {
    historyList.innerHTML = '<li class="history-empty">No transcriptions yet.</li>';
    return;
  }

  historyList.innerHTML = '';
  items.forEach((text) => {
    const li = document.createElement('li');
    li.className = 'history-item';

    const span = document.createElement('span');
    span.className = 'history-text';
    span.textContent = text;
    span.title = text;

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-icon';
    copyBtn.title = 'Copy';
    copyBtn.textContent = '⎘';
    copyBtn.addEventListener('click', () => copyText(text));

    const pasteBtn = document.createElement('button');
    pasteBtn.className = 'btn-icon';
    pasteBtn.title = 'Paste';
    pasteBtn.textContent = '▶';
    pasteBtn.addEventListener('click', () => pasteText(text));

    actions.appendChild(copyBtn);
    actions.appendChild(pasteBtn);
    li.appendChild(span);
    li.appendChild(actions);
    historyList.appendChild(li);
  });
}

async function copyText(text) {
  try {
    await invoke('copy_to_clipboard', { text });
  } catch (err) {
    console.error('[settings] copy error:', err);
  }
}

async function pasteText(text) {
  try {
    await invoke('paste_from_history', { text });
  } catch (err) {
    console.error('[settings] paste error:', err);
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    if (pendingHotkey) {
      await invoke('set_hotkey', { hotkey: pendingHotkey });
      pendingHotkey = null;
    }
    saveBtn.textContent = 'Saved ✓';
    setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }, 1200);
  } catch (err) {
    console.error('[settings] save error:', err);
    saveBtn.textContent = 'Error — try again';
    saveBtn.disabled = false;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatHotkey(hotkey) {
  return hotkey.split('+').join(' + ');
}

function codeToName(code) {
  if (code.startsWith('Key'))   return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const names = {
    Space: 'Space', Enter: 'Enter', Escape: 'Escape',
    Tab: 'Tab', Backspace: 'Backspace',
    F1:'F1',F2:'F2',F3:'F3',F4:'F4',F5:'F5',F6:'F6',
    F7:'F7',F8:'F8',F9:'F9',F10:'F10',F11:'F11',F12:'F12',
    Minus:'Minus', Equal:'Equal',
  };
  return names[code] || code;
}

// ── Init ──────────────────────────────────────────────────────────────────────

init();
