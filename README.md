# Legion Light for GNOME

Keyboard lighting for the Lenovo Legion (one-zone RGB, USB `048d:c615`) as a native
GNOME experience, with no desktop-app window involved:

- The Legion Light icon in the top bar, bright while the backlight is lit and dim
  while it is off or idle-dimmed, with a small status menu.
- **Settings…** opens a GNOME preferences dialog with everything the
  [Legion Light desktop app](https://gitlab.com/kestermckinney/legionlight) offers:
  the three Fn+Space profiles, effect (Off, Static, Breathe, Lenovo colours, Custom
  palette, Random blend with its step in milliseconds), speed, colour (picker,
  presets, hex or RGB), a 2–4 colour custom palette, brightness (choosing or
  editing a profile writes it to the keyboard straight away; the dialog opens
  showing what the keyboard holds), and Lenovo defaults — plus the inactivity
  timer and an About page showing the version and build time.
- After a period with no keyboard or pointer input the backlight fades down, and it
  returns at its previous brightness as soon as you are back.

The keyboard protocol, worker and profile model come from the
[`legion_light`](https://gitlab.com/kestermckinney/legionlight) library, so both
projects drive the keyboard identically.

## Install with Flatpak

Requires [Flatpak](https://flatpak.org/setup/) with the Flathub remote (for the
runtime) and GNOME Shell 45 or newer.

```bash
flatpak remote-add --user --if-not-exists gnomelegionlight https://kestermckinney.gitlab.io/gnomelegionlight/flatpak/gnomelegionlight.flatpakrepo
flatpak install --user gnomelegionlight io.gitlab.kestermckinney.GnomeLegionLight
```

Then open **Legion Light** from the app grid (or run
`flatpak run io.gitlab.kestermckinney.GnomeLegionLight --setup`). A Flatpak cannot
install a GNOME Shell extension by itself, so this copies the bundled extension to
`~/.local/share/gnome-shell/extensions/`. The first time, **log out and back in**
so GNOME Shell loads it; after that, opening Legion Light enables the extension
and opens its settings.

The daemon starts on demand through D-Bus activation when the extension loads.
`flatpak update` updates the daemon straight away, and the daemon updates the
extension files the next time it starts; GNOME Shell loads them at the next login.

Do not install the Flatpak and the native install (below) at the same time.

### Keyboard access (host udev rule)

A Flatpak cannot install udev rules. The sandbox reaches `/dev/hidraw*` through
`--device=all`, but the host must still let your session open the keyboard:

```bash
sudo install -m644 packaging/70-legionlight.rules /etc/udev/rules.d/
sudo udevadm control --reload && sudo udevadm trigger
```

The rule is also inside the installed Flatpak at
`~/.local/share/flatpak/app/io.gitlab.kestermckinney.GnomeLegionLight/current/active/files/share/gnome-legion-light/70-legionlight.rules`.

### Removing

```bash
flatpak uninstall io.gitlab.kestermckinney.GnomeLegionLight
gnome-extensions uninstall legion-light@kestermckinney.gitlab.io
```

## Components

1. **Daemon (`legion_light_gnome_daemon`)**, the only process that talks to the
   keyboard. It runs the same worker as the desktop app, so a custom palette keeps
   playing with no window open. Idle time comes from GNOME's idle monitor
   (`org.gnome.Mutter.IdleMonitor`); no `/dev/input` access is needed.
   `--setup` installs the bundled extension instead (Flatpak builds only).
2. **Shell extension** (`shell-extension/`): panel icon and menu (`extension.js`)
   and the preferences dialog (`prefs.js`), which talks to the daemon over D-Bus.
   Both ask D-Bus to start the daemon if it is not running.

### D-Bus API

Session bus, `io.gitlab.kestermckinney.GnomeLegionLight` at
`/io/gitlab/kestermckinney/GnomeLegionLight` (the name matches the Flatpak app ID,
which Flatpak requires for D-Bus activation):

| Member | Purpose |
| --- | --- |
| `GetStatus() → s` | JSON: `lit`, `dimmed`, idle settings, keyboard error |
| `Reload()` | Re-read `daemon.json` |
| `GetProfiles() → s` | The three profile drafts (`ProfileSet` JSON) |
| `ReadProfiles()` | Read the firmware; answered by `ProfilesChanged` |
| `Apply(s)` | Store drafts and apply the selected profile |
| `SaveFnSpace(s)` | Store drafts and write all three Fn+Space slots |
| `RestoreActive()` | Re-apply the stored selected profile (called when the extension loads) |
| `SaveDrafts(s)` / `LoadDrafts() → s` | The on-disk preset |
| `LenovoDefaults() → s` | Reset all three slots |
| `LightingStateChanged(b)`, `Message(s)`, `ProfilesChanged(s)` | Signals |

## Files in your profile (`~/.config/legionlight/`)

The Flatpak uses the same host directory (not `~/.var/app/…`), because the
preferences dialog runs inside GNOME Shell's session and reads it directly.

- `daemon.json` — inactivity settings:
  ```json
  { "dim_when_idle": true, "idle_timeout_seconds": 300, "idle_brightness": 0 }
  ```
  `idle_brightness` is the level while idle: `0` is off, `1`–`9` dims.
- `active.json` — the profiles last sent to the keyboard. When the daemon starts,
  and again whenever the extension loads, the selected profile is applied, so
  whatever you last used — a custom palette included — comes straight back.
- `presets/saved.json` — **Save to disk** / **Load from disk** (shared with the
  desktop app when it is installed natively).

Do not run the desktop app at the same time as the daemon; both would drive the
keyboard.

## Native install (development)

The keyboard must be accessible to your user (see `packaging/70-legionlight.rules`).

```bash
cargo build --release
./install.sh
```

This installs the extension, copies the daemon to `~/.local/bin`, and enables and
(re)starts the `legion-light-daemon` user service. Log out and back in if the icon
does not appear or the dialog still shows an older version.
`./uninstall.sh` removes everything except your settings.

## Developing

`legion_light` is a git dependency; `Cargo.lock` pins the commit. To build against
a sibling checkout of the Legion Light project (for unpushed library changes),
override it without touching `Cargo.lock`:

```bash
cargo build --release --config 'paths=["../LegionLight"]'
cargo test --config 'paths=["../LegionLight"]'
```

Once the library change is pushed, pin it with `cargo update -p legion_light`.

Flatpak builds (see [packaging/linux/RELEASING.md](packaging/linux/RELEASING.md)):

```bash
./packaging/linux/build-flatpak.sh setup                    # once
GLL_REF=local ./packaging/linux/build-flatpak.sh install    # build working tree and install
```

The Flatpak build always fetches `legion_light` at the commit in `Cargo.lock`.

## Troubleshooting

```bash
# Flatpak (D-Bus activated)
journalctl --user -f | grep -i "legion light"
# Native
systemctl --user status legion-light-daemon.service
journalctl --user -u legion-light-daemon.service -f

gdbus call --session --dest io.gitlab.kestermckinney.GnomeLegionLight \
  --object-path /io/gitlab/kestermckinney/GnomeLegionLight \
  --method io.gitlab.kestermckinney.GnomeLegionLight.GetStatus
```

Brightness changes made with Fn+Space while you are active are picked up the next
time the keyboard goes idle or the settings dialog reads the keyboard.

## License

MIT - see [LICENSE](LICENSE).
