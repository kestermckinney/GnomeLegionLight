// Preferences dialog for Legion Light.
//
// Everything the desktop app offers, as a native GNOME dialog: three Fn+Space
// profile drafts, effect, speed, colour, custom palette, brightness, reading and
// writing the keyboard's profiles and Lenovo's defaults; plus the inactivity timer
// and an About page. The keyboard itself is driven by the legion_light_gnome_daemon
// over D-Bus; this dialog never opens the device.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SERVICE = 'io.gitlab.kestermckinney.GnomeLegionLight';
const PATH = '/io/gitlab/kestermckinney/GnomeLegionLight';

// Keep in step with gnome-extension/daemon/main.rs and src/model.rs.
const IDLE_DEFAULTS = {dim_when_idle: true, idle_timeout_seconds: 300, idle_brightness: 0};
const BRIGHTNESS_MIN = 1;
const BRIGHTNESS_MAX = 9;
const PALETTE_MIN = 2;
const PALETTE_MAX = 4;
// Keep in step with BLEND_INTERVAL_* in src/model.rs.
const BLEND_INTERVAL_MIN = 10;
const BLEND_INTERVAL_MAX = 2000;
const BLEND_INTERVAL_DEFAULT = 50;

// Effect choices in the order shown; null is "Off".
const EFFECTS = [
    {id: null, label: 'Off'},
    {id: 'static', label: 'Static'},
    {id: 'breathe', label: 'Breathe'},
    {id: 'colour_cycle', label: 'Lenovo colours'},
    {id: 'custom_cycle', label: 'Custom palette'},
    {id: 'random_blend', label: 'Random blend'},
];
const SPEEDS = ['Slow', 'Normal', 'Fast'];
const SWATCHES = [
    [255, 0, 0], [255, 128, 0], [255, 220, 0], [0, 200, 80],
    [0, 180, 255], [40, 80, 255], [180, 40, 255], [255, 255, 255],
].map(([r, g, b]) => ({r, g, b}));
const WHITE = {r: 255, g: 255, b: 255};

// --- Colour helpers -----------------------------------------------------------

function hex({r, g, b}) {
    return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function sameColour(a, b) {
    return a.r === b.r && a.g === b.g && a.b === b.b;
}

function toRgba(colour) {
    const rgba = new Gdk.RGBA();
    rgba.parse(hex(colour));
    return rgba;
}

function fromRgba(rgba) {
    const byte = v => Math.max(0, Math.min(255, Math.round(v * 255)));
    return {r: byte(rgba.red), g: byte(rgba.green), b: byte(rgba.blue)};
}

/** `#FF8000`, `FF8000` or `255,128,0`, as the desktop app accepts. */
function parseColour(text) {
    text = text.trim();
    if (text.includes(',')) {
        const parts = text.split(',').map(p => p.trim());
        if (parts.length !== 3 || !parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255))
            throw new Error('Enter three numbers from 0 to 255, such as 255,128,0');
        const [r, g, b] = parts.map(Number);
        return {r, g, b};
    }
    const digits = text.replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(digits))
        throw new Error('Enter six hex digits, such as FF8000');
    const n = parseInt(digits, 16);
    return {r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255};
}

// --- D-Bus --------------------------------------------------------------------

function call(method, args = null, replyType = null) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(SERVICE, PATH, SERVICE, method, args,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, 15000, null, (conn, res) => {
                try {
                    const reply = conn.call_finish(res);
                    resolve(replyType ? reply.deep_unpack()[0] : null);
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function errorText(e) {
    // Strip the "GDBus.Error:org.freedesktop.DBus.Error.Failed: " prefix.
    if (e instanceof GLib.Error)
        Gio.DBusError.strip_remote_error(e);
    return e.message;
}

// --- Idle settings file -------------------------------------------------------

function idleSettingsPath() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'legionlight', 'daemon.json']);
}

function loadIdleSettings() {
    try {
        const [, bytes] = GLib.file_get_contents(idleSettingsPath());
        return {...IDLE_DEFAULTS, ...JSON.parse(new TextDecoder().decode(bytes))};
    } catch (_e) {
        return {...IDLE_DEFAULTS};
    }
}

function saveIdleSettings(settings) {
    const path = idleSettingsPath();
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, `${JSON.stringify(settings, null, 2)}\n`);
    // Apply now if the daemon is running; otherwise it reads the file when it starts.
    call('Reload').catch(() => {});
}

// --- Swatch styling -----------------------------------------------------------

let swatchCssLoaded = false;

function loadSwatchCss() {
    if (swatchCssLoaded)
        return;
    swatchCssLoaded = true;
    let css = `
        .ll-swatch { min-width: 28px; min-height: 28px; padding: 0; border-radius: 6px;
                     border: 2px solid alpha(currentColor, 0.15); }
        .ll-swatch.ll-selected { border-color: @accent_color; }
        .ll-chip { min-width: 20px; min-height: 20px; border-radius: 5px;
                   border: 1px solid alpha(currentColor, 0.2); }`;
    SWATCHES.forEach((c, i) => {
        css += `.ll-swatch-${i} { background: ${hex(c)}; }`;
    });
    const provider = new Gtk.CssProvider();
    provider.load_from_string(css);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

// --- Lighting page ------------------------------------------------------------

class LightingPage {
    constructor(window) {
        this._window = window;
        this._set = null;          // ProfileSet as the daemon serialises it
        this._updating = false;    // true while widgets are being filled in
        this._paletteRows = [];

        this.page = new Adw.PreferencesPage({title: 'Lighting', icon_name: 'input-keyboard-symbolic'});
        this._buildProfileGroup();
        this._buildEffectGroup();
        this._buildColourGroup();
        this._buildPaletteGroup();
        this._buildBrightnessGroup();
        this._buildKeyboardGroup();
        this._setAvailable(false);
    }

    // The currently selected profile's LightingState.
    get _state() {
        return this._set.profiles[this._set.selected];
    }

    // -- Construction --

    _buildProfileGroup() {
        this._profileGroup = new Adw.PreferencesGroup({
            title: 'Profile',
            description: 'Fn+Space cycles through three profiles stored in the keyboard. ' +
                'Choosing one makes it active; changes apply to it straight away.',
        });
        const box = new Gtk.Box({css_classes: ['linked'], valign: Gtk.Align.CENTER});
        this._profileButtons = [0, 1, 2].map(i => {
            const button = new Gtk.ToggleButton({label: `${i + 1}`, width_request: 40});
            button.connect('toggled', () => {
                if (button.active && !this._updating)
                    this._selectProfile(i);
            });
            box.append(button);
            return button;
        });
        for (let i = 1; i < 3; i++)
            this._profileButtons[i].set_group(this._profileButtons[0]);
        this._profileGroup.set_header_suffix(box);
        this.page.add(this._profileGroup);
    }

    _buildEffectGroup() {
        this._effectGroup = new Adw.PreferencesGroup({
            title: 'Effect',
            description: 'One RGB zone. Built-in effects keep running with nothing open.',
        });
        this._effectRow = new Adw.ComboRow({
            title: 'Effect',
            model: Gtk.StringList.new(EFFECTS.map(e => e.label)),
        });
        this._effectRow.connect('notify::selected', () => {
            if (!this._updating)
                this._setEffect(EFFECTS[this._effectRow.selected].id);
        });
        this._effectGroup.add(this._effectRow);

        this._speedRow = new Adw.ComboRow({title: 'Speed', model: Gtk.StringList.new(SPEEDS)});
        this._speedRow.connect('notify::selected', () => {
            if (this._updating)
                return;
            this._state.effect_speed = this._speedRow.selected + 1;
            this._state.enabled = true;
            this._apply();
        });
        this._effectGroup.add(this._speedRow);

        this._blendRow = new Adw.SpinRow({
            title: 'Blend step',
            subtitle: 'Milliseconds between steps; each step nudges R, G and B by one',
            adjustment: new Gtk.Adjustment({
                lower: BLEND_INTERVAL_MIN, upper: BLEND_INTERVAL_MAX,
                step_increment: 10, page_increment: 100,
            }),
            digits: 0,
        });
        this._blendRow.connect('notify::value', () => {
            if (this._updating)
                return;
            const ms = Math.round(this._blendRow.value);
            if (ms === this._state.blend_interval_ms)
                return;
            this._state.blend_interval_ms = ms;
            this._state.enabled = true;
            this._apply();
        });
        this._effectGroup.add(this._blendRow);
        this.page.add(this._effectGroup);
    }

    _buildColourGroup() {
        loadSwatchCss();
        this._colourGroup = new Adw.PreferencesGroup({title: 'Colour'});

        this._colourRow = new Adw.ActionRow({title: 'Colour'});
        this._colourButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false, title: 'Keyboard Colour'}),
            valign: Gtk.Align.CENTER,
        });
        this._colourButton.connect('notify::rgba', () => {
            if (!this._updating)
                this._setColour(fromRgba(this._colourButton.rgba));
        });
        this._colourRow.add_suffix(this._colourButton);
        this._colourRow.set_activatable_widget(this._colourButton);
        this._colourGroup.add(this._colourRow);

        const swatchRow = new Adw.ActionRow({title: 'Presets'});
        const swatchBox = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
        this._swatches = SWATCHES.map((colour, i) => {
            const button = new Gtk.Button({
                css_classes: ['ll-swatch', `ll-swatch-${i}`],
                tooltip_text: hex(colour),
            });
            button.connect('clicked', () => this._setColour(colour));
            swatchBox.append(button);
            return button;
        });
        swatchRow.add_suffix(swatchBox);
        this._colourGroup.add(swatchRow);

        this._hexRow = new Adw.EntryRow({
            title: 'Custom colour — hex (#FF8000) or RGB (255,128,0)',
            show_apply_button: true,
        });
        this._hexRow.connect('apply', () => {
            try {
                this._setColour(parseColour(this._hexRow.text));
            } catch (e) {
                this._toast(e.message);
            }
        });
        this._colourGroup.add(this._hexRow);
        this.page.add(this._colourGroup);
    }

    _buildPaletteGroup() {
        this._paletteGroup = new Adw.PreferencesGroup({
            title: 'Custom Palette',
            description: 'Two to four colours, played by the Legion Light service. ' +
                'Fn+Space stores the first colour as a steady fallback.',
        });
        this._addColourButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Add a colour',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        this._addColourButton.connect('clicked', () => {
            this._state.palette.push({...WHITE});
            this._state.enabled = true;
            this._refresh();
            this._apply();
        });
        this._paletteGroup.set_header_suffix(this._addColourButton);
        this.page.add(this._paletteGroup);
    }

    _buildBrightnessGroup() {
        this._brightnessGroup = new Adw.PreferencesGroup({title: 'Brightness'});
        const row = new Adw.ActionRow({title: 'Brightness', subtitle: 'Shared by all three profiles'});
        this._brightnessScale = new Gtk.Scale({
            adjustment: new Gtk.Adjustment({
                lower: BRIGHTNESS_MIN, upper: BRIGHTNESS_MAX, step_increment: 1, page_increment: 1,
            }),
            digits: 0,
            round_digits: 0,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            hexpand: true,
            width_request: 220,
            valign: Gtk.Align.CENTER,
        });
        for (let level = BRIGHTNESS_MIN; level <= BRIGHTNESS_MAX; level++)
            this._brightnessScale.add_mark(level, Gtk.PositionType.BOTTOM, null);
        this._brightnessScale.connect('value-changed', () => {
            if (this._updating)
                return;
            const level = Math.round(this._brightnessScale.get_value());
            if (level === this._state.brightness)
                return;
            this._state.brightness = level;
            this._state.enabled = true;
            this._apply();
        });
        row.add_suffix(this._brightnessScale);
        this._brightnessGroup.add(row);
        this.page.add(this._brightnessGroup);
    }

    _buttonRow(title, subtitle, label, onClick, cssClass = null) {
        const row = new Adw.ActionRow({title, subtitle});
        const button = new Gtk.Button({label, valign: Gtk.Align.CENTER});
        if (cssClass)
            button.add_css_class(cssClass);
        button.connect('clicked', onClick);
        row.add_suffix(button);
        row.set_activatable_widget(button);
        return row;
    }

    _buildKeyboardGroup() {
        this._keyboardGroup = new Adw.PreferencesGroup({title: 'Keyboard'});
        this._keyboardGroup.add(this._buttonRow('Lenovo defaults',
            'Replace all three profiles: changing colours, purple static, off', 'Reset…',
            () => this._confirmDefaults(), 'destructive-action'));
        this.page.add(this._keyboardGroup);
    }

    // -- Daemon --

    connect() {
        this._signalIds = [
            Gio.DBus.session.signal_subscribe(SERVICE, SERVICE, 'Message', PATH, null,
                Gio.DBusSignalFlags.NONE, (...args) => this._toast(args[5].deep_unpack()[0])),
            Gio.DBus.session.signal_subscribe(SERVICE, SERVICE, 'ProfilesChanged', PATH, null,
                Gio.DBusSignalFlags.NONE, (...args) => this._showProfiles(args[5].deep_unpack()[0])),
        ];
        this._watchId = Gio.bus_watch_name(Gio.BusType.SESSION, SERVICE,
            Gio.BusNameWatcherFlags.AUTO_START,
            () => this._load(),
            () => {
                this._setAvailable(false);
                this._toast('The Legion Light service is not running');
            });
    }

    disconnect() {
        for (const id of this._signalIds ?? [])
            Gio.DBus.session.signal_unsubscribe(id);
        this._signalIds = [];
        if (this._watchId)
            Gio.bus_unwatch_name(this._watchId);
        this._watchId = 0;
    }

    async _load() {
        try {
            this._showProfiles(await call('GetProfiles', null, '(s)'));
            this._setAvailable(true);
            // Like the desktop app, show what the keyboard actually holds.
            await call('ReadProfiles');
            this._toast('Reading profiles from the keyboard…');
        } catch (e) {
            this._toast(errorText(e));
        }
    }

    _showProfiles(json) {
        try {
            this._set = JSON.parse(json);
        } catch (e) {
            this._toast(`Unreadable profiles from the service: ${e.message}`);
            return;
        }
        this._refresh();
    }

    _setAvailable(available) {
        for (const group of [this._profileGroup, this._effectGroup, this._colourGroup,
            this._paletteGroup, this._brightnessGroup, this._keyboardGroup])
            group.sensitive = available;
    }

    _toast(text) {
        this._window.add_toast(new Adw.Toast({title: GLib.markup_escape_text(text, -1), timeout: 3}));
    }

    // Every slot must carry its own number, as the daemon validates.
    _payload() {
        this._set.profiles.forEach((state, i) => {
            state.profile = i + 1;
        });
        return new GLib.Variant('(s)', [JSON.stringify(this._set)]);
    }

    async _apply() {
        try {
            await call('Apply', this._payload());
        } catch (e) {
            this._toast(errorText(e));
        }
    }

    _confirmDefaults() {
        const dialog = new Adw.AlertDialog({
            heading: 'Restore Lenovo Defaults?',
            body: 'All three Fn+Space profiles are replaced with changing colours, ' +
                'purple static and off, and written to the keyboard.',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('reset', 'Restore Defaults');
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', async (_d, response) => {
            if (response !== 'reset')
                return;
            try {
                this._showProfiles(await call('LenovoDefaults', null, '(s)'));
            } catch (e) {
                this._toast(errorText(e));
            }
        });
        dialog.present(this._window);
    }

    // -- Editing (mirrors src/app.rs) --

    _selectProfile(index) {
        this._set.selected = index;
        this._refresh();
        this._apply();
    }

    _setEffect(effect) {
        const state = this._state;
        if (effect === null) {
            state.enabled = false;
        } else {
            state.effect = effect;
            state.enabled = true;
            if (effect === 'custom_cycle' && state.palette.length < PALETTE_MIN)
                state.palette = [{...state.zones[0]}, {r: 0, g: 80, b: 255}];
        }
        this._refresh();
        this._apply();
    }

    _setColour(colour) {
        const state = this._state;
        state.zones[0] = {...colour};
        if (state.effect === 'colour_cycle')
            state.effect = 'static';
        state.enabled = true;
        this._refresh();
        this._apply();
    }

    _setPaletteColour(index, colour) {
        this._state.palette[index] = {...colour};
        this._state.enabled = true;
        this._refresh();
        this._apply();
    }

    _removePaletteColour(index) {
        if (this._state.palette.length <= PALETTE_MIN)
            return;
        this._state.palette.splice(index, 1);
        this._refresh();
        this._apply();
    }

    // -- Showing the selected profile --

    _refresh() {
        if (!this._set)
            return;
        this._updating = true;
        try {
            const state = this._state;
            const effectIndex = state.enabled ? EFFECTS.findIndex(e => e.id === state.effect) : 0;

            this._profileButtons[this._set.selected].active = true;
            this._profileGroup.title = `Profile ${this._set.selected + 1}`;

            this._effectRow.selected = Math.max(0, effectIndex);
            this._speedRow.selected = Math.max(0, Math.min(2, state.effect_speed - 1));
            this._speedRow.visible = state.enabled && state.effect !== 'static' &&
                state.effect !== 'random_blend';
            this._blendRow.visible = state.enabled && state.effect === 'random_blend';
            this._blendRow.value = state.blend_interval_ms ?? BLEND_INTERVAL_DEFAULT;

            const colour = state.zones[0];
            const showColour = state.enabled &&
                ['static', 'breathe', 'random_blend'].includes(state.effect);
            this._colourGroup.visible = showColour;
            this._colourGroup.title = state.effect === 'random_blend'
                ? 'Starting Colour' : 'Colour';
            this._colourGroup.description = state.effect === 'random_blend'
                ? 'Where the blend starts; Fn+Space stores it as a steady fallback.' : null;
            this._colourButton.rgba = toRgba(colour);
            this._colourRow.subtitle = `${hex(colour)} · RGB ${colour.r}, ${colour.g}, ${colour.b}`;
            this._swatches.forEach((button, i) => {
                if (sameColour(SWATCHES[i], colour))
                    button.add_css_class('ll-selected');
                else
                    button.remove_css_class('ll-selected');
            });

            this._paletteGroup.visible = state.enabled && state.effect === 'custom_cycle';
            this._addColourButton.sensitive = state.palette.length < PALETTE_MAX;
            this._rebuildPalette(state.palette);

            this._brightnessScale.set_value(state.brightness);
        } finally {
            this._updating = false;
        }
    }

    _rebuildPalette(palette) {
        for (const row of this._paletteRows)
            this._paletteGroup.remove(row);
        this._paletteRows = palette.map((colour, i) => {
            const row = new Adw.ActionRow({
                title: i === 0 ? 'Colour 1 (fallback)' : `Colour ${i + 1}`,
                subtitle: `${hex(colour)} · RGB ${colour.r}, ${colour.g}, ${colour.b}`,
            });
            const button = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({with_alpha: false, title: `Palette Colour ${i + 1}`}),
                rgba: toRgba(colour),
                valign: Gtk.Align.CENTER,
            });
            button.connect('notify::rgba', () => {
                if (!this._updating)
                    this._setPaletteColour(i, fromRgba(button.rgba));
            });
            row.add_suffix(button);
            row.set_activatable_widget(button);
            if (palette.length > PALETTE_MIN) {
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    tooltip_text: 'Remove this colour',
                    css_classes: ['flat'],
                    valign: Gtk.Align.CENTER,
                });
                remove.connect('clicked', () => this._removePaletteColour(i));
                row.add_suffix(remove);
            }
            this._paletteGroup.add(row);
            return row;
        });
    }
}

// --- Inactivity page ----------------------------------------------------------

function buildInactivityPage() {
    const settings = loadIdleSettings();
    const page = new Adw.PreferencesPage({title: 'Inactivity', icon_name: 'preferences-system-time-symbolic'});

    const group = new Adw.PreferencesGroup({
        title: 'Inactivity',
        description: 'Dim the keyboard backlight when you stop typing or moving the pointer. ' +
            'It comes back as soon as you use the keyboard or pointer again.',
    });
    page.add(group);

    const dimRow = new Adw.SwitchRow({title: 'Dim when idle', active: settings.dim_when_idle});
    group.add(dimRow);

    const minutesRow = new Adw.SpinRow({
        title: 'Idle timeout (minutes)',
        adjustment: new Gtk.Adjustment({lower: 0, upper: 1440, step_increment: 1, page_increment: 5}),
        value: Math.floor(settings.idle_timeout_seconds / 60),
    });
    group.add(minutesRow);

    const secondsRow = new Adw.SpinRow({
        title: 'Idle timeout (seconds)',
        subtitle: 'Added to the minutes; at least 5 seconds in total',
        adjustment: new Gtk.Adjustment({lower: 0, upper: 59, step_increment: 5, page_increment: 15}),
        value: settings.idle_timeout_seconds % 60,
    });
    group.add(secondsRow);

    const levels = ['Off'];
    for (let level = BRIGHTNESS_MIN; level <= BRIGHTNESS_MAX; level++)
        levels.push(`Level ${level}`);
    const brightnessRow = new Adw.ComboRow({
        title: 'Brightness while idle',
        subtitle: 'Your normal brightness is restored when you return',
        model: Gtk.StringList.new(levels),
        selected: Math.min(settings.idle_brightness, BRIGHTNESS_MAX),
    });
    group.add(brightnessRow);

    const syncSensitivity = () => {
        for (const row of [minutesRow, secondsRow, brightnessRow])
            row.sensitive = dimRow.active;
    };
    syncSensitivity();

    const save = () => saveIdleSettings({
        dim_when_idle: dimRow.active,
        idle_timeout_seconds: Math.max(5, minutesRow.value * 60 + secondsRow.value),
        idle_brightness: brightnessRow.selected,
    });
    dimRow.connect('notify::active', () => {
        syncSensitivity();
        save();
    });
    minutesRow.connect('notify::value', save);
    secondsRow.connect('notify::value', save);
    brightnessRow.connect('notify::selected', save);
    return page;
}

// --- About page ---------------------------------------------------------------

// The install script and the Flatpak write build-info.json next to metadata.json; a copy run
// straight from the source tree has none, so fall back to the metadata.
function readBuildInfo(extension) {
    const info = {version: String(extension.metadata['version-name'] ?? extension.metadata.version ?? ''),
        built: null};
    try {
        const [, bytes] = GLib.file_get_contents(`${extension.path}/build-info.json`);
        Object.assign(info, JSON.parse(new TextDecoder().decode(bytes)));
    } catch (e) {
        // No build info: development copy.
    }
    return info;
}

function formatBuildTime(iso) {
    const time = iso ? GLib.DateTime.new_from_iso8601(iso, null) : null;
    return time ? time.to_local().format('%Y-%m-%d %H:%M:%S %Z') : 'unknown (development copy)';
}

function buildAboutHeader(extension) {
    const info = readBuildInfo(extension);
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        halign: Gtk.Align.CENTER,
        margin_bottom: 12,
    });
    box.append(new Gtk.Image({
        file: `${extension.path}/icons/legion-light.svg`,
        pixel_size: 128,
        margin_bottom: 6,
    }));
    const name = new Gtk.Label({label: 'Legion Light'});
    name.add_css_class('title-1');
    box.append(name);
    const version = new Gtk.Label({label: `Version ${info.version}`, selectable: true});
    box.append(version);
    const built = new Gtk.Label({label: `Built ${formatBuildTime(info.built)}`, selectable: true});
    built.add_css_class('dim-label');
    box.append(built);

    const group = new Adw.PreferencesGroup();
    group.add(box);
    return group;
}

function buildAboutPage(extension) {
    const page = new Adw.PreferencesPage({title: 'About', icon_name: 'help-about-symbolic'});
    page.add(buildAboutHeader(extension));
    const keyboard = new Adw.PreferencesGroup({
        title: 'Lenovo Legion 5 · OneZone RGB',
        description: '048d:c615 · model 83Q7 · firmware profiles 1–3',
    });
    const paragraphs = [
        'Static colour and brightness are confirmed on this keyboard. Built-in pulse and ' +
            'Fn+Space profiles follow Lenovo’s Windows code. Custom palettes and random blend ' +
            'play through LampArray while the Legion Light service runs.',
        'Opening this dialog reads all three profiles from the keyboard (briefly stepping ' +
            'through each, then restoring the active one) and changes no stored settings. ' +
            'Choosing or editing a profile writes it to the keyboard straight away; Lenovo defaults ' +
            'replace all three.',
        'The last profiles you applied are kept in ~/.config/legionlight/ and restored when ' +
            'the service starts.',
    ];
    for (const text of paragraphs) {
        keyboard.add(new Adw.ActionRow({title: text, title_lines: 0, activatable: false}));
    }
    page.add(keyboard);
    return page;
}

export default class LegionLightPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(640, 760);
        window.search_enabled = false;

        const lighting = new LightingPage(window);
        window.add(lighting.page);
        window.add(buildInactivityPage());
        window.add(buildAboutPage(this));

        lighting.connect();
        window.connect('close-request', () => {
            lighting.disconnect();
            return false;
        });
    }
}
