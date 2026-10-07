/**
 * Pure banner construction for `dsh-notify-me`: everything that turns a
 * finished turn into the three strings a macOS notification is made of.
 *
 * Nothing here touches Cordis, Electron, or a child process, so the whole
 * decision surface is testable without a DSH host — which is the point of
 * keeping it apart from {@link module:dsh-notify-me}.
 *
 * @module dsh-notify-me/banner
 */

/** How many events back from the turn end a reply preview may look. */
export const REPLY_SCAN_LIMIT = 4000;

/** Longest error detail folded into the banner subtitle. */
export const DETAIL_CHARS = 60;

/**
 * Collapse arbitrary text onto a single line, without truncating it. A macOS
 * notification is a one-line surface, and an AppleScript string literal cannot
 * contain a line break at all.
 * @param text - any value; coerced to string.
 * @returns the text with every run of whitespace replaced by one space.
 */
export function singleLine(text) {
	return String(text ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * Flatten arbitrary text into one bounded single line.
 * @param text - any value; coerced to string.
 * @param maxChars - maximum length of the result, ellipsis included.
 * @returns the flattened text, never longer than `maxChars`.
 */
export function flatten(text, maxChars) {
	const flat = singleLine(text);
	if (flat.length <= maxChars) return flat;
	return `${flat.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Quote one value as an AppleScript string literal. Inside such a literal only
 * the backslash and the double quote carry meaning, so those are the only two
 * characters that need escaping.
 * @param text - any value; coerced to string.
 * @returns the quoted literal, escapes included.
 */
export function appleScriptLiteral(text) {
	return `"${String(text).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/**
 * Build the `osascript -e` program that shows one banner. Every field is
 * collapsed to a single line first, so the result is always a program
 * `osacompile` accepts, whatever the caller passed in.
 * @param banner - the resolved title, subtitle, body, and sound.
 * @returns an AppleScript program with no line breaks.
 */
export function appleScriptProgram({ title, subtitle, body, sound }) {
	const parts = [`display notification ${appleScriptLiteral(singleLine(body))}`];
	const heading = singleLine(title);
	if (heading !== "") parts.push(`with title ${appleScriptLiteral(heading)}`);
	const caption = singleLine(subtitle);
	if (caption !== "") parts.push(`subtitle ${appleScriptLiteral(caption)}`);
	const tone = singleLine(sound);
	if (tone !== "") parts.push(`sound name ${appleScriptLiteral(tone)}`);
	return parts.join(" ");
}

/**
 * Whether a turn ended because the user stopped it.
 * @param reason - the `turn/end` reason, possibly absent.
 * @returns whether the user is the cause.
 */
export function isUserStop(reason) {
	return reason?.kind === "aborted" && reason.reason?.kind === "user";
}

/**
 * Describe one `turn/end` reason for a human reader.
 * @param reason - the `turn/end` reason, possibly absent.
 * @returns the one-line status and, for failures, a short detail to append.
 */
export function describeTurnEnd(reason) {
	switch (reason?.kind) {
		case "completed":
			return { status: "回答完成", detail: "" };
		case "error":
			return { status: "出错了", detail: reason.error?.message ?? "" };
		case "max-tokens":
			return { status: "达到长度上限", detail: "" };
		case "blocked":
			return { status: "已阻止", detail: "" };
		case "interrupted":
			return { status: "已中断", detail: "" };
		case "forked":
			return { status: "已分叉", detail: "" };
		case "aborted":
			return { status: isUserStop(reason) ? "已停止" : "已中断", detail: "" };
		default:
			return { status: "回合结束", detail: "" };
	}
}

/**
 * Concatenate the text blocks of one message's content.
 * @param content - a message's content blocks, as committed to the session log.
 * @returns the joined text, or the empty string when there is none.
 */
export function textOfBlocks(content) {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join(" ")
		.trim();
}

/**
 * Read the newest assistant text written inside one turn, scanning backwards
 * from the turn end so a long session is never fully materialized.
 * @param session - the live session carrying the turn.
 * @param turn - the turn number that just ended.
 * @returns the reply text, or the empty string when the turn produced none.
 */
export function lastReplyText(session, turn) {
	const end = Number(session.seq);
	const floor = Math.max(0, end - REPLY_SCAN_LIMIT);
	for (let seq = end - 1; seq >= floor; seq -= 1) {
		const event = session.eventAt(seq);
		if (event === undefined) continue;
		if (event.type === "turn/start" && event.data?.turn === turn) break;
		if (event.type !== "assistant/message") continue;
		const text = textOfBlocks(event.data?.message?.content);
		if (text !== "") return text;
	}
	return "";
}

/**
 * Read the folded session title, which is advisory and may be absent.
 * @param ctx - plugin context, for the optional session-title service.
 * @param session - the session whose turn ended.
 * @returns the trimmed title, or the empty string.
 */
export function sessionTitleOf(ctx, session) {
	try {
		const title = ctx.get("sessionTitle")?.get(session)?.title;
		return typeof title === "string" ? title.trim() : "";
	} catch {
		return "";
	}
}

/**
 * Resolve the banner body for one finished turn, degrading from the configured
 * source to the session title, then the workspace directory, then the id — a
 * banner with a working title beats a banner that failed to build.
 * @param ctx - plugin context, for the optional session-title service.
 * @param session - the session whose turn ended.
 * @param turn - the turn number that just ended.
 * @param config - the resolved plugin config.
 * @returns the flattened body, or the empty string when `body` is `none`.
 */
export function bodyOf(ctx, session, turn, config) {
	if (config.body === "none") return "";
	if (config.body === "reply") {
		const reply = lastReplyText(session, turn);
		if (reply !== "") return flatten(reply, config.maxBodyChars);
	}
	const title = sessionTitleOf(ctx, session);
	if (title !== "") return flatten(title, config.maxBodyChars);
	const cwd = session.header?.cwd;
	if (typeof cwd === "string" && cwd !== "") {
		const name = cwd.split("/").filter(Boolean).pop();
		return flatten(name ?? cwd, config.maxBodyChars);
	}
	return String(session.id);
}

/**
 * Whether one committed session event deserves a banner. This is the whole
 * trigger policy: a finished turn, in a conversation rather than a delegated
 * child, that the user did not stop by hand — and a plugin that is switched on.
 *
 * The Client half asks this same question over `GET /api/notify-me.turn-end`
 * before it raises its own banner, so a rule added here reaches both halves
 * instead of only the one that can see `turn/end`.
 * @param session - the session the event was committed to.
 * @param event - the committed session event.
 * @param config - the resolved plugin config.
 * @returns whether to show a banner.
 */
export function shouldNotify(session, event, config) {
	if (!config.enabled) return false;
	if (event?.type !== "turn/end") return false;
	if (session?.header?.origin === "subagent") return false;
	if (!config.notifyAborted && isUserStop(event.data?.reason)) return false;
	return true;
}

/**
 * Resolve the whole banner for one finished turn.
 *
 * A turn that simply completed says nothing beyond the title and the Session
 * name: the reader already knows what "会话轮次结束" means, and a third line
 * would only repeat it. A turn that ended any other way does say so — that is
 * the case where the banner has news.
 *
 * @param ctx - plugin context, for the optional session-title service.
 * @param session - the session whose turn ended.
 * @param event - the `turn/end` event that just committed.
 * @param config - the resolved plugin config.
 * @returns the title, subtitle, body, and sound to show.
 */
export function bannerOf(ctx, session, event, config) {
	const { status, detail } = describeTurnEnd(event?.data?.reason);
	const note = detail === "" ? status : `${status} · ${flatten(detail, DETAIL_CHARS)}`;
	return {
		title: config.title,
		subtitle: event?.data?.reason?.kind === "completed" ? "" : note,
		body: bodyOf(ctx, session, event?.data?.turn, config),
		sound: config.sound,
	};
}
