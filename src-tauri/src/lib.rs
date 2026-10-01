pub mod ai;
mod db;
mod security;
mod storage;
mod system;

use std::sync::atomic::Ordering;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 Daynora", true, None::<&str>)?;
    let today = MenuItem::with_id(app, "today", "今日任务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &today, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Daynora")
        .menu(&menu)
        .show_menu_on_left_click(false);

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "today" => {
                show_main_window(app);
                let _ = app.emit("daynora://today", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            app.manage(system::RuntimeSettings::default());
            db::init(app.handle())?;
            ai::setup(app.handle());
            setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let runtime = app.state::<system::RuntimeSettings>();
                if runtime.close_to_tray.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            db::load_snapshot,
            db::save_snapshot,
            db::backup_database,
            db::list_backups,
            db::save_text_file,
            db::open_text_file,
            system::set_close_to_tray,
            system::notify,
            system::autostart_set,
            system::autostart_get,
            system::updater_status,
            system::open_backup_folder,
            system::open_external_url,
            storage::kv_get,
            storage::kv_set,
            storage::kv_delete,
            storage::undo_push,
            storage::undo_pop,
            storage::undo_clear,
            storage::undo_list,
            ai::commands::ai_undo_count,
            ai::media::ai_fetch_image,
            ai::web::ai_web_search,
            ai::commands::ai_presets,
            ai::commands::ai_list_providers,
            ai::commands::ai_save_provider,
            ai::commands::ai_delete_provider,
            ai::commands::ai_set_active_provider,
            ai::commands::ai_get_settings,
            ai::commands::ai_set_system_prompt,
            ai::commands::ai_accept_privacy,
            ai::commands::ai_test_provider,
            ai::commands::ai_list_messages,
            ai::commands::ai_clear_messages,
            ai::commands::ai_list_conversations,
            ai::commands::ai_create_conversation,
            ai::commands::ai_delete_conversation,
            ai::commands::ai_rename_conversation,
            ai::commands::ai_stop_generation,
            ai::commands::ai_chat_stream,
            ai::commands::ai_apply_changes,
            ai::commands::ai_undo_changes,
            ai::commands::ai_poll_reminders,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Daynora")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                ai::shutdown(app);
            }
        });
}
