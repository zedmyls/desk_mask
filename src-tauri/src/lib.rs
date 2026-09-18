use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaskSettings {
    color: String,
    transparency: u8,
}

struct MaskRuntime {
    settings: MaskSettings,
    visible: bool,
}
struct MaskState {
    runtime: Mutex<MaskRuntime>,
    visibility_generation: AtomicU64,
}

struct TrayState {
    status: MenuItem<tauri::Wry>,
    enable_mask: MenuItem<tauri::Wry>,
    disable_mask: MenuItem<tauri::Wry>,
}

fn update_tray_state(app: &AppHandle, visible: bool) {
    if let Some(tray) = app.try_state::<TrayState>() {
        let _ = tray.status.set_text(if visible {
            "遮罩：已开启"
        } else {
            "遮罩：已关闭"
        });
        let _ = tray.enable_mask.set_enabled(!visible);
        let _ = tray.disable_mask.set_enabled(visible);
        if let Some(icon) = app.tray_by_id("main-tray") {
            let _ = icon.set_tooltip(Some(if visible {
                "Desk Mask · 遮罩已开启"
            } else {
                "Desk Mask · 遮罩已关闭"
            }));
        }
    }
}

fn emit_settings(app: &AppHandle, settings: &MaskSettings) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = window.emit("mask-settings", settings);
        }
    }
}

fn create_overlays(app: &AppHandle) -> Result<(), String> {
    let monitors = app
        .available_monitors()
        .map_err(|error| error.to_string())?;
    for (index, monitor) in monitors.iter().enumerate() {
        let label = format!("overlay-{index}");
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        let scale_factor = monitor.scale_factor();
        let position = monitor.position().to_logical::<f64>(scale_factor);
        let size = monitor.size().to_logical::<f64>(scale_factor);
        let window =
            WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html?overlay=1".into()))
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .always_on_top(true)
                .visible_on_all_workspaces(true)
                .skip_taskbar(true)
                .focused(false)
                .focusable(false)
                .visible(false)
                .position(position.x, position.y)
                .inner_size(size.width, size.height)
                .build()
                .map_err(|error| error.to_string())?;
        window
            .set_ignore_cursor_events(true)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_mask_settings(state: State<'_, MaskState>) -> MaskSettings {
    state
        .runtime
        .lock()
        .expect("mask state poisoned")
        .settings
        .clone()
}
#[tauri::command]
fn get_mask_visible(state: State<'_, MaskState>) -> bool {
    state.runtime.lock().expect("mask state poisoned").visible
}
#[tauri::command]
fn update_mask_settings(app: AppHandle, state: State<'_, MaskState>, settings: MaskSettings) {
    state.runtime.lock().expect("mask state poisoned").settings = settings.clone();
    emit_settings(&app, &settings);
}

fn set_mask_visible_impl(app: AppHandle, state: &MaskState, visible: bool) -> Result<(), String> {
    if visible {
        create_overlays(&app)?;
    }
    state.runtime.lock().expect("mask state poisoned").visible = visible;
    let generation = state.visibility_generation.fetch_add(1, Ordering::SeqCst) + 1;
    update_tray_state(&app, visible);
    if let Some(main) = app.get_webview_window("main") {
        // The confirmation dialog belongs to the main webview. Keep that native
        // window above the native overlay; CSS z-index cannot cross windows.
        main.set_always_on_top(visible)
            .map_err(|error| error.to_string())?;
        let _ = main.emit("mask-status-changed", visible);
    }
    let mut windows = Vec::new();
    for (label, window) in app.webview_windows() {
        if label.starts_with("overlay-") {
            if visible {
                window.show().map_err(|error| error.to_string())?;
                let _ = window.emit("mask-visibility", true);
            } else {
                let _ = window.emit("mask-visibility", false);
                windows.push(window);
            }
        }
    }
    if !visible {
        let app_for_hide = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(700));
            let still_hidden = app_for_hide
                .try_state::<MaskState>()
                .map(|state| state.visibility_generation.load(Ordering::SeqCst) == generation)
                .unwrap_or(false);
            if still_hidden {
                for window in windows {
                    let _ = window.hide();
                }
            }
        });
    }
    Ok(())
}
#[tauri::command]
fn set_mask_visible(
    app: AppHandle,
    state: State<'_, MaskState>,
    visible: bool,
) -> Result<(), String> {
    set_mask_visible_impl(app, &state, visible).map_err(|error| {
        eprintln!(
            "Desk Mask: failed to {} mask: {error}",
            if visible { "show" } else { "hide" }
        );
        error
    })
}
#[tauri::command]
fn is_mask_visible(state: State<'_, MaskState>) -> bool {
    get_mask_visible(state)
}

/// The overlay webview can finish loading after the first visibility event was
/// emitted. Let it request a fresh snapshot so it cannot remain transparent
/// because that first event was missed (especially noticeable on Windows).
#[tauri::command]
fn overlay_ready(window: WebviewWindow, state: State<'_, MaskState>) -> Result<(), String> {
    if !window.label().starts_with("overlay-") {
        return Err("only overlay windows may request an overlay snapshot".into());
    }
    let runtime = state.runtime.lock().expect("mask state poisoned");
    window
        .emit("mask-settings", runtime.settings.clone())
        .map_err(|error| error.to_string())?;
    window
        .emit("mask-visibility", runtime.visible)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn refresh_overlays(app: AppHandle, state: State<'_, MaskState>) -> Result<(), String> {
    if !get_mask_visible(state.clone()) {
        return Ok(());
    }
    let monitors = app
        .available_monitors()
        .map_err(|error| error.to_string())?;
    for (label, window) in app.webview_windows() {
        let Some(index) = label
            .strip_prefix("overlay-")
            .and_then(|value| value.parse::<usize>().ok())
        else {
            continue;
        };
        let needs_rebuild = monitors.get(index).map_or(true, |monitor| {
            window.outer_position().ok() != Some(*monitor.position())
                || window.outer_size().ok() != Some(*monitor.size())
        });
        if needs_rebuild {
            window.destroy().map_err(|error| error.to_string())?;
        }
    }
    create_overlays(&app)?;
    for (label, window) in app.webview_windows() {
        if label.starts_with("overlay-") {
            window.show().map_err(|error| error.to_string())?;
            let _ = window.emit("mask-visibility", true);
        }
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(MaskState {
            runtime: Mutex::new(MaskRuntime {
                settings: MaskSettings {
                    color: "#000000".into(),
                    transparency: 65,
                },
                visible: false,
            }),
            visibility_generation: AtomicU64::new(0),
        })
        .setup(|app| {
            // Windows 上在 WebView 的 IPC 回调内首次创建子 WebView 可能阻塞。
            // 在应用启动阶段预创建隐藏遮罩窗口，后续开关只负责显示/隐藏。
            if let Err(error) = create_overlays(&app.handle()) {
                eprintln!("Desk Mask: failed to prepare overlay windows: {error}");
            }
            if std::env::args().any(|argument| argument == "--autostart") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let main_window = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = main_window.hide();
                    }
                });
            }
            let status = MenuItem::with_id(app, "status", "遮罩：已关闭", false, None::<&str>)?;
            let enable_mask =
                MenuItem::with_id(app, "enable-mask", "开启遮罩", true, None::<&str>)?;
            let disable_mask =
                MenuItem::with_id(app, "disable-mask", "关闭遮罩", false, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "打开 Desk Mask", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&status, &enable_mask, &disable_mask, &show, &quit])?;
            app.manage(TrayState {
                status,
                enable_mask,
                disable_mask,
            });
            let icon = app.default_window_icon().cloned().expect("应用图标缺失");
            TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .tooltip("Desk Mask · 遮罩已关闭")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "enable-mask" => {
                        let state = app.state::<MaskState>();
                        if let Err(error) = set_mask_visible_impl(app.clone(), &state, true) {
                            eprintln!("Desk Mask: failed to enable mask from tray: {error}");
                        }
                    }
                    "disable-mask" => {
                        let state = app.state::<MaskState>();
                        if let Err(error) = set_mask_visible_impl(app.clone(), &state, false) {
                            eprintln!("Desk Mask: failed to disable mask from tray: {error}");
                        }
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_mask_settings,
            get_mask_visible,
            update_mask_settings,
            set_mask_visible,
            is_mask_visible,
            overlay_ready,
            refresh_overlays
        ])
        .run(tauri::generate_context!())
        .expect("启动 Desk Mask 时发生错误");
}
