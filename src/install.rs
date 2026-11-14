//! Putting the GNOME Shell extension into the host session.
//!
//! A Flatpak cannot place files in the host's extension directory when it is
//! installed, so the package carries a copy of the extension next to the daemon
//! (`<prefix>/share/gnome-legion-light/extension`) and the daemon copies it into
//! `~/.local/share/gnome-shell/extensions/<uuid>` itself:
//!
//! * `--setup` (the Legion Light launcher) installs or updates it, enables it and
//!   opens its settings;
//! * whenever the daemon starts and an installed copy differs from the bundled
//!   one, it is replaced, so `flatpak update` reaches the panel icon at the next
//!   login.
//!
//! A native install (`install.sh`) has no bundled copy, so all of this is skipped.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use zbus::blocking::Connection;
use zbus::zvariant::Value;

pub const UUID: &str = "legion-light@kestermckinney.gitlab.io";
/// Written at build time; two copies with the same stamp are the same build.
const STAMP: &str = "build-info.json";

const SHELL_EXTENSIONS: &str = "org.gnome.Shell.Extensions";
const SHELL_EXTENSIONS_PATH: &str = "/org/gnome/Shell/Extensions";

/// A host XDG base directory. Inside a Flatpak the XDG variables point into the
/// sandbox (`~/.var/app/…`), so use Flatpak's `HOST_` copy of the variable, then
/// the host default under `$HOME`.
pub fn host_dir(var: &str, default: &str) -> Option<PathBuf> {
    let name = if std::env::var_os("FLATPAK_ID").is_some() { format!("HOST_{var}") } else { var.to_string() };
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(default)))
}

/// The copy shipped next to the binary, if this is a packaged install.
fn bundled() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.parent()?.join("share/gnome-legion-light/extension");
    dir.join("metadata.json").is_file().then_some(dir)
}

fn installed_dir() -> Result<PathBuf, String> {
    host_dir("XDG_DATA_HOME", ".local/share")
        .map(|dir| dir.join("gnome-shell/extensions").join(UUID))
        .ok_or_else(|| "cannot locate the GNOME Shell extensions directory".into())
}

fn is_installed(target: &Path) -> bool {
    target.join("metadata.json").is_file()
}

/// Whether `target` holds a different build than `source`.
fn needs_update(source: &Path, target: &Path) -> bool {
    match std::fs::read(source.join(STAMP)) {
        Ok(stamp) => std::fs::read(target.join(STAMP)).ok().as_ref() != Some(&stamp),
        Err(_) => !is_installed(target),
    }
}

fn context(path: &Path) -> impl Fn(std::io::Error) -> String + '_ {
    move |e| format!("{}: {e}", path.display())
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(context(to))?;
    for entry in std::fs::read_dir(from).map_err(context(from))? {
        let entry = entry.map_err(context(from))?;
        let (source, dest) = (entry.path(), to.join(entry.file_name()));
        if entry.file_type().map_err(context(&source))?.is_dir() {
            copy_tree(&source, &dest)?;
        } else {
            std::fs::copy(&source, &dest).map_err(context(&source))?;
        }
    }
    Ok(())
}

/// Replace `target` with a copy of `source`. The copy is staged beside it so a
/// failure never leaves a half-written extension behind.
fn copy_extension(source: &Path, target: &Path) -> Result<(), String> {
    let parent = target.parent().ok_or("invalid extension path")?;
    let staging = parent.join(format!(".{UUID}.new"));
    let _ = std::fs::remove_dir_all(&staging);
    copy_tree(source, &staging)?;
    if target.exists() {
        std::fs::remove_dir_all(target).map_err(|e| format!("{}: {e}", target.display()))?;
    }
    std::fs::rename(&staging, target).map_err(|e| format!("{}: {e}", target.display()))
}

/// At daemon start: bring an installed copy up to date with the bundled one.
/// A missing extension is not reinstalled (the user may have removed it), and a
/// symlinked development copy is left alone. Returns whether files changed.
pub fn refresh() -> Result<bool, String> {
    let Some(source) = bundled() else { return Ok(false) };
    let target = installed_dir()?;
    if target.is_symlink() || !is_installed(&target) || !needs_update(&source, &target) {
        return Ok(false);
    }
    copy_extension(&source, &target)?;
    Ok(true)
}

fn notify(connection: &Connection, title: &str, body: &str) {
    eprintln!("Legion Light: {title}. {body}");
    let notification: HashMap<&str, Value<'_>> =
        HashMap::from([("title", Value::from(title)), ("body", Value::from(body))]);
    let sent = connection.call_method(
        Some("org.freedesktop.portal.Desktop"),
        "/org/freedesktop/portal/desktop",
        Some("org.freedesktop.portal.Notification"),
        "AddNotification",
        &("setup", notification),
    );
    if let Err(e) = sent {
        eprintln!("Legion Light: could not show a notification: {e}");
    }
}

/// `--setup`: install or update the extension, enable it, start the daemon and
/// open the settings. GNOME Shell only discovers a new extension at login, so a
/// first install ends with a request to log out and back in.
pub fn setup() -> Result<(), String> {
    let source = bundled().ok_or("this build carries no extension to install")?;
    let target = installed_dir()?;
    let changed = !target.is_symlink() && needs_update(&source, &target);
    if changed {
        copy_extension(&source, &target)?;
        eprintln!("Legion Light: extension installed to {}", target.display());
    }

    let connection = Connection::session().map_err(|e| format!("cannot reach the session bus: {e}"))?;
    let enabled = connection
        .call_method(Some(SHELL_EXTENSIONS), SHELL_EXTENSIONS_PATH, Some(SHELL_EXTENSIONS), "EnableExtension", &(UUID,))
        .and_then(|reply| reply.body::<bool>());
    match enabled {
        Ok(true) => {
            // Start the daemon now, so the dialog does not open to "not running".
            let _ = connection.call_method(
                Some("org.freedesktop.DBus"),
                "/org/freedesktop/DBus",
                Some("org.freedesktop.DBus"),
                "StartServiceByName",
                &(crate::SERVICE, 0u32),
            );
            let options: HashMap<&str, Value<'_>> = HashMap::new();
            connection
                .call_method(Some(SHELL_EXTENSIONS), SHELL_EXTENSIONS_PATH, Some(SHELL_EXTENSIONS),
                    "OpenExtensionPrefs", &(UUID, "", options))
                .map_err(|e| format!("cannot open the Legion Light settings: {e}"))?;
            if changed {
                notify(&connection, "Legion Light updated",
                    "Log out and back in to load the new version of the panel icon.");
            }
        }
        Ok(false) | Err(_) => notify(&connection, "Legion Light installed",
            "Log out and back in, then open Legion Light again to finish setting it up."),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gll-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn extension(dir: &Path, stamp: &str) {
        std::fs::create_dir_all(dir.join("icons")).unwrap();
        std::fs::write(dir.join("metadata.json"), "{}").unwrap();
        std::fs::write(dir.join("icons/legion-light.svg"), "<svg/>").unwrap();
        std::fs::write(dir.join(STAMP), stamp).unwrap();
    }

    #[test]
    fn copies_replace_older_builds_and_drop_stale_files() {
        let root = temp("copy");
        let (source, target) = (root.join("bundled"), root.join("extensions").join(UUID));
        extension(&source, "new");
        extension(&target, "old");
        std::fs::write(target.join("stale.js"), "").unwrap();

        assert!(needs_update(&source, &target));
        copy_extension(&source, &target).unwrap();
        assert!(!needs_update(&source, &target));
        assert!(target.join("icons/legion-light.svg").is_file());
        assert!(!target.join("stale.js").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_extension_needs_installing() {
        let root = temp("missing");
        extension(&root.join("bundled"), "1");
        assert!(needs_update(&root.join("bundled"), &root.join("absent")));
        std::fs::remove_dir_all(root).unwrap();
    }
}
