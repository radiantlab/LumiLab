// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Everything this app does now happens in the frontend: the image pipeline and
// the RAW converter run as WebAssembly (src/lib/pipeline), and persistence is
// in IndexedDB. Tauri is left as a shell for native file access, file dialogs
// and window management, and defines no commands of its own.

use tauri::Manager;

fn main() {
    let builder = tauri::Builder::default();

    #[cfg(feature = "e2e-driver")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.show().unwrap();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
