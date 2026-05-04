use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

use arboard::Clipboard;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use transcribe_rs::onnx::parakeet::{ParakeetModel, ParakeetParams, TimestampGranularity};
use transcribe_rs::onnx::Quantization;

// ── Constants ─────────────────────────────────────────────────────────────────

const MODEL_URL: &str = "https://blob.handy.computer/parakeet-v3-int8.tar.gz";
const MODEL_DIR_NAME: &str = "parakeet-tdt-0.6b-v3-int8";

// ── Settings ──────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Settings {
    hotkey: String,
    /// Language hint passed to the transcription frontend.
    /// Parakeet auto-detects language so this is stored but not used by the engine.
    #[serde(default = "default_language")]
    language: String,
    /// Whether pressing Enter while recording stops and transcribes.
    #[serde(default = "default_enter_to_stop")]
    enter_to_stop: bool,
}

fn default_language()     -> String { "auto".into() }
fn default_enter_to_stop() -> bool  { true }

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey:         "Ctrl+Space".into(),
            language:       default_language(),
            enter_to_stop:  default_enter_to_stop(),
        }
    }
}

// ── Managed state ─────────────────────────────────────────────────────────────

struct ParakeetEngine(Mutex<Option<ParakeetModel>>);
struct History(Mutex<VecDeque<String>>);
struct AppSettings(Mutex<Settings>);

// ── Model helpers ─────────────────────────────────────────────────────────────

fn model_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("models").join(MODEL_DIR_NAME))
}

/// Load Parakeet from disk into state. Call from a background thread.
fn try_load_model(app: &AppHandle) {
    if let Some(path) = model_dir(app) {
        if path.exists() {
            eprintln!("[ablativo] loading Parakeet V3 from {:?}", path);
            match ParakeetModel::load(&path, &Quantization::Int8) {
                Ok(model) => {
                    *app.state::<ParakeetEngine>().0.lock().unwrap() = Some(model);
                    eprintln!("[ablativo] Parakeet V3 ready ✓");
                    let _ = app.emit("model-ready", ());
                }
                Err(e) => {
                    eprintln!("[ablativo] model load failed: {}", e);
                    let _ = app.emit("model-status", "error");
                }
            }
        } else {
            eprintln!("[ablativo] model not found at {:?}", path);
            let _ = app.emit("model-status", "not-found");
        }
    }
}

// ── Model commands ────────────────────────────────────────────────────────────

/// Returns true if the Parakeet model directory exists on disk.
#[tauri::command]
fn check_model(app: AppHandle) -> bool {
    model_dir(&app).map(|p| p.exists()).unwrap_or(false)
}

/// Download + extract Parakeet V3 from Handy's blob storage.
/// Runs in a background thread; emits model-status events to the frontend.
#[tauri::command]
fn download_model(app: AppHandle) -> Result<(), String> {
    let models_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");

    std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        eprintln!("[ablativo] downloading Parakeet V3 (~456 MB)...");
        let _ = app.emit("model-status", "downloading");

        // Download to temp file via curl.exe (built into Windows 10+, no timeout, shows progress)
        let tar_path = std::env::temp_dir().join("parakeet-v3-int8.tar.gz");

        let dl = std::process::Command::new("curl")
            .args([
                "--location",           // follow redirects
                "--progress-bar",       // show download progress in terminal
                "--retry", "99",        // keep retrying until done
                "--retry-delay", "5",   // wait 5s between retries
                "--retry-all-errors",   // retry on ALL errors including connection resets
                "--output", tar_path.to_str().unwrap_or(""),
                MODEL_URL,
            ])
            .status();

        match dl {
            Ok(s) if s.success() => {}
            Ok(s) => {
                eprintln!("[ablativo] curl failed, exit code: {:?}", s.code());
                let _ = app.emit("model-status", "error");
                return;
            }
            Err(e) => {
                eprintln!("[ablativo] curl not found: {}", e);
                let _ = app.emit("model-status", "error");
                return;
            }
        }

        eprintln!("[ablativo] download done, extracting...");
        let _ = app.emit("model-status", "extracting");

        // Delete partial previous extraction if any
        let model_path = models_dir.join(MODEL_DIR_NAME);
        if model_path.exists() {
            let _ = std::fs::remove_dir_all(&model_path);
        }

        // Extract using Windows built-in tar.exe (fast, reliable, handles .tar.gz natively)
        let extract = std::process::Command::new("tar")
            .args([
                "-xzf", tar_path.to_str().unwrap_or(""),
                "-C",   models_dir.to_str().unwrap_or(""),
            ])
            .status();

        let _ = std::fs::remove_file(&tar_path); // clean up temp file regardless

        match extract {
            Ok(s) if s.success() => {
                eprintln!("[ablativo] extraction done, loading model...");
                try_load_model(&app);
            }
            Ok(s) => {
                eprintln!("[ablativo] tar extraction failed, exit code: {:?}", s.code());
                let _ = app.emit("model-status", "error");
            }
            Err(e) => {
                eprintln!("[ablativo] tar not found: {}", e);
                let _ = app.emit("model-status", "error");
            }
        }
    });

    Ok(())
}

// ── Window commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn show_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("Ablativo")
    .inner_size(500.0, 500.0)
    .resizable(false)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Settings commands ─────────────────────────────────────────────────────────

#[tauri::command]
fn get_settings(settings: State<'_, AppSettings>) -> Settings {
    settings.0.lock().unwrap().clone()
}

#[tauri::command]
fn set_hotkey(
    hotkey: String,
    app: AppHandle,
    settings: State<'_, AppSettings>,
) -> Result<(), String> {
    let new_shortcut = parse_shortcut(&hotkey)?;

    let current = settings.0.lock().unwrap().hotkey.clone();
    if let Ok(old) = parse_shortcut(&current) {
        let _ = app.global_shortcut().unregister(old);
    }

    app.global_shortcut()
        .on_shortcut(new_shortcut, |app, _sc, event| {
            if event.state() == ShortcutState::Pressed {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.emit("hotkey", ());
                }
            }
        })
        .map_err(|e| e.to_string())?;

    let updated = {
        let mut s = settings.0.lock().unwrap();
        s.hotkey = hotkey;
        save_settings(&app, &s)?;
        s.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(())
}

#[tauri::command]
fn set_enter_to_stop(
    value: bool,
    app: AppHandle,
    settings: State<'_, AppSettings>,
) -> Result<(), String> {
    let updated = {
        let mut s = settings.0.lock().unwrap();
        s.enter_to_stop = value;
        save_settings(&app, &s)?;
        s.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(())
}

// ── Transcription ─────────────────────────────────────────────────────────────

/// Transcribe a Vec<f32> of 16 kHz mono PCM samples using Parakeet V3.
/// `language` is accepted for API compatibility but ignored — Parakeet auto-detects.
#[tauri::command]
fn transcribe(
    engine: State<'_, ParakeetEngine>,
    history: State<'_, History>,
    audio: Vec<f32>,
    language: String,
) -> Result<String, String> {
    let _ = language; // Parakeet auto-detects — no manual selection needed

    let mut guard = engine.0.lock().unwrap();
    let model = guard
        .as_mut()
        .ok_or("Model not loaded. Open tray → Download model.")?;

    let params = ParakeetParams {
        timestamp_granularity: Some(TimestampGranularity::Segment),
        ..Default::default()
    };

    // Wrap in catch_unwind so a model panic doesn't poison the Mutex
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        model.transcribe_with(&audio, &params)
    }))
    .map_err(|_| "Transcription panicked".to_string())?
    .map_err(|e| format!("Transcription failed: {}", e))?;

    let text = result.text.trim().to_string();

    if !text.is_empty() {
        let mut h = history.0.lock().unwrap();
        h.push_front(text.clone());
        if h.len() > 5 {
            h.pop_back();
        }
    }

    Ok(text)
}

// ── Clipboard / paste ─────────────────────────────────────────────────────────

#[tauri::command]
fn paste_text(text: String, app: AppHandle) {
    // Hide the pill immediately so focus returns to the target window,
    // then paste after the OS has had time to restore focus.
    // Emits 'paste-done' after paste completes so the frontend resets state.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        set_clipboard(&text);
        send_ctrl_v();
        std::thread::sleep(std::time::Duration::from_millis(100));
        let _ = app.emit("paste-done", ());
    });
}

#[tauri::command]
fn paste_from_history(text: String, app: AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.close();
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        set_clipboard(&text);
        send_ctrl_v();
    });
}

#[tauri::command]
fn copy_to_clipboard(text: String) {
    set_clipboard(&text);
}

// ── Autostart ─────────────────────────────────────────────────────────────────

/// Returns true if Ablativo is registered to launch on login.
#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Enable or disable launch-on-login. Writes directly to the OS (registry on
/// Windows, launchd on macOS) — no settings.json involved.
#[tauri::command]
fn set_autostart(enable: bool, app: AppHandle) -> Result<(), String> {
    if enable {
        app.autolaunch().enable().map_err(|e| e.to_string())
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn get_history(history: State<'_, History>) -> Vec<String> {
    history.0.lock().unwrap().iter().cloned().collect()
}

fn set_clipboard(text: &str) {
    if let Ok(mut cb) = Clipboard::new() {
        let _ = cb.set_text(text);
    }
}

fn send_ctrl_v() {
    std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; \
             [System.Windows.Forms.SendKeys]::SendWait('^v')",
        ])
        .spawn()
        .ok();
}

// ── Settings persistence ──────────────────────────────────────────────────────

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    if let Some(path) = settings_path(app) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(s) = serde_json::from_str::<Settings>(&text) {
                return s;
            }
        }
    }
    Settings::default()
}

fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    if let Some(path) = settings_path(app) {
        let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Hotkey parser ─────────────────────────────────────────────────────────────

fn parse_shortcut(s: &str) -> Result<Shortcut, String> {
    let mut mods = Modifiers::empty();
    let mut code: Option<Code> = None;

    for part in s.split('+') {
        match part.trim() {
            "Ctrl" | "Control" => mods |= Modifiers::CONTROL,
            "Alt"              => mods |= Modifiers::ALT,
            "Shift"            => mods |= Modifiers::SHIFT,
            "Meta" | "Win" | "Cmd" | "Super" => mods |= Modifiers::SUPER,
            "Space"     => code = Some(Code::Space),
            "Enter"     => code = Some(Code::Enter),
            "Escape"    => code = Some(Code::Escape),
            "Tab"       => code = Some(Code::Tab),
            "Backspace" => code = Some(Code::Backspace),
            "Minus"     => code = Some(Code::Minus),
            "Equal"     => code = Some(Code::Equal),
            "F1"  => code = Some(Code::F1),  "F2"  => code = Some(Code::F2),
            "F3"  => code = Some(Code::F3),  "F4"  => code = Some(Code::F4),
            "F5"  => code = Some(Code::F5),  "F6"  => code = Some(Code::F6),
            "F7"  => code = Some(Code::F7),  "F8"  => code = Some(Code::F8),
            "F9"  => code = Some(Code::F9),  "F10" => code = Some(Code::F10),
            "F11" => code = Some(Code::F11), "F12" => code = Some(Code::F12),
            single if single.len() == 1 => {
                code = Some(match single.to_ascii_uppercase().chars().next().unwrap() {
                    'A' => Code::KeyA, 'B' => Code::KeyB, 'C' => Code::KeyC,
                    'D' => Code::KeyD, 'E' => Code::KeyE, 'F' => Code::KeyF,
                    'G' => Code::KeyG, 'H' => Code::KeyH, 'I' => Code::KeyI,
                    'J' => Code::KeyJ, 'K' => Code::KeyK, 'L' => Code::KeyL,
                    'M' => Code::KeyM, 'N' => Code::KeyN, 'O' => Code::KeyO,
                    'P' => Code::KeyP, 'Q' => Code::KeyQ, 'R' => Code::KeyR,
                    'S' => Code::KeyS, 'T' => Code::KeyT, 'U' => Code::KeyU,
                    'V' => Code::KeyV, 'W' => Code::KeyW, 'X' => Code::KeyX,
                    'Y' => Code::KeyY, 'Z' => Code::KeyZ,
                    '0' => Code::Digit0, '1' => Code::Digit1, '2' => Code::Digit2,
                    '3' => Code::Digit3, '4' => Code::Digit4, '5' => Code::Digit5,
                    '6' => Code::Digit6, '7' => Code::Digit7, '8' => Code::Digit8,
                    '9' => Code::Digit9,
                    c => return Err(format!("Unknown key: '{}'", c)),
                });
            }
            other => return Err(format!("Unknown key: '{}'", other)),
        }
    }

    let code = code.ok_or_else(|| "No key specified (add a non-modifier key)".to_string())?;
    Ok(Shortcut::new(if mods.is_empty() { None } else { Some(mods) }, code))
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn toggle_pill(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        match w.is_visible() {
            Ok(true)  => { let _ = w.hide(); }
            Ok(false) => { let _ = w.show(); let _ = w.set_focus(); }
            Err(_)    => {}
        }
    }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_hide = MenuItemBuilder::with_id("show_hide", "Show / Hide").build(app)?;
    let settings  = MenuItemBuilder::with_id("settings",  "Settings…").build(app)?;
    let download  = MenuItemBuilder::with_id("download",  "Download model").build(app)?;
    let sep       = PredefinedMenuItem::separator(app)?;
    let quit      = MenuItemBuilder::with_id("quit",      "Quit Ablativo").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&show_hide, &settings, &download, &sep, &quit])
        .build()?;

    TrayIconBuilder::new()
        .icon(tauri::include_image!("icons/32x32.png"))
        .menu(&menu)
        .tooltip("Ablativo — Ctrl+Space to dictate")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show_hide" => toggle_pill(app),
            "settings"  => { let _ = open_settings(app.clone()); }
            "download"  => { let _ = download_model(app.clone()); }
            "quit"      => app.exit(0),
            _           => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_pill(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn setup_shortcut_str(
    app: &mut tauri::App,
    hotkey: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let shortcut = parse_shortcut(hotkey).map_err(|e| e.to_string())?;
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _sc, event| {
            if event.state() == ShortcutState::Pressed {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.emit("hotkey", ());
                }
            }
        })?;
    Ok(())
}

fn position_pill(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(Some(monitor)) = window.primary_monitor() {
            let screen = monitor.size();
            let win_w: i32 = 320;
            let win_h: i32 = 64;
            let x = (screen.width as i32 - win_w) / 2;
            let y = screen.height as i32 - win_h - 80;
            window.set_position(tauri::PhysicalPosition::new(x, y))?;
        }
    }
    Ok(())
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(ParakeetEngine(Mutex::new(None)))
        .manage(History(Mutex::new(VecDeque::new())))
        .manage(AppSettings(Mutex::new(Settings::default())))
        .invoke_handler(tauri::generate_handler![
            show_window,
            hide_window,
            open_settings,
            check_model,
            download_model,
            transcribe,
            paste_text,
            paste_from_history,
            copy_to_clipboard,
            get_history,
            get_settings,
            set_hotkey,
            set_enter_to_stop,
            get_autostart,
            set_autostart,
        ])
        .setup(|app| {
            let settings = load_settings(app.handle());
            *app.state::<AppSettings>().0.lock().unwrap() = settings.clone();

            if let Err(e) = setup_shortcut_str(app, &settings.hotkey) {
                eprintln!("[ablativo] Shortcut failed: {}. Another instance running?", e);
            }

            setup_tray(app)?;
            position_pill(app)?;

            // Load Parakeet model in background — non-blocking startup
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                try_load_model(&app_handle);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ablativo");
}
