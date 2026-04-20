/**
 * settings.js — Ablativo Settings window
 */

const { invoke } = window.__TAURI__.core;

// ── State ─────────────────────────────────────────────────────────────────────

let pendingHotkey  = null; // null = unchanged
let pendingModel   = null; // null = unchanged
let captureMode    = false;

// ── Elements ──────────────────────────────────────────────────────────────────

const hotkeyDisplay = document.getElementById('hotkeyDisplay');
const hotkeyHint    = document.getElementById('hotkeyHint');
const modelSelect   = document.getElementById('modelSelect');
const historyList   = document.getElementById('historyList');
const saveBtn       = document.getElementById('saveBtn');

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const [settings, models, history] = await Promise.all([
      invoke('get_settings'),
      invoke('list_models'),
      invoke('get_history'),
    ]);

    // Hotkey
    hotkeyDisplay.textContent = formatHotkey(settings.hotkey);

    // Model picker
    modelSelect.innerHTML = '';
    if (models.length === 0) {
      modelSelect.innerHTML = '<option value="">No models found</option>';
    } else {
      models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = modelDisplayName(m);
        if (m === settings.model) opt.selected = true;
        modelSelect.appendChild(opt);
      });
    }

    // History
    renderHistory(history);
  } catch (err) {
    console.error('[settings] init error:', err);
  }
}

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

  // Escape cancels capture
  if (e.code === 'Escape') {
    cancelCapture();
    return;
  }

  // Ignore lone modifier keys
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
  // Restore current display (either pendingHotkey or saved hotkey)
  invoke('get_settings').then((s) => {
    hotkeyDisplay.textContent = formatHotkey(pendingHotkey || s.hotkey);
  });
  hotkeyHint.textContent = 'click to reconfigure';
}

// ── Model change ──────────────────────────────────────────────────────────────

modelSelect.addEventListener('change', () => {
  pendingModel = modelSelect.value;
});

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
    if (pendingModel) {
      await invoke('set_model', { model: pendingModel });
      pendingModel = null;
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

function modelDisplayName(filename) {
  return filename.replace(/^ggml-/, '').replace(/\.bin$/, '');
}

function codeToName(code) {
  if (code.startsWith('Key'))   return code.slice(3);   // KeyA → A
  if (code.startsWith('Digit')) return code.slice(5);   // Digit1 → 1
  const names = {
    Space: 'Space', Enter: 'Enter', Escape: 'Escape',
    Tab: 'Tab', Backspace: 'Backspace',
    F1:'F1',F2:'F2',F3:'F3',F4:'F4',F5:'F5',F6:'F6',
    F7:'F7',F8:'F8',F9:'F9',F10:'F10',F11:'F11',F12:'F12',
    Minus:'Minus', Equal:'Equal', BracketLeft:'[', BracketRight:']',
    Semicolon:';', Quote:"'", Comma:',', Period:'.', Slash:'/',
  };
  return names[code] || code;
}

// ── Init ──────────────────────────────────────────────────────────────────────

init();
