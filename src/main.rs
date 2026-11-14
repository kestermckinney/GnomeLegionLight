//! Legion Light daemon for the GNOME extension.
//!
//! The daemon is the only process that talks to the keyboard. It runs the same
//! [`Worker`] as the desktop app, so profiles, effects and custom palettes behave
//! identically, and a custom palette keeps playing with no window open.
//!
//! It also dims the backlight after a period of inactivity and restores it on the
//! next keypress or pointer movement. Inactivity comes from GNOME's idle monitor
//! (`org.gnome.Mutter.IdleMonitor`), so no access to `/dev/input` is needed.
//!
//! It is started on demand by D-Bus activation (the extension asks for it as it
//! loads) or, in a native install, by the `legion-light-daemon` user service.
//! `--setup` installs the bundled extension instead; see [`install`].
//!
//! Files in the host's `$XDG_CONFIG_HOME/legionlight/` (also inside a Flatpak, so
//! the preferences dialog and the daemon share them):
//! * `daemon.json` — idle settings, written by the preferences dialog.
//! * `active.json` — the profile set last sent to the keyboard; at startup its
//!   selected profile is applied again, so any effect, including a custom
//!   palette, comes back after a restart.
//! * `presets/saved.json` — "Save to disk" / "Load from disk" (shared with the app).
//!
//! D-Bus (session bus) `io.gitlab.kestermckinney.GnomeLegionLight` at
//! `/io/gitlab/kestermckinney/GnomeLegionLight` (the name must match the Flatpak
//! app ID for Flatpak to export its activation file):
//! * `GetStatus() -> s` — JSON: `lit`, `dimmed`, idle settings, keyboard error.
//! * `Reload()` — re-read `daemon.json`.
//! * `GetProfiles() -> s` — the three profile drafts (a `ProfileSet` as JSON).
//! * `ReadProfiles()` — read the firmware; the result arrives as `ProfilesChanged`.
//! * `Apply(s set)` — store drafts and apply `set.selected` to the keyboard.
//! * `SaveFnSpace(s set)` — store drafts and write all three Fn+Space slots.
//! * `RestoreActive()` — apply the stored selected profile again (the extension
//!   calls this when it loads).
//! * `SaveDrafts(s set)`, `LoadDrafts() -> s` — the on-disk preset.
//! * `LenovoDefaults() -> s` — reset all three slots to Lenovo's defaults.
//! * signals `LightingStateChanged(b lit)`, `Message(s)`, `ProfilesChanged(s set)`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use legion_light::lighting::protocol::FirmwareProfiles;
use legion_light::lighting::worker::{Command, Worker, SHUTDOWN_COMPLETE};
use legion_light::model::{LightingState, ProfileSet, BRIGHTNESS_MAX};
use serde::{Deserialize, Serialize};
use zbus::blocking::{Connection, ConnectionBuilder};
use zbus::names::BusName;
use zbus::{dbus_interface, fdo, SignalContext};

mod install;

pub const SERVICE: &str = "io.gitlab.kestermckinney.GnomeLegionLight";
const PATH: &str = "/io/gitlab/kestermckinney/GnomeLegionLight";
const IFACE: &str = SERVICE;

const IDLE_SERVICE: &str = "org.gnome.Mutter.IdleMonitor";
const IDLE_PATH: &str = "/org/gnome/Mutter/IdleMonitor/Core";

/// How often the idle time is sampled. Also the worst-case wake-up latency.
const POLL: Duration = Duration::from_millis(250);
/// Longest wait for the worker to answer a dim, wake or query.
const REPLY_TIMEOUT: Duration = Duration::from_secs(10);

static STOP: AtomicBool = AtomicBool::new(false);

fn config_dir() -> Option<PathBuf> {
    install::host_dir("XDG_CONFIG_HOME", ".config").map(|base| base.join("legionlight"))
}

fn config_file(name: &str) -> Result<PathBuf, String> {
    config_dir().map(|dir| dir.join(name)).ok_or_else(|| "cannot locate the configuration directory".into())
}

/// Write via a temporary file so a crash never leaves half a document.
fn write_atomically(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("invalid path")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(|e| format!("{}: {e}", temporary.display()))?;
    std::fs::rename(&temporary, path).map_err(|e| format!("{}: {e}", path.display()))
}

fn read_profiles(name: &str) -> Result<Option<ProfileSet>, String> {
    let path = config_file(name)?;
    match std::fs::read(&path) {
        Ok(bytes) => ProfileSet::from_json(&bytes).map(Some).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn write_profiles(name: &str, set: &ProfileSet) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(set).map_err(|e| e.to_string())?;
    write_atomically(&config_file(name)?, &bytes)
}

// ---------------------------------------------------------------------------
// Idle settings
// ---------------------------------------------------------------------------

pub const TIMEOUT_MIN: u64 = 5;
pub const TIMEOUT_MAX: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Dim the keyboard after `idle_timeout_seconds` without input.
    pub dim_when_idle: bool,
    pub idle_timeout_seconds: u64,
    /// Firmware level while idle: 0 is off, up to `BRIGHTNESS_MAX`.
    pub idle_brightness: u8,
}

impl Default for Settings {
    fn default() -> Self {
        Self { dim_when_idle: true, idle_timeout_seconds: 300, idle_brightness: 0 }
    }
}

impl Settings {
    /// Parse and clamp into the supported ranges, so a hand-edited file cannot
    /// produce a zero timeout or an out-of-range firmware level.
    pub fn from_json(text: &str) -> Result<Self, String> {
        let mut settings: Self = serde_json::from_str(text).map_err(|e| e.to_string())?;
        settings.idle_timeout_seconds = settings.idle_timeout_seconds.clamp(TIMEOUT_MIN, TIMEOUT_MAX);
        settings.idle_brightness = settings.idle_brightness.min(BRIGHTNESS_MAX);
        Ok(settings)
    }

    /// A missing file means defaults; an unreadable or invalid one is an error.
    pub fn load() -> Result<Self, String> {
        let path = config_file("daemon.json")?;
        match std::fs::read_to_string(&path) {
            Ok(text) => Self::from_json(&text).map_err(|e| format!("{}: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    fn timeout_ms(&self) -> u64 {
        self.idle_timeout_seconds.saturating_mul(1000)
    }
}

// ---------------------------------------------------------------------------
// Idle policy (pure, so it can be tested without a keyboard or a session bus)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Nothing,
    Dim,
    Restore,
}

/// `dimmed`: we lowered the keyboard and owe it a restore.
/// `handled`: this idle period was already acted on (dimmed, or found already dark).
pub fn decide(settings: &Settings, idle_ms: u64, dimmed: bool, handled: bool) -> Action {
    let idle = idle_ms >= settings.timeout_ms();
    if dimmed {
        if !idle || !settings.dim_when_idle { Action::Restore } else { Action::Nothing }
    } else if idle && settings.dim_when_idle && !handled {
        Action::Dim
    } else {
        Action::Nothing
    }
}

/// The profile slot to apply, with its slot number filled in as the app does.
pub fn selected_state(set: &ProfileSet) -> LightingState {
    let mut state = set.profiles[set.selected].clone();
    state.profile = Some(set.selected as u8 + 1);
    state
}

pub fn state_is_lit(state: &LightingState) -> bool {
    state.enabled && state.brightness > 0
}

pub fn firmware_is_lit(firmware: &FirmwareProfiles) -> bool {
    firmware.brightness > 0 && firmware.slots.get(firmware.selected).is_some_and(|slot| slot.enabled)
}

// ---------------------------------------------------------------------------
// D-Bus service
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct Shared {
    settings: Settings,
    profiles: ProfileSet,
    lit: bool,
    dimmed: bool,
    error: Option<String>,
}

struct Service {
    shared: Arc<Mutex<Shared>>,
    commands: Sender<Command>,
}

impl Service {
    fn parse(json: &str) -> fdo::Result<ProfileSet> {
        ProfileSet::from_json(json.as_bytes()).map_err(fdo::Error::InvalidArgs)
    }

    fn send(&self, command: Command) -> fdo::Result<()> {
        self.commands.send(command).map_err(|_| fdo::Error::Failed("keyboard worker stopped".into()))
    }

    /// Remember the drafts, both in memory and in `active.json`.
    fn store(&self, set: &ProfileSet) {
        self.shared.lock().unwrap().profiles = set.clone();
        if let Err(e) = write_profiles("active.json", set) {
            eprintln!("Legion Light daemon: could not save active profiles: {e}");
        }
    }

    fn json(set: &ProfileSet) -> String {
        serde_json::to_string(set).unwrap_or_default()
    }
}

#[dbus_interface(name = "io.gitlab.kestermckinney.GnomeLegionLight")]
impl Service {
    fn get_status(&self) -> String {
        let shared = self.shared.lock().unwrap();
        serde_json::json!({
            "lit": shared.lit,
            "dimmed": shared.dimmed,
            "dim_when_idle": shared.settings.dim_when_idle,
            "idle_timeout_seconds": shared.settings.idle_timeout_seconds,
            "idle_brightness": shared.settings.idle_brightness,
            "error": shared.error,
        })
        .to_string()
    }

    fn reload(&self) -> fdo::Result<()> {
        let settings = Settings::load().map_err(fdo::Error::Failed)?;
        eprintln!("Legion Light daemon: idle settings reloaded: {settings:?}");
        self.shared.lock().unwrap().settings = settings;
        Ok(())
    }

    fn get_profiles(&self) -> String {
        Self::json(&self.shared.lock().unwrap().profiles)
    }

    fn read_profiles(&self) -> fdo::Result<()> {
        self.send(Command::ReadProfiles)
    }

    fn apply(&self, json: &str) -> fdo::Result<()> {
        let set = Self::parse(json)?;
        let state = selected_state(&set);
        state.validate().map_err(fdo::Error::InvalidArgs)?;
        self.store(&set);
        self.shared.lock().unwrap().lit = state_is_lit(&state);
        self.send(Command::Apply(state))
    }

    fn save_fn_space(&self, json: &str) -> fdo::Result<()> {
        let set = Self::parse(json)?;
        self.store(&set);
        self.shared.lock().unwrap().lit = state_is_lit(&selected_state(&set));
        self.send(Command::ConfigureProfiles(set))
    }

    fn restore_active(&self) -> fdo::Result<()> {
        let state = selected_state(&self.shared.lock().unwrap().profiles);
        state.validate().map_err(fdo::Error::InvalidArgs)?;
        self.shared.lock().unwrap().lit = state_is_lit(&state);
        self.send(Command::Apply(state))
    }

    fn save_drafts(&self, json: &str) -> fdo::Result<()> {
        let set = Self::parse(json)?;
        write_profiles("presets/saved.json", &set).map_err(fdo::Error::Failed)?;
        self.shared.lock().unwrap().profiles = set;
        Ok(())
    }

    fn load_drafts(&self) -> fdo::Result<String> {
        let set = read_profiles("presets/saved.json")
            .map_err(fdo::Error::Failed)?
            .ok_or_else(|| fdo::Error::Failed("No drafts have been saved to disk yet".into()))?;
        self.shared.lock().unwrap().profiles = set.clone();
        Ok(Self::json(&set))
    }

    fn lenovo_defaults(&self) -> fdo::Result<String> {
        let set = ProfileSet::default();
        self.store(&set);
        self.shared.lock().unwrap().lit = state_is_lit(&selected_state(&set));
        self.send(Command::ConfigureProfiles(set.clone()))?;
        Ok(Self::json(&set))
    }

    #[dbus_interface(signal)]
    async fn lighting_state_changed(ctxt: &SignalContext<'_>, lit: bool) -> zbus::Result<()>;

    #[dbus_interface(signal)]
    async fn message(ctxt: &SignalContext<'_>, text: &str) -> zbus::Result<()>;

    #[dbus_interface(signal)]
    async fn profiles_changed(ctxt: &SignalContext<'_>, profiles: &str) -> zbus::Result<()>;
}

fn emit<B: serde::Serialize + zbus::zvariant::DynamicType>(connection: &Connection, signal: &str, body: &B) {
    if let Err(e) = connection.emit_signal(None::<BusName<'_>>, PATH, IFACE, signal, body) {
        eprintln!("Legion Light daemon: could not emit {signal}: {e}");
    }
}

fn idle_ms(connection: &Connection) -> zbus::Result<u64> {
    connection
        .call_method(Some(IDLE_SERVICE), IDLE_PATH, Some(IDLE_SERVICE), "GetIdletime", &())?
        .body::<u64>()
}

/// Send a command that carries a reply channel and wait for the answer.
fn ask<T>(commands: &Sender<Command>, make: impl FnOnce(Sender<Result<T, String>>) -> Command) -> Result<T, String> {
    let (reply, answer): (Sender<Result<T, String>>, Receiver<Result<T, String>>) = mpsc::channel();
    commands.send(make(reply)).map_err(|_| "keyboard worker stopped".to_string())?;
    answer.recv_timeout(REPLY_TIMEOUT).map_err(|_| "keyboard did not answer".to_string())?
}

extern "C" fn request_stop(_signal: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
}

fn run() -> Result<(), String> {
    let settings = Settings::load().unwrap_or_else(|e| {
        eprintln!("Legion Light daemon: {e}; using defaults");
        Settings::default()
    });
    eprintln!("Legion Light daemon: {settings:?}");
    match install::refresh() {
        Ok(true) => eprintln!("Legion Light daemon: extension updated; it loads at the next login"),
        Ok(false) => {}
        Err(e) => eprintln!("Legion Light daemon: could not update the extension: {e}"),
    }

    // Drafts: what was last sent, else the saved preset, else Lenovo's defaults.
    let restored = read_profiles("active.json").unwrap_or_else(|e| {
        eprintln!("Legion Light daemon: {e}");
        None
    });
    let resume = restored.is_some();
    let profiles = restored
        .or_else(|| read_profiles("presets/saved.json").ok().flatten())
        .unwrap_or_default();

    let Worker { commands, events, loaded } = Worker::start();
    let shared = Arc::new(Mutex::new(Shared { settings, profiles: profiles.clone(), ..Shared::default() }));
    let connection = ConnectionBuilder::session()
        .and_then(|b| b.name(SERVICE))
        .and_then(|b| b.serve_at(PATH, Service { shared: shared.clone(), commands: commands.clone() }))
        .and_then(|b| b.build())
        .map_err(|e| format!("cannot register {SERVICE} on the session bus: {e}"))?;

    unsafe {
        let handler = request_stop as extern "C" fn(libc::c_int) as libc::sighandler_t;
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
    }

    // Re-apply the last profile sent, whatever its effect; a custom palette is
    // played by software, so it would not come back on its own.
    let active = selected_state(&profiles);
    if resume && active.validate().is_ok() {
        eprintln!("Legion Light daemon: restoring profile {}", profiles.selected + 1);
        shared.lock().unwrap().lit = state_is_lit(&active);
        let _ = commands.send(Command::Apply(active));
    } else {
        match ask(&commands, |reply| Command::QueryBrightness { reply }) {
            Ok(level) => shared.lock().unwrap().lit = level > 0,
            Err(e) => {
                eprintln!("Legion Light daemon: keyboard unavailable: {e}");
                shared.lock().unwrap().error = Some(e);
            }
        }
    }

    let mut emitted_lit: Option<bool> = None;
    let mut dimmed = false;
    let mut handled = false;
    let mut idle_error_logged = false;

    while !STOP.load(Ordering::SeqCst) {
        // Worker news: status lines and firmware reads.
        while let Ok(text) = events.try_recv() {
            if text != SHUTDOWN_COMPLETE {
                emit(&connection, "Message", &(text.as_str(),));
            }
        }
        while let Ok(firmware) = loaded.try_recv() {
            let json = {
                let mut shared = shared.lock().unwrap();
                shared.profiles.apply_firmware(&firmware);
                shared.lit = !dimmed && firmware_is_lit(&firmware);
                shared.error = None;
                serde_json::to_string(&shared.profiles).unwrap_or_default()
            };
            emit(&connection, "ProfilesChanged", &(json.as_str(),));
        }
        let lit = shared.lock().unwrap().lit;
        if emitted_lit != Some(lit) {
            emit(&connection, "LightingStateChanged", &(lit,));
            emitted_lit = Some(lit);
        }

        thread::sleep(POLL);
        let settings = shared.lock().unwrap().settings.clone();
        let idle = match idle_ms(&connection) {
            Ok(idle) => {
                idle_error_logged = false;
                idle
            }
            Err(e) => {
                if !idle_error_logged {
                    eprintln!("Legion Light daemon: GNOME idle monitor unavailable: {e}");
                    idle_error_logged = true;
                }
                continue;
            }
        };
        if idle < settings.timeout_ms() {
            handled = false;
        }

        match decide(&settings, idle, dimmed, handled) {
            Action::Nothing => {}
            Action::Dim => {
                handled = true;
                let level = settings.idle_brightness;
                let result = ask(&commands, |reply| Command::Dim { level, reply });
                let mut shared = shared.lock().unwrap();
                match result {
                    Ok(true) => {
                        eprintln!("Legion Light daemon: idle, dimmed to {level}");
                        dimmed = true;
                        shared.dimmed = true;
                        shared.lit = false;
                    }
                    Ok(false) => eprintln!("Legion Light daemon: idle, keyboard already at or below {level}"),
                    Err(e) => {
                        eprintln!("Legion Light daemon: dimming failed: {e}");
                        shared.error = Some(e);
                    }
                }
            }
            Action::Restore => {
                dimmed = false;
                let result = ask(&commands, |reply| Command::Wake { reply });
                let mut shared = shared.lock().unwrap();
                shared.dimmed = false;
                match result {
                    Ok(()) => {
                        eprintln!("Legion Light daemon: active, brightness restored");
                        shared.lit = true;
                        shared.error = None;
                    }
                    Err(e) => {
                        eprintln!("Legion Light daemon: restore failed: {e}");
                        shared.error = Some(e);
                    }
                }
            }
        }
    }

    // The worker stops any palette and undoes an idle dim before acknowledging.
    eprintln!("Legion Light daemon: stopping");
    if commands.send(Command::Shutdown).is_ok() {
        let deadline = std::time::Instant::now() + REPLY_TIMEOUT;
        while std::time::Instant::now() < deadline {
            match events.recv_timeout(Duration::from_millis(200)) {
                Ok(text) if text == SHUTDOWN_COMPLETE => break,
                Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    }
    Ok(())
}

fn main() {
    let result = match std::env::args().nth(1).as_deref() {
        None => run(),
        Some("--setup") => install::setup(),
        Some("--version") => {
            println!("legion_light_gnome_daemon {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some(other) => Err(format!("unknown argument {other:?}; usage: legion_light_gnome_daemon [--setup | --version]")),
    };
    if let Err(e) = result {
        eprintln!("Legion Light daemon: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use legion_light::model::Effect;
    use legion_light::lighting::protocol::FirmwareSlot;

    fn settings(timeout: u64) -> Settings {
        Settings { idle_timeout_seconds: timeout, ..Settings::default() }
    }

    #[test]
    fn dims_once_per_idle_period() {
        let s = settings(10);
        assert_eq!(decide(&s, 9_999, false, false), Action::Nothing);
        assert_eq!(decide(&s, 10_000, false, false), Action::Dim);
        assert_eq!(decide(&s, 60_000, false, true), Action::Nothing);
    }

    #[test]
    fn restores_on_activity_or_when_disabled() {
        let mut s = settings(10);
        assert_eq!(decide(&s, 50_000, true, true), Action::Nothing);
        assert_eq!(decide(&s, 100, true, true), Action::Restore);
        s.dim_when_idle = false;
        assert_eq!(decide(&s, 50_000, true, true), Action::Restore);
        assert_eq!(decide(&s, 50_000, false, false), Action::Nothing);
    }

    #[test]
    fn settings_default_missing_fields_and_clamp_ranges() {
        assert_eq!(Settings::from_json("{}").unwrap(), Settings::default());
        let s = Settings::from_json(r#"{"idle_timeout_seconds":0,"idle_brightness":40}"#).unwrap();
        assert_eq!(s.idle_timeout_seconds, TIMEOUT_MIN);
        assert_eq!(s.idle_brightness, BRIGHTNESS_MAX);
        assert!(Settings::from_json("not json").is_err());
    }

    #[test]
    fn selected_state_carries_its_slot_number() {
        let mut set = ProfileSet::default();
        set.selected = 2;
        set.profiles[2].profile = None;
        assert_eq!(selected_state(&set).profile, Some(3));
        // Lenovo's third default slot is off.
        assert!(!state_is_lit(&selected_state(&set)));
        set.selected = 1;
        assert!(state_is_lit(&selected_state(&set)));
    }

    #[test]
    fn firmware_is_lit_needs_brightness_and_an_enabled_slot() {
        let on = FirmwareSlot { enabled: true, effect: Effect::Static, speed: 0, colour: None };
        let off = FirmwareSlot { enabled: false, ..on };
        let fw = |selected, brightness| FirmwareProfiles { selected, brightness, slots: [on, on, off] };
        assert!(firmware_is_lit(&fw(0, 5)));
        assert!(!firmware_is_lit(&fw(0, 0)));
        assert!(!firmware_is_lit(&fw(2, 5)));
    }
}
