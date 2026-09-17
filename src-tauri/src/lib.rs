use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
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
    // 让过期的淡出任务失效，避免快速开关时旧任务隐藏新遮罩。
    visibility_generation: AtomicU64,
}

fn emit_settings(app: &AppHandle, settings: &MaskSettings) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = window.emit("mask-settings", settings);
        }
    }
}

fn create_overlays(app: &AppHandle, settings: &MaskSettings) -> Result<(), String> {
    let monitors = app
        .available_monitors()
        .map_err(|error| error.to_string())?;
    for (index, monitor) in monitors.iter().enumerate() {
        let label = format!("overlay-{index}");
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        // Builder 使用逻辑像素；显示器 API 返回物理像素。
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
                // 遮罩只能显示，绝不能抢走用户正在使用的窗口焦点。
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
        // 新 WebView 会主动读取状态；不能依赖此刻的事件，因为监听器尚未就绪。
        let _ = window.emit("mask-settings", settings);
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
    let settings = state
        .runtime
        .lock()
        .expect("mask state poisoned")
        .settings
        .clone();
    // 创建失败时不能把状态误标成“已显示”。
    if visible {
        create_overlays(&app, &settings)?;
    }
    state.runtime.lock().expect("mask state poisoned").visible = visible;
    let generation = state.visibility_generation.fetch_add(1, Ordering::SeqCst) + 1;
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
            let current_generation = app_for_hide
                .try_state::<MaskState>()
                .map(|state| state.visibility_generation.load(Ordering::SeqCst));
            if current_generation == Some(generation) {
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
    set_mask_visible_impl(app, &state, visible)
}

#[tauri::command]
fn is_mask_visible(state: State<'_, MaskState>) -> bool {
    get_mask_visible(state)
}

/// 仅在显示器布局变化时重建遮罩窗口，避免持续移动/缩放窗口。
#[tauri::command]
fn refresh_overlays(app: AppHandle, state: State<'_, MaskState>) -> Result<(), String> {
    if !state.runtime.lock().expect("mask state poisoned").visible {
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
    let settings = state
        .runtime
        .lock()
        .expect("mask state poisoned")
        .settings
        .clone();
    create_overlays(&app, &settings)?;
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
            // 开机启动时隐藏主窗口，但保留 WebView 来维持定时任务和快捷键。
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
            let show = MenuItem::with_id(app, "show", "打开 Desk Mask", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let icon = app.default_window_icon().cloned().expect("应用图标缺失");
            TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .tooltip("Desk Mask")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
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
            refresh_overlays
        ])
        .run(tauri::generate_context!())
        .expect("启动 Desk Mask 时发生错误");
}
