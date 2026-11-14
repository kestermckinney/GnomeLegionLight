#!/bin/bash
# Remove the natively installed Legion Light GNOME extension and its daemon for
# the current user. Your saved settings (~/.config/legionlight/) are kept.
# For the Flatpak, run `flatpak uninstall io.gitlab.kestermckinney.GnomeLegionLight`
# and remove the extension in the Extensions app.

set -e

UUID="legion-light@kestermckinney.gitlab.io"
BUS_NAME="io.gitlab.kestermckinney.GnomeLegionLight"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
UNIT="$HOME/.config/systemd/user/legion-light-daemon.service"

gnome-extensions disable "$UUID" 2>/dev/null || true

# Stopping the daemon restores the keyboard if it was idle-dimmed.
systemctl --user disable --now legion-light-daemon.service 2>/dev/null || true
rm -f "$UNIT" "$HOME/.local/share/dbus-1/services/$BUS_NAME.service"
systemctl --user daemon-reload

rm -f "$HOME/.local/bin/legion_light_gnome_daemon"
rm -rf "$EXTENSION_DIR"

echo "Legion Light GNOME extension removed. Settings were kept in ~/.config/legionlight/."
