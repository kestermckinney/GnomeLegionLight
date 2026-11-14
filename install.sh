#!/bin/bash
# Install the Legion Light GNOME extension and its daemon natively for the current
# user (the Flatpak is the alternative; do not use both). Run from the project root
# after `cargo build --release`.

set -e

UUID="legion-light@kestermckinney.gitlab.io"
BUS_NAME="io.gitlab.kestermckinney.GnomeLegionLight"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
BIN_DIR="$HOME/.local/bin"
UNIT_DIR="$HOME/.config/systemd/user"
DBUS_DIR="$HOME/.local/share/dbus-1/services"
DAEMON="target/release/legion_light_gnome_daemon"

if [ ! -d shell-extension ]; then
    echo "Error: run this from the GnomeLegionLight project root" >&2
    exit 1
fi
if [ ! -x "$DAEMON" ]; then
    echo "Error: $DAEMON not found; run 'cargo build --release' first" >&2
    exit 1
fi
if flatpak info "$BUS_NAME" &>/dev/null; then
    echo "Error: the $BUS_NAME Flatpak is installed; remove it first" >&2
    echo "       (flatpak uninstall $BUS_NAME) so only one daemon drives the keyboard." >&2
    exit 1
fi

echo "Installing extension to $EXTENSION_DIR"
# Start clean so files from older versions do not linger.
rm -rf "$EXTENSION_DIR"
mkdir -p "$EXTENSION_DIR"
cp -r shell-extension/* "$EXTENSION_DIR/"
bash packaging/write-build-info.sh "$EXTENSION_DIR" "$DAEMON"

echo "Installing daemon to $BIN_DIR"
mkdir -p "$BIN_DIR"
install -m755 "$DAEMON" "$BIN_DIR/"

echo "Installing user service"
mkdir -p "$UNIT_DIR" "$DBUS_DIR"
install -m644 systemd/legion-light-daemon.service "$UNIT_DIR/"
# D-Bus activation hands off to the systemd unit, so the extension can start it.
printf '[D-BUS Service]\nName=%s\nExec=%s\nSystemdService=legion-light-daemon.service\n' \
    "$BUS_NAME" "$BIN_DIR/legion_light_gnome_daemon" > "$DBUS_DIR/$BUS_NAME.service"
systemctl --user daemon-reload
systemctl --user enable legion-light-daemon.service
systemctl --user restart legion-light-daemon.service

gnome-extensions enable "$UUID" 2>/dev/null || true

echo ""
echo "Done. Settings are saved in ~/.config/legionlight/daemon.json."
echo "If the Legion Light icon does not appear in the top bar, log out and back in"
echo "so GNOME Shell loads the extension."
