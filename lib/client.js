/**
 * Client half of `dsh-notify-me`: the macOS banner the Host half cannot show.
 *
 * A DSH Desktop host runs the profile under the Electron binary in Node mode,
 * so it has no `Notification` API, and `osascript` can carry neither a click
 * action nor an app icon (ADR-0002). The renderer has both: a Web Notification
 * is attributed to the application — icon included — and its `onclick` can
 * select the Session that finished.
 *
 * The trigger is `useSessionStatus`, a standard slot-prop hook that answers for
 * EVERY Session, so a single occupant watches them all. That occupant lives in
 * `shell.overlay`, the always-mounted frame-wide layer.
 *
 * It deliberately does NOT live in a Session-row seat. `sidebar.session.row.leading`
 * looks like the obvious home — it even hands out `sessionId` — but a row mounts
 * that cell only while its own primary state is idle, so the watcher would be
 * unmounted at exactly the moment it has something to watch, and a lone running
 * Session would leave nothing observing it at all.
 *
 * @module dsh-notify-me/client
 */

window.__ModuleLoader__.load({
	id: "dsh-notify-me",
	factory(require) {
		const React = require("react");

		/** Last seen running state per Session, kept across occupant unmounts. */
		const wasRunning = new Map();
		/**
		 * Banners that have been raised and not yet dismissed. A Notification
		 * with no live reference is collectable, and collecting it takes its
		 * `onclick` handler with it — the click then does nothing at all. The
		 * set is the only thing keeping the handler reachable.
		 */
		const live = new Set();
		/** False until one full pass is recorded, so a cold start announces nothing. */
		let primed = false;
		/** Set by `apply`; selects a Session in the UI. */
		let navigate = () => {};
		/**
		 * Set by the mounted occupant; reports a banner that could not be raised.
		 * The renderer console is the only other witness, and it is not always
		 * at hand, so the failure is shown where the user already is.
		 */
		let reportFailure = () => {};

		/**
		 * Whether this half owns banner delivery. The Host half publishes its
		 * resolved `delivery` through the page, so exactly one half speaks.
		 *
		 * The test is inverted on purpose: this half speaks unless the Host
		 * explicitly claimed delivery. Staying silent on a MISSING config would
		 * make one failed injection indistinguishable from a working plugin that
		 * simply had nothing to say.
		 * @returns whether the Client half should raise banners.
		 */
		function ownsDelivery() {
			return window.__DSH_NOTIFY_ME__?.delivery !== "osascript";
		}

		/**
		 * Read one Session's running state out of whatever the status store
		 * holds. That store's exact shape is not part of a contract this plugin
		 * was written against, so every plausible spelling is accepted and an
		 * unrecognized one counts as "not running" rather than throwing.
		 * @param value - one Session's status entry.
		 * @returns whether that Session is running.
		 */
		function runningOf(value) {
			if (typeof value === "boolean") return value;
			if (typeof value === "string") return value === "running";
			if (value !== null && typeof value === "object") {
				if (typeof value.running === "boolean") return value.running;
				if (typeof value.status === "string") return value.status === "running";
				if (typeof value.isRunning === "boolean") return value.isRunning;
			}
			return false;
		}

		/**
		 * Normalize the status store into `[sessionId, running]` pairs.
		 * @param statuses - the store value, as a Map or a plain record.
		 * @returns one pair per recognizable Session.
		 */
		function collect(statuses) {
			const pairs = [];
			if (statuses === null || typeof statuses !== "object") return pairs;
			const entries = typeof statuses.entries === "function" ? [...statuses.entries()] : Object.entries(statuses);
			for (const [id, value] of entries) {
				if (typeof id === "string") pairs.push([id, runningOf(value)]);
			}
			return pairs;
		}

		/**
		 * Dig a Session title out of the workspace store, tolerating its shape.
		 * A banner with only the fixed heading is still worth showing, so every
		 * miss degrades to the empty string instead of throwing.
		 * @param store - the sessions/workspace store value.
		 * @param sessionId - the Session whose title is wanted.
		 * @returns the title, or the empty string.
		 */
		function titleOf(store, sessionId) {
			try {
				const candidates = [
					store?.sessionTitles?.[sessionId],
					store?.titles?.[sessionId],
					store?.sessions?.[sessionId]?.title,
					store?.byId?.[sessionId]?.title,
				];
				for (const candidate of candidates) {
					if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
				}
			} catch {
				// A title is a nicety; the heading alone still carries the news.
			}
			return "";
		}

		/** Raised once, so a broken click explains itself without spamming. */
		let reportedNavigationFailure = false;

		/**
		 * Say once why clicking the banner did nothing. A click that silently
		 * fails is indistinguishable from a click that was never delivered, and
		 * the renderer console is not always at hand.
		 * @param reason - what stopped the navigation.
		 */
		function reportNavigationFailure(reason) {
			if (reportedNavigationFailure) return;
			reportedNavigationFailure = true;
			try {
				const banner = new Notification("跳转失败", { body: reason });
				live.add(banner);
				banner.onclose = () => live.delete(banner);
			} catch {
				// There is nothing further to try with.
			}
		}

		/**
		 * Raise one banner for a Session whose turn just finished.
		 * @param sessionId - the Session to select when the banner is clicked.
		 * @param title - the Session title, or the empty string.
		 */
		function announce(sessionId, title) {
			if (!ownsDelivery()) return;
			if (typeof Notification === "undefined") {
				reportFailure("此环境没有 Notification API");
				return;
			}
			if (Notification.permission === "default") void Notification.requestPermission();
			if (Notification.permission !== "granted") {
				reportFailure(`通知权限是 "${Notification.permission}"，不是 granted`);
				return;
			}
			try {
				const banner = new Notification("会话轮次结束", title === "" ? undefined : { body: title });
				live.add(banner);
				const release = () => live.delete(banner);
				banner.onclose = release;
				banner.onerror = release;
				banner.onclick = () => {
					release();
					window.focus();
					try {
						navigate(sessionId);
					} catch {
						// Navigating is the point, but a failure here must not become
						// an unhandled error in the page.
					}
				};
			} catch {
				// A rejected banner must never take the slot entry down with it.
			}
		}

		/**
		 * The occupant: renders nothing, watches everything. It claims no pixels
		 * — the row's own state dot owns that cell — and returns null.
		 * @param props - the slot's standard props, including the selector hooks.
		 * @returns null, always.
		 */
		function Watcher(props) {
			const statuses = props.useSessionStatus((store) => store);
			const sessions = props.useSessions((store) => store);
			const [notice, setNotice] = React.useState("");
			React.useEffect(() => {
				reportFailure = setNotice;
				return () => {
					reportFailure = () => {};
				};
			}, []);
			React.useEffect(() => {
				const pairs = collect(statuses);
				if (primed) {
					for (const [sessionId, running] of pairs) {
						if (wasRunning.get(sessionId) === true && !running) announce(sessionId, titleOf(sessions, sessionId));
					}
				}
				wasRunning.clear();
				for (const [sessionId, running] of pairs) wasRunning.set(sessionId, running);
				primed = true;
			}, [statuses, sessions]);
			if (notice === "") return null;
			// Styled only with theme tokens, so it reads correctly in both themes.
			return React.createElement("div", {
				style: {
					position: "fixed", left: 12, bottom: 12, zIndex: 2147483000,
					padding: "8px 12px", borderRadius: 8, maxWidth: 360,
					fontSize: 12, lineHeight: 1.5, fontFamily: "inherit",
					background: "var(--dsw-alias-bg-overlay)",
					color: "var(--dsw-alias-label-primary)",
					border: "1px solid var(--dsw-alias-state-warn-primary)",
					boxShadow: "0 4px 16px rgba(0, 0, 0, 0.18)",
					pointerEvents: "none",
				},
			}, `通知没能弹出：${notice}`);
		}

		return {
			inject: ["slots"],
			apply(ctx) {
				// Resolved per click, never captured: a service looked up while
				// `apply` runs can still be absent, and binding it then would
				// freeze that absence for the life of the plugin.
				navigate = (sessionId) => {
					const uiWorkspace = ctx.get("uiWorkspace");
					if (typeof uiWorkspace?.openSession !== "function") {
						reportNavigationFailure("uiWorkspace.openSession 不可用");
						return;
					}
					try {
						uiWorkspace.openSession(sessionId);
					} catch (error) {
						reportNavigationFailure(`openSession 抛错：${String(error?.message ?? error)}`);
					}
				};
				ctx.slots.inject("shell.overlay", () => ctx.slots.register(
					{ name: "shell.overlay", id: "notify-me", order: 50 },
					Watcher,
				));
			},
		};
	},
});
