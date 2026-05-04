# Ablativo

Press a hotkey from anywhere — WhatsApp, browser, email, anything — speak, and get clean transcribed text pasted directly into whatever you were typing. Everything runs locally. No cloud, no API keys, full privacy.

Built with [Tauri v2](https://tauri.app) (Rust + HTML/CSS/JS). Windows and macOS.

---

## Download

Go to [**Releases**](../../releases/latest) and download the installer for your platform:

| Platform | File |
|---|---|
| Windows | `Ablativo_x64-setup.exe` (NSIS) or `Ablativo_x64_en-US.msi` |
| macOS Apple Silicon | `Ablativo_aarch64.dmg` |
| macOS Intel | `Ablativo_x64.dmg` |

> **macOS note:** Builds are unsigned. On first launch, right-click the app → Open to bypass Gatekeeper. Then it works normally from the dock and login.

---

## First Run

1. Install and launch Ablativo — a tray icon appears.
2. Open **Settings** from the tray icon.
3. Click **Download model** to fetch Parakeet V3 (~456 MB, one-time).
4. Wait for "✓ Ready" — transcription is live.

---

## Usage

| Action | What happens |
|---|---|
| `Ctrl+Space` | Start recording |
| `Ctrl+Space` again or `Enter` | Stop → transcribe → paste |
| `Escape` | Cancel recording |

The floating pill shows what's happening:
- **Spinner** — microphone initialising
- **Bars** — recording (reacts to your voice)
- **Dots** — transcribing

Text is pasted directly into whatever app was focused before you pressed the hotkey.

---

## Settings

Open from the tray icon → Settings:

- **Hotkey** — click the badge, press your preferred shortcut, Save
- **Launch on login** — toggle on to start Ablativo automatically at login
- **Model** — download status and re-download button
- **History** — last 5 transcriptions; click ▶ to re-paste, ⎘ to copy

---

## How It Works

- **Frontend:** HTML/CSS/JS in a frameless transparent Tauri window
- **Audio capture:** Web Audio API (`MediaRecorder` → 16 kHz PCM via `OfflineAudioContext`)
- **Transcription:** [Parakeet V3](https://github.com/cjpais/handy) int8-quantised ONNX model via [`transcribe-rs`](https://crates.io/crates/transcribe-rs), running fully on-device
- **Paste:** clipboard + simulated `Ctrl+V` via PowerShell (Windows) / AppleScript (macOS)
- **Hotkey:** system-wide via `tauri-plugin-global-shortcut`

---

## Build from Source

Prerequisites: [Rust](https://rustup.rs), [Node.js LTS](https://nodejs.org), [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
git clone https://github.com/YOUR_USERNAME/ablativo.git
cd ablativo
npm install
npm run dev        # development (hot-reload)
npm run build      # production installer → src-tauri/target/release/bundle/
```

---

## Release a New Version

```bash
git tag v1.2.0
git push origin v1.2.0
```

GitHub Actions builds Windows + macOS installers and publishes them to a new GitHub Release automatically.

---

## License

MIT
