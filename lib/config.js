/**
 * Config normalization for `dsh-notify-me`.
 *
 * This plugin deliberately exports no Cordis `Config` schema and imports no
 * package to build one. A DSH Desktop host resolves bare `@deepseek-ai/*`
 * specifiers only for plugins that ship inside the application bundle: an
 * out-of-tree profile plugin that writes `import z from
 * "@deepseek-ai/schemastery"` fails to load there with an unresolved-module
 * error, and the entry stays inactive. `node:` builtins and relative imports
 * are unaffected, so this module is the whole dependency surface.
 *
 * The cost is that the Loader validates nothing on our behalf, so the schema
 * below is applied by hand: unknown values fall back to their default and are
 * reported once, rather than failing the row.
 *
 * @module dsh-notify-me/config
 */

/** Every setting's default, and the type each one accepts. */
export const DEFAULTS = Object.freeze({
	enabled: true,
	title: "会话轮次结束",
	sound: "Glass",
	// `osascript` is the only delivery that exists in a DSH Desktop host: the
	// profile runs under the Electron binary in Node mode, so the `electron`
	// module is empty and its Notification API is unreachable. `auto` and
	// `electron` are kept for a host that really does run in Electron's browser
	// process; see ADR-0002.
	delivery: "osascript",
	body: "session-title",
	notifyAborted: false,
	maxBodyChars: 160,
});

/** Accepted values for each enum setting. */
export const CHOICES = Object.freeze({
	delivery: ["client", "osascript", "auto", "electron"],
	body: ["session-title", "reply", "none"],
});

/**
 * Coerce one raw setting to its declared type.
 * @param key - the setting name.
 * @param value - the value as written in the profile patch.
 * @param warn - sink for one rejected value.
 * @returns the accepted value, or the default.
 */
function coerce(key, value, warn) {
	if (value === undefined) return DEFAULTS[key];
	const expected = typeof DEFAULTS[key];
	if (typeof value !== expected) {
		warn(`${key} must be a ${expected}, got ${JSON.stringify(value)}; using ${JSON.stringify(DEFAULTS[key])}`);
		return DEFAULTS[key];
	}
	if (key === "maxBodyChars" && (!Number.isInteger(value) || value < 0)) {
		warn(`maxBodyChars must be a non-negative integer, got ${JSON.stringify(value)}; using ${DEFAULTS.maxBodyChars}`);
		return DEFAULTS.maxBodyChars;
	}
	const choices = CHOICES[key];
	if (choices !== undefined && !choices.includes(value)) {
		warn(`${key} must be one of ${choices.map((choice) => JSON.stringify(choice)).join(" | ")}, got ${JSON.stringify(value)}; using ${JSON.stringify(DEFAULTS[key])}`);
		return DEFAULTS[key];
	}
	return value;
}

/**
 * Resolve a raw profile-patch config into every setting the plugin reads.
 * @param raw - the `config` map from the Loader entry, or undefined.
 * @param warn - sink for one rejected value; defaults to silence.
 * @returns a complete config whose values are all of the declared type.
 */
export function resolveConfig(raw, warn = () => {}) {
	const given = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const config = {};
	for (const key of Object.keys(DEFAULTS)) config[key] = coerce(key, given[key], warn);
	for (const key of Object.keys(given)) {
		if (!(key in DEFAULTS)) warn(`unknown setting ${JSON.stringify(key)} ignored`);
	}
	return config;
}
