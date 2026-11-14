// GNOME Shell extension for Legion Light.
//
// Shows a keycap in the top bar that is bright while the keyboard backlight is lit
// and dim while it is off or idle-dimmed, plus a small menu with the daemon's
// current settings. State comes from the legion_light_gnome_daemon over D-Bus.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SERVICE = 'io.gitlab.kestermckinney.GnomeLegionLight';
const PATH = '/io/gitlab/kestermckinney/GnomeLegionLight';
const IFACE = SERVICE;

// Panel icon opacity (0-255) for a lit and an unlit keyboard.
const ICON_OPACITY_LIT = 255;
const ICON_OPACITY_DIM = 80;
const ICON_FADE_MS = 400;

function formatTimeout(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m && s)
        return `${m} min ${s} s`;
    return m ? `${m} min` : `${s} s`;
}

// A non-interactive menu row: label on the left, value in a right-aligned column.
const InfoRow = GObject.registerClass(
class InfoRow extends PopupMenu.PopupBaseMenuItem {
    _init(label) {
        super._init({reactive: false, can_focus: false, style_class: 'legion-light-row'});
        this.add_child(new St.Label({
            text: label,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._value = new St.Label({
            text: '—',
            style_class: 'legion-light-value',
            // Muted in light and dark themes alike.
            opacity: 190,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._value);
    }

    set value(text) {
        this._value.text = text;
    }
});

const LegionLightIndicator = GObject.registerClass(
class LegionLightIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Legion Light', false);
        this.add_style_class_name('legion-light-indicator');
        this._extension = extension;
        this._restored = false;
        this._nameWatchId = 0;
        this._signalId = 0;
        this._cancellable = new Gio.Cancellable();

        // Legion Light icon; dimmed until the daemon reports the keyboard is lit.
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/legion-light.svg`),
            style_class: 'system-status-icon',
            opacity: ICON_OPACITY_DIM,
        });
        this.add_child(this._icon);

        this._statusRow = new InfoRow('Keyboard');
        this._dimRow = new InfoRow('Dim when idle');
        this._timeoutRow = new InfoRow('Idle timeout');
        this._idleLevelRow = new InfoRow('Idle brightness');
        for (const row of [this._statusRow, this._dimRow, this._timeoutRow, this._idleLevelRow])
            this.menu.addMenuItem(row);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Settings…', () => this._extension.openPreferences());

        // Refresh the figures whenever the menu opens.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._queryStatus();
        });

        this._connectToDaemon();
    }

    _connectToDaemon() {
        this._signalId = Gio.DBus.session.signal_subscribe(
            SERVICE, IFACE, 'LightingStateChanged', PATH, null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [lit] = params.deep_unpack();
                this._setLit(lit);
                this._queryStatus();
            });

        // AUTO_START launches the daemon by D-Bus activation if it is not running.
        this._nameWatchId = Gio.bus_watch_name(
            Gio.BusType.SESSION, SERVICE, Gio.BusNameWatcherFlags.AUTO_START,
            () => {
                this._restoreActive();
                this._queryStatus();
            },
            () => this._showDisconnected());
    }

    // Once per load, ask the daemon to re-apply the last profile the user applied,
    // so e.g. a custom palette starts playing straight away.
    _restoreActive() {
        if (this._restored)
            return;
        this._restored = true;
        Gio.DBus.session.call(
            SERVICE, PATH, IFACE, 'RestoreActive', null, null,
            Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`Legion Light: could not restore the last profile: ${e.message}`);
                }
            });
    }

    _queryStatus() {
        Gio.DBus.session.call(
            SERVICE, PATH, IFACE, 'GetStatus', null, new GLib.VariantType('(s)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => {
                let status;
                try {
                    const [json] = conn.call_finish(res).deep_unpack();
                    status = JSON.parse(json);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        this._showDisconnected();
                    return;
                }
                this._showStatus(status);
            });
    }

    _showStatus(status) {
        this._setLit(status.lit);
        if (status.error)
            this._statusRow.value = 'Not found';
        else if (status.dimmed)
            this._statusRow.value = 'Dimmed (idle)';
        else
            this._statusRow.value = status.lit ? 'Lit' : 'Off';
        this._dimRow.value = status.dim_when_idle ? 'On' : 'Off';
        this._timeoutRow.value = formatTimeout(status.idle_timeout_seconds);
        this._idleLevelRow.value = status.idle_brightness ? `Level ${status.idle_brightness}` : 'Off';
    }

    _showDisconnected() {
        this._setLit(false);
        this._statusRow.value = 'Daemon not running';
        for (const row of [this._dimRow, this._timeoutRow, this._idleLevelRow])
            row.value = '—';
    }

    _setLit(lit) {
        const opacity = lit ? ICON_OPACITY_LIT : ICON_OPACITY_DIM;
        if (this._icon.opacity === opacity)
            return;
        this._icon.remove_all_transitions();
        this._icon.ease({
            opacity,
            duration: ICON_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    destroy() {
        this._cancellable.cancel();
        if (this._signalId) {
            Gio.DBus.session.signal_unsubscribe(this._signalId);
            this._signalId = 0;
        }
        if (this._nameWatchId) {
            Gio.bus_unwatch_name(this._nameWatchId);
            this._nameWatchId = 0;
        }
        super.destroy();
    }
});

export default class LegionLightExtension extends Extension {
    enable() {
        this._indicator = new LegionLightIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
