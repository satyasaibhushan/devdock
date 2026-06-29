// devdock menu-bar tray (spec phase 2). A thin client of the one brain: it polls
// the daemon's /repos endpoint, renders glanceable status dots in the tray menu,
// and pops the web UI on click. No devspace/kubectl logic lives here.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;

use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent,
};
use tauri_plugin_opener::OpenerExt;

#[derive(Deserialize)]
struct Repo {
    id: String,
}

#[derive(Deserialize)]
struct RepoState {
    repo: Repo,
    status: String,
}

fn daemon_url() -> String {
    std::env::var("DEVDOCK_DAEMON").unwrap_or_else(|_| "http://127.0.0.1:7717".into())
}

fn web_url() -> String {
    // The daemon serves the built web UI off its own port (see packages/daemon
    // routes.ts), so the always-on daemon is also the always-on UI — no separate
    // dev server to keep alive. Override with DEVDOCK_WEB to point at `vite dev`
    // (http://127.0.0.1:5273) while developing the web package.
    std::env::var("DEVDOCK_WEB").unwrap_or_else(|_| daemon_url())
}

/// A glanceable dot for each reconciled status (spec §6).
fn status_dot(status: &str) -> &'static str {
    match status {
        "RUNNING_MANAGED" => "🟢",
        "RUNNING_EXTERNAL" => "🟡",
        "BUILDING" => "🔵",
        "CRASHED" => "🔴",
        _ => "⚪️",
    }
}

async fn fetch_repos() -> Result<Vec<RepoState>, reqwest::Error> {
    reqwest::get(format!("{}/repos", daemon_url()))
        .await?
        .json::<Vec<RepoState>>()
        .await
}

/// (Re)build the tray menu from the latest reconciled states.
fn build_menu(app: &tauri::AppHandle, repos: &[RepoState]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    if repos.is_empty() {
        menu.append(&MenuItem::with_id(
            app,
            "none",
            "No repos found",
            false,
            None::<&str>,
        )?)?;
    } else {
        for s in repos {
            let label = format!("{}  {}  —  {}", status_dot(&s.status), s.repo.id, s.status);
            menu.append(&MenuItem::with_id(
                app,
                format!("repo:{}", s.repo.id),
                label,
                true,
                None::<&str>,
            )?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "open",
        "Open devdock…",
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::quit(app, Some("Quit devdock"))?)?;
    Ok(menu)
}

/// Pop the web UI in the default browser, optionally focused on one repo.
fn open_web(app: &tauri::AppHandle, repo: Option<&str>) {
    let url = match repo {
        Some(id) => format!("{}/?repo={}", web_url(), id),
        None => web_url(),
    };
    let _ = app.opener().open_url(url, None::<&str>);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();

            let menu = build_menu(&handle, &[])?;
            let tray = TrayIconBuilder::with_id("devdock")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .tooltip("devdock")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    if id == "open" {
                        open_web(app, None);
                    } else if let Some(repo) = id.strip_prefix("repo:") {
                        open_web(app, Some(repo));
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        open_web(tray.app_handle(), None);
                    }
                })
                .build(app)?;

            // Poll the daemon and refresh the menu's status dots.
            tauri::async_runtime::spawn(async move {
                loop {
                    if let Ok(repos) = fetch_repos().await {
                        if let Ok(menu) = build_menu(&handle, &repos) {
                            let _ = tray.set_menu(Some(menu));
                            let running = repos
                                .iter()
                                .filter(|r| r.status.starts_with("RUNNING"))
                                .count();
                            let _ = tray
                                .set_tooltip(Some(format!("devdock — {} running", running)));
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(4)).await;
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building devdock tray")
        .run(|_app, event| {
            // Keep running as a background agent even with no windows open.
            if let RunEvent::ExitRequested { .. } = event {}
        });
}
