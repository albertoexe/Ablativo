use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

use arboard::Clipboard;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// ── Settings ──────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Settings {
    hotkey: String,
    model: String,
    language: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: "Ctrl+Space".into(),
            model: "ggml-base.en.bin".into(),
            language: "en".into(),
        }
    }
}

// ── Managed state ─────────────────────────────────────────────────────────────

struct WhisperBin(Mutex<Option<PathBuf>>);
struct ModelPath(Mutex<Option<PathBuf>>);
struct History(Mutex<VecDeque<String>>);
struct AppSettings(Mutex<Settings>);

// ── Window commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn show_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus(); // steal focus so Enter/Escape keyboard shortcuts work
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
    .inner_size(460.0, 560.0)
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

    // Unregister the current hotkey
    let current = settings.0.lock().unwrap().hotkey.clone();
    if let Ok(old) = parse_shortcut(&current) {
        let _ = app.global_shortcut().unregister(old);
    }

    // Register the new one
    app.global_shortcut()
        .on_shortcut(new_shortcut, |app, _sc, event| {
            if event.state() == ShortcutState::Pressed {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.emit("hotkey", ());
                }
            }
        })
        .map_err(|e| e.to_string())?;

    // Persist
    {
        let mut s = settings.0.lock().unwrap();
        s.hotkey = hotkey;
        save_settings(&app, &s)?;
    }
    Ok(())
}

#[tauri::command]
fn set_model(
    model: String,
    app: AppHandle,
    model_path: State<'_, ModelPath>,
    settings: State<'_, AppSettings>,
) -> Result<(), String> {
    let full_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models")
        .join(&model);

    if !full_path.exists() {
        return Err(format!("Model file not found: {}", full_path.display()));
    }

    *model_path.0.lock().unwrap() = Some(full_path);

    let mut s = settings.0.lock().unwrap();
    s.model = model;
    save_settings(&app, &s)?;

    Ok(())
}

#[tauri::command]
fn list_models(app: AppHandle) -> Vec<String> {
    let dir = match app.path().app_data_dir().ok().map(|d| d.join("models")) {
        Some(d) => d,
        None => return vec![],
    };
    match std::fs::read_dir(&dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".bin"))
            .collect(),
        Err(_) => vec![],
    }
}

// ── Binary + model resolution ─────────────────────────────────────────────────

fn resolve_whisper_bin(app: &AppHandle) -> Option<PathBuf> {
    // 1. Production: next to the exe (Tauri bundles sidecar here)
    if let Ok(exe) = std::env::current_exe() {
        for name in &["whisper-cli.exe", "whisper-cli-x86_64-pc-windows-msvc.exe"] {
            let p = exe.with_file_name(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    // 2. AppData — user placed the binary here
    if let Ok(data) = app.path().app_data_dir() {
        let p = data.join("whisper-cli.exe");
        if p.exists() {
            return Some(p);
        }
    }
    // 3. Dev: walk up from exe to find src-tauri/binaries/
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        for _ in 0..6 {
            if let Some(d) = dir {
                let candidate = d
                    .join("src-tauri")
                    .join("binaries")
                    .join("whisper-cli-x86_64-pc-windows-msvc.exe");
                if candidate.exists() {
                    return Some(candidate);
                }
                dir = d.parent().map(|p| p.to_path_buf());
            } else {
                break;
            }
        }
    }
    None
}

fn resolve_model_path(app: &AppHandle, model_name: &str) -> Option<PathBuf> {
    if let Ok(data) = app.path().app_data_dir() {
        let p = data.join("models").join(model_name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

// ── Settings persistence ──────────────────────────────────────────────────────

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("settings.json"))
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

// ── Transcription ─────────────────────────────────────────────────────────────

fn write_wav(path: &PathBuf, samples: &[f32], sample_rate: u32) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer.write_sample(v).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())
}

#[tauri::command]
fn transcribe(
    whisper_bin: State<'_, WhisperBin>,
    model_path: State<'_, ModelPath>,
    history: State<'_, History>,
    audio: Vec<f32>,
    language: String,
) -> Result<String, String> {
    let bin = whisper_bin.0.lock().unwrap();
    let bin = bin.as_ref().ok_or("whisper-cli not found")?;

    let model = model_path.0.lock().unwrap();
    let model = model.as_ref().ok_or("Model not found")?;

    let wav_path = std::env::temp_dir().join("ablativo_audio.wav");
    write_wav(&wav_path, &audio, 16_000)?;

    let lang_arg = if language == "auto" { "auto" } else { &language };
    let bin_dir  = bin.parent().unwrap_or(bin.as_path());

    let output = std::process::Command::new(bin)
        .args([
            "-m", model.to_str().unwrap(),
            "-f", wav_path.to_str().unwrap(),
            "-l", lang_arg,
            "-np", // suppress info — emit only transcript
            "-nt", // no timestamps
        ])
        .current_dir(bin_dir)
        .output()
        .map_err(|e| format!("Failed to spawn whisper-cli: {}", e))?;

    let _ = std::fs::remove_file(&wav_path);

    eprintln!(
        "[ablativo] whisper exit={} stdout={:?}",
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout)
    );

    if !output.status.success() {
        return Err(format!(
            "whisper-cli failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let text: String = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    // Append to history (max 5)
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

/// Set clipboard to text, hide pill, wait 150 ms, then simulate Ctrl+V.
#[tauri::command]
fn paste_text(text: String, app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    do_paste(text);
}

/// Close settings window, wait 250 ms for focus to return, then paste.
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

/// Just set the clipboard (no paste simulation).
#[tauri::command]
fn copy_to_clipboard(text: String) {
    set_clipboard(&text);
}

#[tauri::command]
fn get_history(history: State<'_, History>) -> Vec<String> {
    history.0.lock().unwrap().iter().cloned().collect()
}

fn do_paste(text: String) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        set_clipboard(&text);
        send_ctrl_v();
    });
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

// ── Internal helpers ──────────────────────────────────────────────────────────

fn toggle_pill(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        match w.is_visible() {
            Ok(true)  => { let _ = w.hide(); }
            Ok(false) => { let _ = w.show(); }
            Err(_)    => {}
        }
    }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_hide = MenuItemBuilder::with_id("show_hide", "Show / Hide").build(app)?;
    let settings  = MenuItemBuilder::with_id("settings",  "Settings…").build(app)?;
    let sep       = PredefinedMenuItem::separator(app)?;
    let quit      = MenuItemBuilder::with_id("quit",      "Quit Ablativo").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show_hide, &settings, &sep, &quit])
        .build()?;

    TrayIconBuilder::new()
        .icon(tauri::include_image!("icons/32x32.png"))
        .menu(&menu)
        .tooltip("Ablativo — Ctrl+Space to dictate")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show_hide" => toggle_pill(app),
            "settings"  => { let _ = open_settings(app.clone()); }
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(WhisperBin(Mutex::new(None)))
        .manage(ModelPath(Mutex::new(None)))
        .manage(History(Mutex::new(VecDeque::new())))
        .manage(AppSettings(Mutex::new(Settings::default())))
        .invoke_handler(tauri::generate_handler![
            show_window,
            hide_window,
            open_settings,
            transcribe,
            paste_text,
            paste_from_history,
            copy_to_clipboard,
            get_history,
            get_settings,
            set_hotkey,
            set_model,
            list_models,
        ])
        .setup(|app| {
            // Load persisted settings
            let settings = load_settings(app.handle());

            // Resolve binary
            let bin = resolve_whisper_bin(app.handle());
            *app.state::<WhisperBin>().0.lock().unwrap() = bin;

            // Resolve model from settings
            let model = resolve_model_path(app.handle(), &settings.model);
            *app.state::<ModelPath>().0.lock().unwrap() = model;

            // Store settings in state
            *app.state::<AppSettings>().0.lock().unwrap() = settings.clone();

            // Register hotkey from settings
            if let Err(e) = setup_shortcut_str(app, &settings.hotkey) {
                eprintln!("[ablativo] Shortcut registration failed: {}. Is another instance running?", e);
            }

            setup_tray(app)?;
            position_pill(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ablativo");
}
