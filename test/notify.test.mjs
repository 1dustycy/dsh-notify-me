/**
 * Unit tests for the banner decision surface, both halves. Nothing here spawns
 * a notification: the AppleScript path is checked by compiling the generated
 * program with `osacompile`, which validates syntax without running it, and
 * the Client half runs against a stub page with a stub `Notification` class.
 *
 * Run with `node test/notify.test.mjs`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appleScriptLiteral,
	appleScriptProgram,
	bannerOf,
	bodyOf,
	describeTurnEnd,
	flatten,
	isUserStop,
	lastReplyText,
	shouldNotify,
	textOfBlocks,
} from "../lib/banner.js";
import { DEFAULTS, resolveConfig } from "../lib/config.js";
// Importable from plain Node precisely because the host half has no bare imports.
import { apply, TURN_END_QUERY_PATH, withClientConfig } from "../lib/index.js";
import { ANSWER_WINDOW_MS, createTurnEndLog, turnEndResponse } from "../lib/turn-end.js";

const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

let passed = 0;
const failures = [];
/**
 * Registered cases, run one at a time before the report. Sequential on
 * purpose: a Client-half case installs page globals, and two of them running at
 * once would answer each other's `fetch`.
 */
const cases = [];

/** Register one named test; failures are collected instead of stopping the run. */
function test(title, body) {
	cases.push({ title, body });
}

/** Config with every field resolved, mirroring the Loader's own defaults. */
function config(overrides = {}) {
	return {
		enabled: true,
		title: DEFAULTS.title,
		sound: "Glass",
		delivery: "auto",
		body: "session-title",
		notifyAborted: false,
		maxBodyChars: 160,
		...overrides,
	};
}

/** A session stand-in backed by a plain event array. */
function session(events, header = { cwd: "/Users/x/local_repo/demo" }, id = "session-1") {
	return {
		id,
		header: { version: 4, createdAt: 0, isSeeded: false, ...header },
		seq: events.length,
		eventAt: (seq) => events[seq],
	};
}

/** A context whose only service is the optional session title. */
function ctx(title) {
	return { get: (name) => (name === "sessionTitle" && title !== undefined ? { get: () => ({ title }) } : undefined) };
}

/** One `assistant/message` event carrying the given text. */
function assistant(text, turn = 1) {
	return { type: "assistant/message", seq: 0, time: 0, data: { turn, step: 1, message: { role: "assistant", content: [{ type: "text", text }] } } };
}

/** One `turn/end` event with the given reason. */
function turnEnd(reason, turn = 1) {
	return { type: "turn/end", seq: 0, time: 0, data: { turn, reason } };
}

test("flatten collapses whitespace into one line", () => {
	assert.equal(flatten("  hello\n\n  world \t!  ", 100), "hello world !");
});

test("flatten truncates with an ellipsis inside the budget", () => {
	const out = flatten("abcdefghij", 5);
	assert.equal(out, "abcd…");
	assert.equal(out.length, 5);
});

test("flatten tolerates null and undefined", () => {
	assert.equal(flatten(null, 10), "");
	assert.equal(flatten(undefined, 10), "");
});

test("appleScriptLiteral escapes quotes and backslashes", () => {
	assert.equal(appleScriptLiteral('say "hi"'), '"say \\"hi\\""');
	assert.equal(appleScriptLiteral("a\\b"), '"a\\\\b"');
});

test("appleScriptProgram orders title, subtitle, and sound", () => {
	assert.equal(
		appleScriptProgram({ title: "DSH", subtitle: "回答完成", body: "demo", sound: "Glass" }),
		'display notification "demo" with title "DSH" subtitle "回答完成" sound name "Glass"',
	);
});

test("appleScriptProgram omits the parts it was not given", () => {
	assert.equal(appleScriptProgram({ title: "", subtitle: "", body: "demo", sound: "" }), 'display notification "demo"');
	assert.equal(appleScriptProgram({ title: "DSH", subtitle: "", body: "demo", sound: "" }), 'display notification "demo" with title "DSH"');
});

test("isUserStop only matches an aborted turn caused by the user", () => {
	assert.equal(isUserStop({ kind: "aborted", reason: { kind: "user" } }), true);
	assert.equal(isUserStop({ kind: "aborted", reason: { kind: "hook", reason: "x" } }), false);
	assert.equal(isUserStop({ kind: "completed" }), false);
	assert.equal(isUserStop(undefined), false);
});

test("describeTurnEnd maps every turn-end reason", () => {
	assert.equal(describeTurnEnd({ kind: "completed" }).status, "回答完成");
	assert.equal(describeTurnEnd({ kind: "aborted", reason: { kind: "user" } }).status, "已停止");
	assert.equal(describeTurnEnd({ kind: "aborted", reason: { kind: "parent" } }).status, "已中断");
	assert.equal(describeTurnEnd({ kind: "max-tokens" }).status, "达到长度上限");
	assert.equal(describeTurnEnd({ kind: "blocked" }).status, "已阻止");
	assert.equal(describeTurnEnd({ kind: "forked" }).status, "已分叉");
	assert.equal(describeTurnEnd({ kind: "error", error: { message: "boom" } }).detail, "boom");
	assert.equal(describeTurnEnd(undefined).status, "回合结束");
});

test("textOfBlocks keeps only text blocks", () => {
	assert.equal(textOfBlocks([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a b");
	assert.equal(textOfBlocks([{ type: "reasoning", text: "hidden" }]), "");
	assert.equal(textOfBlocks(undefined), "");
});

test("lastReplyText returns the newest assistant text of that turn", () => {
	const events = [
		{ type: "turn/start", seq: 0, time: 0, data: { turn: 1 } },
		assistant("older"),
		{ type: "tool/result", seq: 2, time: 0, data: {} },
		turnEnd({ kind: "completed" }),
	];
	assert.equal(lastReplyText(session(events), 1), "older");
});

test("lastReplyText stops at the start of the turn it was asked about", () => {
	const events = [
		{ type: "turn/start", seq: 0, time: 0, data: { turn: 1 } },
		assistant("previous turn", 1),
		turnEnd({ kind: "completed" }, 1),
		{ type: "turn/start", seq: 3, time: 0, data: { turn: 2 } },
		turnEnd({ kind: "completed" }, 2),
	];
	assert.equal(lastReplyText(session(events), 2), "");
});

test("lastReplyText skips a reply whose blocks carry no text", () => {
	const events = [
		{ type: "turn/start", seq: 0, time: 0, data: { turn: 1 } },
		assistant("real answer"),
		{ type: "assistant/message", seq: 2, time: 0, data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "image" }] } } },
		turnEnd({ kind: "completed" }),
	];
	assert.equal(lastReplyText(session(events), 1), "real answer");
});

test("bodyOf prefers the session title by default", () => {
	const events = [assistant("a reply")];
	const out = bodyOf(ctx("重构登录模块"), session(events), 1, config());
	assert.equal(out, "重构登录模块");
});

test("bodyOf uses the reply when configured to", () => {
	const events = [
		{ type: "turn/start", seq: 0, time: 0, data: { turn: 1 } },
		assistant("the answer is 42"),
	];
	const out = bodyOf(ctx("title"), session(events), 1, config({ body: "reply" }));
	assert.equal(out, "the answer is 42");
});

test("bodyOf falls back to the title when the reply has no text", () => {
	const events = [{ type: "turn/start", seq: 0, time: 0, data: { turn: 1 } }];
	const out = bodyOf(ctx("title"), session(events), 1, config({ body: "reply" }));
	assert.equal(out, "title");
});

test("bodyOf falls back to the workspace directory, then the id", () => {
	const events = [];
	assert.equal(bodyOf(ctx(undefined), session(events), 1, config()), "demo");
	assert.equal(bodyOf(ctx(undefined), session(events, {}), 1, config()), "session-1");
});

test("bodyOf honours the none setting", () => {
	assert.equal(bodyOf(ctx("title"), session([]), 1, config({ body: "none" })), "");
});

test("bodyOf truncates to maxBodyChars", () => {
	const out = bodyOf(ctx("x".repeat(400)), session([]), 1, config({ maxBodyChars: 20 }));
	assert.equal(out.length, 20);
	assert.ok(out.endsWith("…"));
});

test("shouldNotify fires on a finished conversation turn", () => {
	assert.equal(shouldNotify(session([]), turnEnd({ kind: "completed" }), config()), true);
});

test("shouldNotify is silent while the plugin is switched off", () => {
	// The Client half asks this same predicate over the turn-end route, so
	// `enabled: false` has to reach it from here rather than only from the
	// Host's own delivery path.
	assert.equal(shouldNotify(session([]), turnEnd({ kind: "completed" }), config({ enabled: false })), false);
});

test("shouldNotify ignores everything that is not a turn end", () => {
	assert.equal(shouldNotify(session([]), { type: "step/end", data: {} }, config()), false);
	assert.equal(shouldNotify(session([]), undefined, config()), false);
});

test("shouldNotify ignores delegated child sessions", () => {
	const subagent = session([], { origin: "subagent" });
	assert.equal(shouldNotify(subagent, turnEnd({ kind: "completed" }), config()), false);
});

test("shouldNotify ignores a hand-stopped turn unless configured otherwise", () => {
	const stopped = turnEnd({ kind: "aborted", reason: { kind: "user" } });
	assert.equal(shouldNotify(session([]), stopped, config()), false);
	assert.equal(shouldNotify(session([]), stopped, config({ notifyAborted: true })), true);
});

test("bannerOf says only the title and the Session name on a clean finish", () => {
	const events = [assistant("done")];
	const banner = bannerOf(ctx("my chat"), session(events), turnEnd({ kind: "completed" }), config());
	assert.deepEqual(banner, { title: DEFAULTS.title, subtitle: "", body: "my chat", sound: "Glass" });
});

test("bannerOf adds a status line when the turn did not simply complete", () => {
	const aborted = bannerOf(ctx("my chat"), session([]), turnEnd({ kind: "aborted", reason: { kind: "parent" } }), config());
	assert.equal(aborted.subtitle, "已中断");
	assert.equal(aborted.body, "my chat");
});

test("bannerOf folds a short error detail into the subtitle", () => {
	const banner = bannerOf(ctx("my chat"), session([]), turnEnd({ kind: "error", error: { message: "upstream 503" } }), config());
	assert.equal(banner.subtitle, "出错了 · upstream 503");
});

test("the generated AppleScript compiles for adversarial banner text", () => {
	const scratch = mkdtempSync(join(tmpdir(), "dsh-notify-me-"));
	try {
		const hostile = [
			{ title: 'He said "hi"', subtitle: "quote \" and \\ backslash", body: "line\nbreak\ttab", sound: "Glass" },
			{ title: "DSH", subtitle: "回答完成", body: "emoji 🎉 中文 — mixed", sound: "" },
			{ title: "", subtitle: "", body: "", sound: "" },
			{ title: "a\\\"b", subtitle: "\\\\", body: '"', sound: "Ping" },
		];
		for (const [index, banner] of hostile.entries()) {
			const program = appleScriptProgram(banner);
			assert.ok(!program.includes("\n"), `program ${index} must stay on one line`);
			// osacompile parses the source; it never runs the notification.
			execFileSync("/usr/bin/osacompile", ["-e", program, "-o", join(scratch, `${index}.scpt`)], { stdio: "pipe" });
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("resolveConfig fills every default from an empty row", () => {
	assert.deepEqual(resolveConfig(undefined), { ...DEFAULTS });
	assert.deepEqual(resolveConfig({}), { ...DEFAULTS });
	assert.deepEqual(resolveConfig(null), { ...DEFAULTS });
});

test("resolveConfig keeps values of the declared type", () => {
	const config = resolveConfig({ title: "Heads up", body: "reply", sound: "", notifyAborted: true, maxBodyChars: 20 });
	assert.equal(config.title, "Heads up");
	assert.equal(config.body, "reply");
	assert.equal(config.sound, "");
	assert.equal(config.notifyAborted, true);
	assert.equal(config.maxBodyChars, 20);
});

test("resolveConfig rejects a wrong type and reports it once", () => {
	const warned = [];
	const config = resolveConfig({ title: 42, enabled: "yes" }, (message) => warned.push(message));
	assert.equal(config.title, DEFAULTS.title);
	assert.equal(config.enabled, true);
	assert.equal(warned.length, 2);
});

test("resolveConfig rejects an out-of-range maxBodyChars", () => {
	const warned = [];
	assert.equal(resolveConfig({ maxBodyChars: -1 }, (m) => warned.push(m)).maxBodyChars, 160);
	assert.equal(resolveConfig({ maxBodyChars: 1.5 }, (m) => warned.push(m)).maxBodyChars, 160);
	assert.equal(warned.length, 2);
});

test("resolveConfig rejects an unlisted enum value and reports it", () => {
	const warned = [];
	const config = resolveConfig({ body: "nope", delivery: "carrier-pigeon" }, (message) => warned.push(message));
	assert.equal(config.body, DEFAULTS.body);
	assert.equal(config.delivery, DEFAULTS.delivery);
	assert.equal(warned.length, 2);
});

test("resolveConfig reports unknown settings without failing", () => {
	const warned = [];
	const config = resolveConfig({ colour: "red" }, (message) => warned.push(message));
	assert.deepEqual(config, { ...DEFAULTS });
	assert.equal(warned.length, 1);
	assert.match(warned[0], /unknown setting "colour"/u);
});

test("resolveConfig ignores a non-object config", () => {
	assert.deepEqual(resolveConfig("nonsense"), { ...DEFAULTS });
	assert.deepEqual(resolveConfig([1, 2]), { ...DEFAULTS });
});

test("withClientConfig injects the delivery choice before </head>", () => {
	const html = "<html><head><title>x</title></head><body></body></html>";
	const out = withClientConfig(html, { delivery: "client" });
	assert.ok(out.includes("window.__DSH_NOTIFY_ME__="), "must publish the config");
	assert.ok(out.indexOf("__DSH_NOTIFY_ME__") < out.indexOf("</head>"), "must land inside head");
	assert.ok(out.includes("<title>x</title>"), "must not disturb the rest of the page");
});

test("withClientConfig publishes who speaks, and nothing that can go stale", () => {
	// A page outlives a config change, so only the gate that has to survive in
	// the page travels here; the per-turn policy is asked of the Host instead.
	const out = withClientConfig("<head></head>", { delivery: "osascript", enabled: false, notifyAborted: true });
	assert.match(out, /"delivery":"osascript"/u);
	assert.ok(!out.includes("enabled"), "a stale switch in the page would outlive the config it came from");
	assert.ok(!out.includes("notifyAborted"));
});

test("withClientConfig escapes a payload that could close the script tag", () => {
	const out = withClientConfig("<head></head>", { delivery: "</script><script>alert(1)" });
	assert.ok(!out.includes("</script><script>alert(1)"), "must not allow tag injection");
});

test("withClientConfig still publishes when the page has no head", () => {
	const out = withClientConfig("<body></body>", { delivery: "osascript" });
	assert.ok(out.includes("window.__DSH_NOTIFY_ME__="));
});

test("the client bundle registers under the package name", () => {
	const id = /load\(\{\s*id:\s*"([^"]+)"/u.exec(clientSource)?.[1];
	assert.equal(id, manifest.name, "the module-loader id must equal the package name, or the boot graph never loads it");
});

test("the client watcher claims the always-mounted seat", () => {
	// `sidebar.session.row.leading` mounts only while a row is idle, so a
	// watcher there is unmounted exactly when it has something to watch.
	// Match the registration call, not prose: the module doc explains why the
	// conditional row seat was abandoned and must stay free to name it.
	assert.ok(clientSource.includes('inject("shell.overlay"'), "the watcher must live in shell.overlay");
	assert.ok(!clientSource.includes('inject("sidebar.session.row.leading"'), "the conditional row seat must not come back");
});

test("the client speaks unless the Host explicitly claimed delivery", () => {
	// Staying silent on a MISSING config made one failed injection look exactly
	// like a working plugin with nothing to say. This guards that inversion.
	assert.ok(clientSource.includes('!== "osascript"'), "the gate must default to speaking");
});

test("the manifest declares the client half, and it exists", () => {
	assert.equal(manifest.dsh.client.platform, "web");
	const clientPath = manifest.exports["./client"];
	assert.ok(clientPath !== undefined, "the ./client export must exist");
	assert.doesNotThrow(() => readFileSync(new URL(`../${clientPath}`, import.meta.url), "utf8"));
});

test("the client styles only with theme tokens", () => {
	const styles = [...clientSource.matchAll(/(?:background|color|border):\s*"([^"]+)"/gu)].map((m) => m[1]);
	assert.ok(styles.length > 0, "expected inline styles to check");
	for (const value of styles) {
		assert.ok(value.includes("var(--dsw-alias-"), `style ${JSON.stringify(value)} must draw on a theme token`);
		assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/iu.test(value), `style ${JSON.stringify(value)} must not hard-code a color`);
	}
});

/**
 * Boot the Client half inside a stub module loader, so its watcher can be
 * driven through real status transitions without a browser.
 *
 * Nothing about the half itself is stubbed: the real `lib/client.js` source is
 * evaluated, its factory runs, and `apply` registers the real watcher. Only
 * what a page would supply — React, `Notification`, and the Host behind the
 * turn-end query — is fake, and each is as dumb as the watcher allows.
 * @param options - the injected page config, and the Host's answer.
 * @returns the raised banners, the asked URLs, a `render`, and a `dispose`.
 */
function bootClientHalf({ delivery = "client", answer = { announce: true }, fail = false } = {}) {
	const raised = [];
	const asked = [];
	const React = {
		createElement: () => null,
		useState: (initial) => [initial, () => {}],
		useEffect: (effect) => effect(),
	};
	let watcher = null;
	const previousNotification = globalThis.Notification;
	const previousFetch = globalThis.fetch;
	globalThis.Notification = class {
		static permission = "granted";

		static requestPermission() {
			return Promise.resolve("granted");
		}

		constructor(title, options = {}) {
			raised.push({ title, ...options });
		}
	};
	globalThis.fetch = async (url) => {
		asked.push(String(url));
		if (fail) throw new Error("no route");
		return Response.json(answer);
	};
	const windowStub = {
		__DSH_NOTIFY_ME__: { delivery },
		__ModuleLoader__: {
			load: ({ factory }) => {
				const client = factory((specifier) => {
					if (specifier === "react") return React;
					throw new Error(`the client half must not require ${specifier}`);
				});
				client.apply({
					get: () => undefined,
					slots: {
						inject: (_seat, register) => register(),
						register: (_options, component) => {
							watcher = component;
						},
					},
				});
			},
		},
	};
	// The bundle is a script that mounts itself on `window`, not a module, so
	// the page it expects is passed in as that one parameter.
	new Function("window", clientSource)(windowStub);
	return {
		raised,
		asked,
		/** Render the watcher once against one pair of store snapshots. */
		async render(statuses, sessions) {
			assert.ok(watcher !== null, "the client half must register a watcher component");
			watcher({
				useSessionStatus: (select) => select(statuses),
				useSessions: (select) => select(sessions),
			});
			// Let the turn-end query settle before the caller asserts.
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
		dispose() {
			globalThis.Notification = previousNotification;
			globalThis.fetch = previousFetch;
		},
	};
}

/** One status-map snapshot, shaped like the store `useSessionStatus` publishes. */
function statusMap(rows) {
	return new Map(Object.entries(rows).map(([id, running]) => [id, { running, pendingInteraction: undefined, completionUnread: false }]));
}

/** One Sessions-store snapshot, shaped like the controller's own projection. */
function sessionsStore(rows = {}) {
	const byId = {};
	for (const [id, row] of Object.entries(rows)) {
		byId[id] = { id, displayTitle: id, running: false, blank: false, updatedAt: 0, ...row };
	}
	return { ids: Object.keys(byId), byId, phase: "ready", projectionsBySession: {} };
}

test("the client watcher announces a conversation that stopped running", async () => {
	const client = bootClientHalf();
	try {
		const store = sessionsStore({ root: { title: "重构登录模块" } });
		await client.render(statusMap({ root: true }), store);
		assert.equal(client.raised.length, 0, "a cold start must announce nothing");
		await client.render(statusMap({ root: false }), store);
		assert.equal(client.raised.length, 1);
		assert.equal(client.raised[0].title, "会话轮次结束");
		assert.equal(client.raised[0].body, "重构登录模块");
	} finally {
		client.dispose();
	}
});

test("the client watcher asks the Host about the Session it just watched stop", async () => {
	const client = bootClientHalf();
	try {
		const store = sessionsStore({ root: { title: "重构登录模块" } });
		await client.render(statusMap({ root: true }), store);
		assert.equal(client.asked.length, 0, "a turn that is still running is not a question");
		await client.render(statusMap({ root: false }), store);
		assert.equal(client.asked.length, 1);
		assert.equal(client.asked[0], `${TURN_END_QUERY_PATH}?session=root`);
	} finally {
		client.dispose();
	}
});

test("the client watcher stays silent when the Host says the user stopped that turn", async () => {
	const client = bootClientHalf({ answer: { announce: false } });
	try {
		const store = sessionsStore({ root: { title: "重构登录模块" } });
		await client.render(statusMap({ root: true }), store);
		await client.render(statusMap({ root: false }), store);
		assert.equal(client.raised.length, 0, "a hand-stopped turn is not news");
	} finally {
		client.dispose();
	}
});

test("the client watcher announces what the Host cannot answer for", async () => {
	// A route that is missing, slow, or broken must not swallow the banner: the
	// visible failure is the one you can act on.
	const client = bootClientHalf({ fail: true });
	try {
		const store = sessionsStore({ root: { title: "重构登录模块" } });
		await client.render(statusMap({ root: true }), store);
		await client.render(statusMap({ root: false }), store);
		assert.equal(client.raised.length, 1);
	} finally {
		client.dispose();
	}
});

test("the client watcher announces what the Host has no record of", async () => {
	const client = bootClientHalf({ answer: {} });
	try {
		const store = sessionsStore({ root: { title: "重构登录模块" } });
		await client.render(statusMap({ root: true }), store);
		await client.render(statusMap({ root: false }), store);
		assert.equal(client.raised.length, 1, "only an explicit no silences the banner");
	} finally {
		client.dispose();
	}
});

test("the client watcher stays silent while the plugin is switched off", async () => {
	// `enabled: false` reaches the renderer as an answer rather than as silence
	// from the other half, because silence is not distinguishable from having
	// nothing to say.
	const client = bootClientHalf({ answer: { announce: false } });
	try {
		const store = sessionsStore({ root: { title: "重构登录模块" } });
		await client.render(statusMap({ root: true }), store);
		await client.render(statusMap({ root: false }), store);
		assert.equal(client.raised.length, 0);
		assert.equal(client.asked.length, 1, "the renderer still asks; the Host is what knows");
	} finally {
		client.dispose();
	}
});

test("the client watcher stays silent when a subagent child stops running", async () => {
	const client = bootClientHalf();
	try {
		const store = sessionsStore({
			root: { title: "重构登录模块" },
			child: { origin: "subagent", parentId: "root", title: "research the API" },
		});
		await client.render(statusMap({ root: true, child: true }), store);
		await client.render(statusMap({ root: true, child: false }), store);
		assert.equal(client.raised.length, 0, "a delegated child finishing is not the conversation finishing");
		assert.equal(client.asked.length, 0, "a delegated child is not worth a question");
		await client.render(statusMap({ root: false, child: false }), store);
		assert.equal(client.raised.length, 1, "the parent still earns its own banner");
		assert.equal(client.raised[0].body, "重构登录模块");
	} finally {
		client.dispose();
	}
});

test("the client watcher still announces a fork, which also rides parentId", async () => {
	// A fork is a conversation the user owns; only `origin` marks a delegated
	// child. Suppressing on `parentId` alone would swallow forked turns.
	const client = bootClientHalf();
	try {
		const store = sessionsStore({ fork: { parentId: "root", title: "分叉出来的对话" } });
		await client.render(statusMap({ fork: true }), store);
		await client.render(statusMap({ fork: false }), store);
		assert.equal(client.raised.length, 1);
	} finally {
		client.dispose();
	}
});

test("the client watcher announces a stop it cannot classify", async () => {
	// The store shape is not a contract this plugin was written against: an id
	// the store does not know must still raise a banner, because a banner too
	// many is visible while a missing one is not.
	const client = bootClientHalf();
	try {
		await client.render(statusMap({ ghost: true }), sessionsStore());
		await client.render(statusMap({ ghost: false }), sessionsStore());
		assert.equal(client.raised.length, 1);
	} finally {
		client.dispose();
	}
});

test("the client watcher stays silent when the Host owns delivery", async () => {
	const client = bootClientHalf({ delivery: "osascript" });
	try {
		const store = sessionsStore({ root: { title: "重构登录模块" } });
		await client.render(statusMap({ root: true }), store);
		await client.render(statusMap({ root: false }), store);
		assert.equal(client.raised.length, 0);
		assert.equal(client.asked.length, 0, "the half that is not speaking does not ask either");
	} finally {
		client.dispose();
	}
});

test("the turn-end log answers with what the Host decided", () => {
	const log = createTurnEndLog({ now: () => 1_000 });
	log.record("root", true);
	log.record("quiet", false);
	assert.equal(log.answer("root"), true);
	assert.equal(log.answer("quiet"), false);
});

test("the turn-end log answers an unknown Session with a banner", () => {
	const log = createTurnEndLog({ now: () => 1_000 });
	assert.equal(log.answer("never-seen"), true, "no record is not evidence of a hand stop");
});

test("a turn-end record expires instead of silencing a later turn", () => {
	let now = 1_000;
	const log = createTurnEndLog({ now: () => now });
	log.record("root", false);
	now += ANSWER_WINDOW_MS;
	assert.equal(log.answer("root"), false, "still inside the window");
	now += 1;
	assert.equal(log.answer("root"), true, "a stale record must not answer a fresh question");
});

test("the turn-end log keeps one entry per Session and evicts the oldest", () => {
	const log = createTurnEndLog({ now: () => 1_000, limit: 2 });
	log.record("a", false);
	log.record("b", false);
	log.record("a", true);
	log.record("c", false);
	assert.equal(log.answer("b"), true, "b is now the oldest and was evicted");
	assert.equal(log.answer("a"), true, "a was refreshed, so it outlived b");
	assert.equal(log.answer("c"), false);
});

test("the turn-end route answers the question the Client half asks", async () => {
	const log = createTurnEndLog({ now: () => 1_000 });
	log.record("root", false);
	const request = new Request(`http://127.0.0.1:19387${TURN_END_QUERY_PATH}?session=root`);
	const response = turnEndResponse(request, log, 1_000);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store", "an answer about the last turn must not be cached");
	assert.deepEqual(await response.json(), { announce: false });
});

test("the turn-end route refuses a request that names no Session", async () => {
	const log = createTurnEndLog();
	const response = turnEndResponse(new Request(`http://127.0.0.1:19387${TURN_END_QUERY_PATH}`), log, 1_000);
	assert.equal(response.status, 400);
	assert.equal(await response.text(), "missing session query parameter");
});

/**
 * A Host context carrying nothing but a Connection Fetch registry, so `apply`
 * can be exercised without a DSH process.
 * @param options - a registry to record into, or none at all.
 * @returns the registered routes, the wired listeners, and the warnings.
 */
function hostContext({ withRegistry = true } = {}) {
	const routes = [];
	const listeners = [];
	const warned = [];
	const connection = {
		fetch: {
			register: (route) => {
				routes.push(route);
				return () => {};
			},
		},
	};
	const scoped = {
		get: (name) => (withRegistry && name === "connection" ? connection : undefined),
		effect: (callback) => callback(),
	};
	return {
		routes,
		listeners,
		warned,
		context: {
			logger: { warn: (message) => warned.push(message), info: () => {} },
			get: () => undefined,
			inject: (_deps, callback) => callback(scoped),
			effect: (callback) => callback(),
			on: (name, listener) => listeners.push({ name, listener }),
		},
	};
}

/** The listener `apply` wired, by event name. */
function listenerOf(host, name) {
	const wired = host.listeners.find((entry) => entry.name === name);
	assert.ok(wired !== undefined, `apply must listen for ${name}`);
	return wired.listener;
}

test("the Host answers the turn-end question the Client half cannot", async () => {
	const host = hostContext();
	apply(host.context, { delivery: "client" });
	assert.equal(host.routes.length, 1, "the Host must offer the query route");
	const route = host.routes[0];
	assert.equal(route.path, TURN_END_QUERY_PATH);
	assert.deepEqual(route.methods, ["GET"]);
	const request = new Request(`http://127.0.0.1:19387${TURN_END_QUERY_PATH}?session=session-1`);
	const finished = listenerOf(host, "session/event");

	finished(session([]), turnEnd({ kind: "completed" }));
	assert.deepEqual(await (await route.fetch(request)).json(), { announce: true }, "a finished turn earns its banner");

	finished(session([]), turnEnd({ kind: "aborted", reason: { kind: "user" } }));
	assert.deepEqual(await (await route.fetch(request)).json(), { announce: false }, "a turn the user stopped does not");

	finished(session([]), turnEnd({ kind: "aborted", reason: { kind: "parent" } }));
	assert.deepEqual(await (await route.fetch(request)).json(), { announce: true }, "an interruption the user did not cause still does");
});

test("the Host answers questions about a delegated child too", async () => {
	// The renderer filters delegated children locally, but the Host must not
	// guess: it is asked about every Session, and its answer is the policy.
	const host = hostContext();
	apply(host.context, { delivery: "client" });
	const request = new Request(`http://127.0.0.1:19387${TURN_END_QUERY_PATH}?session=session-1`);
	listenerOf(host, "session/event")(session([], { origin: "subagent" }), turnEnd({ kind: "completed" }));
	assert.deepEqual(await (await host.routes[0].fetch(request)).json(), { announce: false });
});

test("the Host keeps answering after the plugin is switched off", async () => {
	// Silence from the Host is indistinguishable from having nothing to say, so
	// `enabled: false` has to arrive as an answer: the renderer raises banners on
	// its own side of the wire.
	const host = hostContext();
	apply(host.context, { delivery: "client", enabled: false });
	assert.equal(host.routes.length, 1, "the route outlives the switch");
	const request = new Request(`http://127.0.0.1:19387${TURN_END_QUERY_PATH}?session=session-1`);
	listenerOf(host, "session/event")(session([]), turnEnd({ kind: "completed" }));
	assert.deepEqual(await (await host.routes[0].fetch(request)).json(), { announce: false });
});

test("a Host with no Fetch registry still notifies, and says so", () => {
	const host = hostContext({ withRegistry: false });
	assert.doesNotThrow(() => apply(host.context, { delivery: "client" }), "a missing registry must not take the plugin down");
	assert.equal(host.routes.length, 0);
	assert.equal(host.warned.length, 1);
	assert.match(host.warned[0], /Client half cannot ask about turn ends/u);
});

test("the package imports nothing outside node: and its own files", () => {
	const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
	const specifiers = [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]);
	assert.ok(specifiers.length > 0, "expected to find imports");
	for (const specifier of specifiers) {
		assert.ok(
			specifier.startsWith("node:") || specifier.startsWith("."),
			`lib/index.js must not import the bare package ${JSON.stringify(specifier)}: a DSH Desktop host cannot resolve it from an out-of-tree plugin`,
		);
	}
});

for (const { title, body } of cases) {
	try {
		await body();
		passed += 1;
	} catch (error) {
		failures.push(`${title}\n    ${String(error?.message ?? error).split("\n").join("\n    ")}`);
	}
}

if (failures.length > 0) {
	console.error(`\n${failures.length} failing, ${passed} passing\n`);
	for (const failure of failures) console.error(`  ✗ ${failure}\n`);
	process.exit(1);
}
console.log(`ok — ${passed} tests passing`);
