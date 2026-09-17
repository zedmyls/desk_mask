use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaskSettings {
    color: String,
    transparency: u8,
}

struct MaskState(Mutex<MaskSettings>);

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

        // WebviewWindowBuilder 使用逻辑像素；显示器 API 返回物理像素。
        // 必须按各自的缩放率转换，才能覆盖 Retina 或混合 DPI 的副屏。
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
                .visible(false)
                .position(position.x, position.y)
                .inner_size(size.width, size.height)
                .build()
                .map_err(|error| error.to_string())?;

        window
            .set_ignore_cursor_events(true)
            .map_err(|error| error.to_string())?;
        window
            .emit("mask-settings", settings)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_mask_settings(state: State<'_, MaskState>) -> MaskSettings {
    state.0.lock().expect("mask state poisoned").clone()
}

#[tauri::command]
fn update_mask_settings(app: AppHandle, state: State<'_, MaskState>, settings: MaskSettings) {
    *state.0.lock().expect("mask state poisoned") = settings.clone();
    emit_settings(&app, &settings);
}

#[tauri::command]
async fn set_mask_visible(
    app: AppHandle,
    state: State<'_, MaskState>,
    visible: bool,
) -> Result<(), String> {
    let settings = state.0.lock().expect("mask state poisoned").clone();
    if visible {
        create_overlays(&app, &settings)?;
    }
    for (label, window) in app.webview_windows() {
        if label.starts_with("overlay-") {
            if visible {
                window.show().map_err(|error| error.to_string())?;
            } else {
                window.hide().map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn is_mask_visible(app: AppHandle) -> bool {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with("overlay-"))
        .any(|(_, window)| window.is_visible().unwrap_or(false))
}

/// 每次检测都只在显示器布局变化时重建对应遮罩窗口。
#[tauri::command]
async fn refresh_overlays(app: AppHandle, state: State<'_, MaskState>) -> Result<(), String> {
    if !is_mask_visible(app.clone()) {
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
    let settings = state.0.lock().expect("mask state poisoned").clone();
    create_overlays(&app, &settings)?;
    for (label, window) in app.webview_windows() {
        if label.starts_with("overlay-") {
            window.show().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(MaskState(Mutex::new(MaskSettings {
            color: "#000000".into(),
            transparency: 65,
        })))
        .invoke_handler(tauri::generate_handler![
            get_mask_settings,
            update_mask_settings,
            set_mask_visible,
            is_mask_visible,
            refresh_overlays
        ])
        .run(tauri::generate_context!())
        .expect("启动 Desk Mask 时发生错误");
}
