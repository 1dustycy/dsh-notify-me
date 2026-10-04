/**
 * Unit tests for the banner decision surface. Nothing here spawns a
 * notification: the AppleScript path is checked by compiling the generated
 * program with `osacompile`, which validates syntax without running it.
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
import { withClientConfig } from "../lib/index.js";

const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

let passed = 0;
const failures = [];

/** Run one named test, collecting failures instead of stopping at the first. */
function test(title, body) {
	try {
		body();
		passed += 1;
	} catch (error) {
		failures.push(`${title}\n    ${error.message.split("\n").join("\n    ")}`);
	}
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

if (failures.length > 0) {
	console.error(`\n${failures.length} failing, ${passed} passing\n`);
	for (const failure of failures) console.error(`  ✗ ${failure}\n`);
	process.exit(1);
}
console.log(`ok — ${passed} tests passing`);
