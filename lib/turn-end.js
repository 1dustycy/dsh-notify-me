/**
 * What the Host remembers about finished turns, and the answer it gives the
 * Client half when the Client asks about one.
 *
 * The Client half is the one that raises the banner, but a `turn/end` never
 * reaches it: its only stream is `useSessionStatus`, whose entries carry
 * `running` / `pendingInteraction` and no reason at all (ADR-0002). So the
 * renderer asks the Host over the authenticated fetch route this module's
 * answer feeds.
 *
 * What it asks is not "what happened" but "was this turn banner-worthy" — the
 * policy already lives on the half that sees `turn/end`, and answering with it
 * keeps one policy instead of two. The question the Host answers is therefore
 * the same predicate that decides its own delivery.
 *
 * @module dsh-notify-me/turn-end
 */

/** How long a recorded turn end stays a valid answer for a later request. */
export const ANSWER_WINDOW_MS = 10_000;

/** How many Sessions' most recent turn ends are remembered at once. */
export const ANSWER_LOG_LIMIT = 256;

/**
 * Build the Host's answer book: one entry per Session, holding whether the turn
 * that ended there earned a banner, and when it ended.
 *
 * The window is what keeps a stale entry from answering a fresh question. A
 * record older than the window answers "announce", which is also what an
 * unknown Session answers: a banner too many is visible, a banner silently
 * missing is not.
 *
 * @param options - window, size limit, and clock; all injected for tests.
 * @returns `record(sessionId, announce, at?)` and `answer(sessionId, at?)`.
 */
export function createTurnEndLog({ windowMs = ANSWER_WINDOW_MS, limit = ANSWER_LOG_LIMIT, now = Date.now } = {}) {
	/** Session id to `{ at, announce }`, in insertion order for eviction. */
	const entries = new Map();

	/** Drop entries no answer may use and any beyond the limit, oldest first. */
	function prune(at) {
		for (const [sessionId, entry] of entries) {
			if (at - entry.at > windowMs) entries.delete(sessionId);
		}
		while (entries.size > limit) entries.delete(entries.keys().next().value);
	}

	return {
		/**
		 * Remember the turn that just ended in one Session.
		 * @param sessionId - the Session whose turn ended.
		 * @param announce - whether that turn earned a banner.
		 * @param at - commit time, defaulting to now.
		 */
		record(sessionId, announce, at = now()) {
			// Re-inserting keeps eviction ordered by recency rather than by the
			// order a Session first appeared.
			entries.delete(sessionId);
			entries.set(sessionId, { at, announce: announce === true });
			prune(at);
		},

		/**
		 * Whether the turn that most recently ended in a Session earned a banner.
		 * @param sessionId - the Session the renderer is asking about.
		 * @param at - request time, defaulting to now.
		 * @returns whether the banner should be raised.
		 */
		answer(sessionId, at = now()) {
			const entry = entries.get(sessionId);
			if (entry === undefined || at - entry.at > windowMs) return true;
			return entry.announce;
		},
	};
}

/**
 * Answer one request from the Client half: the Fetch handler behind
 * `GET /api/notify-me.turn-end?session=<id>`, minus the routing.
 * @param request - the request the route received.
 * @param turnEnds - the Host's answer book.
 * @param at - request time, defaulting to now.
 * @returns a JSON response, or a 400 for a request that names no Session.
 */
export function turnEndResponse(request, turnEnds, at = Date.now()) {
	const sessionId = new URL(request.url).searchParams.get("session");
	if (sessionId === null || sessionId === "") {
		return new Response("missing session query parameter", { status: 400 });
	}
	return Response.json({ announce: turnEnds.answer(sessionId, at) }, { headers: { "cache-control": "no-store" } });
}
