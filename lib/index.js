/**
 * Host half of `dsh-notify-me`: one native macOS banner every time an agent
 * turn finishes and DSH goes back to waiting for the user.
 *
 * The trigger is the durable `turn/end` session event rather than
 * `agent/status → idle`, because a status flip also happens on session load
 * and on every waking delivery, while `turn/end` is committed exactly once per
 * finished turn and carries the reason it ended. Subagent sessions are skipped:
 * a delegated child finishing is not the conversation finishing.
 *
 * Delivery prefers the Electron main-process `Notification` API, which is what
 * a DSH Desktop host runs inside — that gives a banner attributed to DeepSeek
 * Harness whose click focuses the app window. Everything else (a plain `dsh web`
 * host, or an Electron build whose `electron` module is not importable from a
 * profile plugin) falls back to `osascript -e 'display notification ...'`.
 *
 * What the banner says is decided entirely in {@link module:dsh-notify-me/banner},
 * and what the settings mean in {@link module:dsh-notify-me/config}. This module
 * imports no package on purpose — see `config.js` for why that matters for an
 * out-of-tree plugin.
 *
 * @module dsh-notify-me
 */

import { execFile } from "node:child_process";
import { appleScriptProgram, bannerOf, shouldNotify } from "./banner.js";
import { resolveConfig } from "./config.js";
import { createTurnEndLog, turnEndResponse } from "./turn-end.js";

/** Cordis plugin name used by Loader diagnostics. */
export const name = "notify-me";

/**
 * Path the Client half asks about one Session's last turn end on. It rides the
 * Connection Fetch registry, so the request passes the same Host/Origin fence
 * and browser-session cookie as every other page call: the renderer is already
 * authenticated, and this needs no scheme of its own.
 */
export const TURN_END_QUERY_PATH = "/api/notify-me.turn-end";

/** Cached `electron` module, or `null` once the import is known to fail. */
let electronModule;

/**
 * Resolve the `electron` builtin at most once. A DSH Desktop host runs the
 * profile inside the Electron main process, so this normally succeeds; every
 * other host simply gets `null` and uses the `osascript` path.
 * @returns the Electron module namespace, or `null`.
 */
export async function loadElectron() {
	if (electronModule !== undefined) return electronModule;
	try {
		const loaded = await import("electron");
		electronModule = loaded?.Notification === undefined ? loaded?.default ?? null : loaded;
	} catch {
		electronModule = null;
	}
	return electronModule;
}

/** Bring the DSH window forward after a banner click, best effort. */
function focusAppWindow(electron) {
	try {
		const window = electron?.BrowserWindow?.getAllWindows?.()[0];
		if (window === undefined) return;
		if (window.isMinimized?.() === true) window.restore?.();
		window.show?.();
		window.focus?.();
		electron?.app?.focus?.({ steal: true });
	} catch {
		// Focusing is a courtesy; a banner that cannot focus is still a banner.
	}
}

/**
 * Show one banner through the Electron main-process API.
 * @param banner - the resolved title, subtitle, body, and sound.
 * @returns whether Electron accepted the banner.
 */
async function electronBanner({ title, subtitle, body, sound }) {
	const electron = await loadElectron();
	const Notification = electron?.Notification;
	if (Notification === undefined || Notification.isSupported?.() !== true) return false;
	try {
		const notification = new Notification({
			title,
			body,
			...(subtitle === "" ? {} : { subtitle }),
			...(sound === "" ? { silent: true } : { sound }),
		});
		notification.on("click", () => focusAppWindow(electron));
		notification.show();
		return true;
	} catch {
		return false;
	}
}

/**
 * Show one banner through `osascript`. The child is detached so a notification
 * never holds the host's event loop open during shutdown.
 * @param banner - the resolved title, subtitle, body, and sound.
 * @param ctx - plugin context, for diagnostics.
 */
function osascriptBanner({ title, subtitle, body, sound }, ctx) {
	const program = appleScriptProgram({ title, subtitle, body, sound });
	try {
		const child = execFile("/usr/bin/osascript", ["-e", program], { timeout: 10_000 }, (error) => {
			if (error != null) ctx.logger?.warn?.(`notify-me: osascript failed: ${error.message}`);
		});
		child.unref?.();
	} catch (error) {
		ctx.logger?.warn?.(`notify-me: cannot spawn osascript: ${String(error)}`);
	}
}

/**
 * Show one banner through the configured delivery path.
 * @param banner - the resolved title, subtitle, body, and sound.
 * @param config - the resolved plugin config.
 * @param ctx - plugin context, for diagnostics.
 */
async function deliver(banner, config, ctx) {
	// The Client half shows the banner itself when it is told to; raising one
	// here too would double every notification.
	if (config.delivery === "client") return;
	if (config.delivery === "osascript") {
		osascriptBanner(banner, ctx);
		return;
	}
	if (await electronBanner(banner)) return;
	if (config.delivery === "auto") osascriptBanner(banner, ctx);
	else ctx.logger?.warn?.("notify-me: Electron notifications unavailable; banner dropped");
}

/**
 * Publish the resolved delivery choice to the Client half through the page
 * itself, so exactly one half raises each banner. Parsing config is not
 * available to a profile Client plugin, and this needs no new channel: the
 * Web server already renders the index the Client boots from.
 *
 * Only *who speaks* travels here. Everything else — including whether a
 * finished turn is news at all — is answered per turn by
 * {@link TURN_END_QUERY_PATH}, so a config change reaches an already-open page.
 * @param html - the raw index.html body.
 * @param config - the resolved plugin config.
 * @returns the body with the Client's own config script inserted.
 */
export function withClientConfig(html, config) {
	const payload = JSON.stringify({ delivery: config.delivery }).replace(/</gu, "\\u003c");
	const tag = `<script>window.__DSH_NOTIFY_ME__=${payload}</script>`;
	return html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : `${html}${tag}`;
}

/**
 * Offer the Client half the Host's own answer for the turn that just ended.
 *
 * The renderer raises the banner but never sees a `turn/end`, and its status
 * map carries no reason (ADR-0002), so a turn the user stopped by hand looked
 * exactly like a turn that finished. This route is how it asks instead: same
 * policy, one place, and an answer the renderer cannot compute for itself.
 *
 * It stays registered while the plugin is switched off, because `enabled:
 * false` has to reach the renderer as an answer too — the Client half keeps
 * raising banners on its own side of the wire, and silence from this side is
 * indistinguishable from having nothing to say.
 *
 * @param ctx - plugin context, for the Connection service and diagnostics.
 * @param turnEnds - the Host's answer book.
 */
function answerTurnEndQueries(ctx, turnEnds) {
	ctx.inject(["connection"], (connectionCtx) => {
		const registry = connectionCtx.get("connection")?.fetch;
		if (registry?.register === undefined) {
			ctx.logger?.warn?.("notify-me: no Connection Fetch registry; the Client half cannot ask about turn ends");
			return;
		}
		connectionCtx.effect(() => {
			try {
				const dispose = registry.register({
					path: TURN_END_QUERY_PATH,
					methods: ["GET"],
					requestBody: "buffered",
					fetch: (request) => turnEndResponse(request, turnEnds),
				});
				return () => dispose();
			} catch (error) {
				// A duplicate registration must not take the whole plugin down:
				// without the route the Client half simply keeps announcing.
				ctx.logger?.warn?.(`notify-me: cannot register ${TURN_END_QUERY_PATH}: ${String(error)}`);
				return () => {};
			}
		}, "notify-me: turn-end query route");
	});
}

/**
 * Install the turn-end listener that shows the banner.
 * @param ctx - the mounting composition's context.
 * @param rawConfig - the Loader entry's config map, or undefined for defaults.
 */
export function apply(ctx, rawConfig) {
	const config = resolveConfig(rawConfig, (message) => ctx.logger?.warn?.(`notify-me: ${message}`));

	if (process.platform !== "darwin") {
		ctx.logger?.info?.("notify-me: session-end banners are macOS-only; plugin idle");
		return;
	}

	const turnEnds = createTurnEndLog();
	answerTurnEndQueries(ctx, turnEnds);

	if (config.enabled) {
		// Warm the Electron lookup so the first finished turn is not delayed by it.
		void loadElectron();

		// The Client half reads this before it decides who speaks.
		const webServer = ctx.get("webServer");
		if (webServer !== undefined) {
			ctx.effect(() => webServer.tapIndex((html) => withClientConfig(html, config)), "notify-me: client config");
		}
	}

	ctx.on("session/event", (session, event) => {
		if (event?.type !== "turn/end") return;
		// Every finished turn is recorded, banner-worthy or not: the renderer
		// asks about all of them, and a "no" has to be an answer rather than a
		// missing record.
		const announce = shouldNotify(session, event, config);
		turnEnds.record(session.id, announce);
		if (!announce) return;
		void deliver(bannerOf(ctx, session, event, config), config, ctx);
	});
}
