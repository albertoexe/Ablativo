/**
 * settings.js — Ablativo Settings window
 *
 * Three panes: General (hotkey + autostart), Model, History.
 * All settings apply immediately — no Save button.
 */

const { invoke } = window.__TAURI__.core;
const { listen }  = window.__TAURI__.event;

// ── Elements ──────────────────────────────────────────────────────────────────

const hotkeyDisplay     = document.getElementById('hotkeyDisplay');
const hotkeyHint        = document.getElementById('hotkeyHint');
const hotkeyReset       = document.getElementById('hotkeyReset');
const enterToStopToggle = document.getElementById('enterToStopToggle');
const autostartToggle   = document.getElementById('autostartToggle');
const modelBadge        = document.getElementById('modelBadge');
const downloadBtn       = document.getElementById('downloadBtn');
const historyList       = document.getElementById('historyList');

// ── Tab navigation ────────────────────────────────────────────────────────────

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.pane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`pane-${btn.dataset.pane}`).classList.add('active');
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const [settings, modelReady, history, autostart] = await Promise.all([
      invoke('get_settings'),
      invoke('check_model'),
      invoke('get_history'),
      invoke('get_autostart'),
    ]);

    hotkeyDisplay.textContent    = formatHotkey(settings.hotkey);
    enterToStopToggle.checked    = settings.enter_to_stop !== false;
    autostartToggle.checked      = autostart;
    updateModelBadge(modelReady ? 'active' : 'not-found');
    renderHistory(history);
  } catch (err) {
    console.error('[settings] init error:', err);
  }
}

// ── Model status ──────────────────────────────────────────────────────────────

function updateModelBadge(status) {
  const states = {
    'active':       { text: '✓ Active',       cls: 'active',      download: false },
    'not-found':    { text: 'Not downloaded', cls: 'not-found',   download: true  },
    'downloading':  { text: 'Downloading…',   cls: 'downloading', download: false },
    'extracting':   { text: 'Extracting…',    cls: 'extracting',  download: false },
    'error':        { text: 'Error — retry',  cls: 'error',       download: true  },
    'checking':     { text: 'Checking…',      cls: 'checking',    download: false },
  };

  const s = states[status] ?? { text: status, cls: 'checking', download: false };

  modelBadge.textContent = s.text;
  modelBadge.className   = `model-badge ${s.cls}`;
  downloadBtn.style.display = s.download ? 'block' : 'none';
}

listen('model-status', (e) => updateModelBadge(e.payload));
listen('model-ready',  ()  => updateModelBadge('active'));

downloadBtn.addEventListener('click', async () => {
  downloadBtn.disabled = true;
  try {
    await invoke('download_model');
  } catch (err) {
    console.error('[settings] download error:', err);
    updateModelBadge('error');
    downloadBtn.disabled = false;
  }
});

// ── Hotkey capture — saves immediately on new shortcut ────────────────────────

let captureMode = false;

hotkeyDisplay.addEventListener('click', () => {
  if (captureMode) return;
  captureMode = true;
  hotkeyDisplay.textContent = 'Press shortcut…';
  hotkeyDisplay.classList.add('capturing');
  setHint('press Escape to cancel', '');
});

document.addEventListener('keydown', async (e) => {
  if (!captureMode) return;
  e.preventDefault();

  if (e.code === 'Escape') {
    cancelCapture();
    return;
  }

  // Ignore lone modifier keys
  const modifierCodes = [
    'ControlLeft','ControlRight','AltLeft','AltRight',
    'ShiftLeft','ShiftRight','MetaLeft','MetaRight',
  ];
  if (modifierCodes.includes(e.code)) return;

  const parts = [];
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.altKey)   parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey)  parts.push('Meta');
  parts.push(codeToName(e.code));

  const hotkey = parts.join('+');
  hotkeyDisplay.textContent = formatHotkey(hotkey);
  hotkeyDisplay.classList.remove('capturing');
  captureMode = false;

  // Save immediately — no Save button needed
  try {
    await invoke('set_hotkey', { hotkey });
    setHint('✓ Saved', 'saved', 1800);
  } catch (err) {
    console.error('[settings] set_hotkey error:', err);
    setHint('Error — try again', 'error', 2500);
    invoke('get_settings').then((s) => {
      hotkeyDisplay.textContent = formatHotkey(s.hotkey);
    }).catch(() => {});
  }
});

function cancelCapture() {
  captureMode = false;
  hotkeyDisplay.classList.remove('capturing');
  setHint('click to change', '');
  invoke('get_settings').then((s) => {
    hotkeyDisplay.textContent = formatHotkey(s.hotkey);
  }).catch(() => {});
}

let _hintTimer = null;

/** Set hint text + optional CSS state. Pass resetMs > 0 to auto-reset to "click to change". */
function setHint(text, state, resetMs = 0) {
  clearTimeout(_hintTimer);
  hotkeyHint.textContent = text;
  hotkeyHint.className   = `row-hint${state ? ` ${state}` : ''}`;
  if (resetMs > 0) {
    _hintTimer = setTimeout(() => setHint('click to change', ''), resetMs);
  }
}

// ── Hotkey reset button ───────────────────────────────────────────────────────

hotkeyReset.addEventListener('click', async () => {
  const DEFAULT = 'Ctrl+Space';
  try {
    await invoke('set_hotkey', { hotkey: DEFAULT });
    hotkeyDisplay.textContent = formatHotkey(DEFAULT);
    setHint('✓ Reset to default', 'saved', 1800);
  } catch (err) {
    console.error('[settings] reset error:', err);
    setHint('Error — try again', 'error', 2500);
  }
});

// ── Enter-to-stop toggle — applies immediately ────────────────────────────────

enterToStopToggle.addEventListener('change', async () => {
  try {
    await invoke('set_enter_to_stop', { value: enterToStopToggle.checked });
  } catch (err) {
    console.error('[settings] enter_to_stop error:', err);
    enterToStopToggle.checked = !enterToStopToggle.checked; // revert on failure
  }
});

// ── Autostart toggle — applies immediately ────────────────────────────────────

autostartToggle.addEventListener('change', async () => {
  try {
    await invoke('set_autostart', { enable: autostartToggle.checked });
  } catch (err) {
    console.error('[settings] autostart error:', err);
    autostartToggle.checked = !autostartToggle.checked; // revert on failure
  }
});

// ── History ───────────────────────────────────────────────────────────────────

function renderHistory(items) {
  if (!items || items.length === 0) {
    historyList.innerHTML = '<li class="history-empty">No transcriptions yet.</li>';
    return;
  }

  historyList.innerHTML = '';
  items.forEach((text) => {
    const li      = document.createElement('li');
    li.className  = 'history-item';

    const span    = document.createElement('span');
    span.className = 'history-text';
    span.textContent = text;
    span.title = text;

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    const copyBtn  = makeIconBtn('⎘', 'Copy',  () => copyText(text));
    const pasteBtn = makeIconBtn('▶', 'Paste', () => pasteText(text));

    actions.appendChild(copyBtn);
    actions.appendChild(pasteBtn);
    li.appendChild(span);
    li.appendChild(actions);
    historyList.appendChild(li);
  });
}

function makeIconBtn(label, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'btn-icon';
  btn.title = title;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

async function copyText(text) {
  try { await invoke('copy_to_clipboard', { text }); }
  catch (err) { console.error('[settings] copy error:', err); }
}

async function pasteText(text) {
  try { await invoke('paste_from_history', { text }); }
  catch (err) { console.error('[settings] paste error:', err); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatHotkey(hotkey) {
  return hotkey.split('+').join(' + ');
}

function codeToName(code) {
  if (code.startsWith('Key'))   return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map = {
    Space:'Space', Enter:'Enter', Escape:'Escape', Tab:'Tab', Backspace:'Backspace',
    Minus:'Minus', Equal:'Equal',
    F1:'F1',F2:'F2',F3:'F3',F4:'F4',F5:'F5',F6:'F6',
    F7:'F7',F8:'F8',F9:'F9',F10:'F10',F11:'F11',F12:'F12',
  };
  return map[code] ?? code;
}

// ── Init ──────────────────────────────────────────────────────────────────────

init();
