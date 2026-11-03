import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Entry = Record<string, unknown>;

/**
 * A Pi session as far as the extension sees it, with a titling model that
 * answers with `titles` in turn. Like Pi, setting the name reports the
 * change before setSessionName returns.
 */
function fakeSession(titles: string[], entries: Entry[] = []) {
	const handlers = new Map<string, Handler[]>();
	const requests: Array<{ systemPrompt?: string; user: string }> = [];
	let name = [...entries].reverse().find((entry) => entry.type === "session_info")?.name as
		| string
		| undefined;

	const setName = (next: string) => {
		name = next;
		entries.push({ type: "session_info", name: next });
		emit("session_info_changed", { type: "session_info_changed", name: next });
	};

	const pi = {
		on: (type: string, handler: Handler) => handlers.set(type, [...(handlers.get(type) ?? []), handler]),
		registerCommand: () => {},
		getSessionName: () => name,
		setSessionName: setName,
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	};

	const ctx = {
		model: { provider: "mock", id: "mock-1" },
		modelRegistry: {
			find: () => undefined,
			hasConfiguredAuth: () => true,
			complete: async (
				_model: unknown,
				request: { systemPrompt?: string; messages: Array<{ content: Array<{ text: string }> }> },
			) => {
				requests.push({ systemPrompt: request.systemPrompt, user: request.messages[0].content[0].text });
				return { content: [{ type: "text", text: titles.shift() ?? "" }], provider: "mock", model: "mock-1" };
			},
		},
		sessionManager: {
			getSessionId: () => "test-session",
			getEntries: () => entries,
			getBranch: () => entries,
		},
		ui: { notify: () => {} },
	};

	function emit(type: string, event: unknown) {
		for (const handler of handlers.get(type) ?? []) {
			handler(event, ctx);
		}
	}

	extension(pi as unknown as ExtensionAPI);
	emit("session_start", { type: "session_start", reason: "startup" });

	return {
		requests,
		entries,
		get name() {
			return name;
		},
		/** The user names the session, as /name does. */
		rename: setName,
		/**
		 * The user submits a prompt: the run starts before the prompt is in
		 * the session. Resolves once any titling it started has finished.
		 */
		async submit(prompt: string) {
			emit("before_agent_start", { type: "before_agent_start", messageType: "user", prompt });
			await new Promise((resolve) => setImmediate(resolve));
		},
		/** A run started by a custom message, not by a prompt. */
		async custom() {
			emit("before_agent_start", { type: "before_agent_start", messageType: "custom", message: {} });
			await new Promise((resolve) => setImmediate(resolve));
		},
		/** One turn: a prompt is submitted, then the agent answers it. */
		async turn(prompt: string, reply: string) {
			await this.submit(prompt);
			entries.push(
				{ type: "message", message: { role: "user", content: prompt } },
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: reply }] } },
			);
			emit("agent_settled", { type: "agent_settled", aborted: false });
			await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

const renames = (entries: Entry[]) => entries.filter((entry) => entry.type === "session_info").length;

describe("titling over a session", () => {
	let dir: string;
	const saved: Record<string, string | undefined> = {};
	const vars = [
		"PI_CODING_AGENT_DIR",
		"PI_AUTO_TITLE",
		"PI_AUTO_TITLE_MODEL",
		"PI_AUTO_TITLE_LANGUAGE",
		"PI_AUTO_TITLE_WORDS",
		"PI_AUTO_TITLE_UPDATE",
	];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-auto-title-"));
		for (const name of vars) {
			saved[name] = process.env[name];
			delete process.env[name];
		}

		process.env.PI_CODING_AGENT_DIR = dir;
	});

	afterEach(() => {
		for (const name of vars) {
			if (saved[name] === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = saved[name];
			}
		}

		rmSync(dir, { recursive: true, force: true });
	});

	it("titles a session as soon as its first prompt is submitted", async () => {
		const session = fakeSession(["Login fix"]);
		await session.submit("Fix the login form");

		assert.equal(session.name, "Login fix");
		assert.equal(session.requests[0].user, "Conversation to title:\n\nUser: Fix the login form");
		assert.doesNotMatch(session.requests[0].systemPrompt ?? "", /current title/);
	});

	it("does not title again when the agent settles", async () => {
		const session = fakeSession(["Login fix", "Other"]);
		await session.turn("Fix the login form", "Fixed the validation");

		assert.equal(session.name, "Login fix");
		assert.equal(session.requests.length, 1);
	});

	it("ignores runs started by custom messages", async () => {
		const session = fakeSession(["Login fix"]);
		await session.custom();

		assert.equal(session.name, undefined);
		assert.equal(session.requests.length, 0);
	});

	it("updates the title on later prompts, from the new prompt", async () => {
		const session = fakeSession(["Login fix", "Signup form"]);
		await session.turn("Fix the login form", "Fixed the validation");
		await session.submit("Now the signup form");

		assert.equal(session.name, "Signup form");
		assert.match(session.requests[1].user, /^Current title: Login fix/);
		assert.match(session.requests[1].user, /How the session started:\n\nUser: Fix the login form\n\n/);
		assert.match(session.requests[1].user, /Latest exchange:\n\nUser: Now the signup form$/);
		assert.match(session.requests[1].systemPrompt ?? "", /current title unchanged if it still fits/);
	});

	it("leaves the name alone when the title still fits", async () => {
		const session = fakeSession(["Login fix", "Login fix"]);
		await session.turn("Fix the login form", "Fixed the validation");
		await session.turn("Also the error message", "Reworded it");

		assert.equal(session.name, "Login fix");
		assert.equal(renames(session.entries), 1);
	});

	it("titles only once when told to", async () => {
		writeFileSync(join(dir, "pi-auto-title.json"), '{ "update": "once" }');
		const session = fakeSession(["Login fix", "Signup form"]);
		await session.turn("Fix the login form", "Fixed the validation");
		await session.turn("Now the signup form", "Rebuilt it");

		assert.equal(session.name, "Login fix");
		assert.equal(session.requests.length, 1);
	});

	it("never renames a session the user named", async () => {
		const session = fakeSession(["Login fix"]);
		session.rename("Mine");
		await session.turn("Fix the login form", "Fixed the validation");

		assert.equal(session.name, "Mine");
		assert.equal(session.requests.length, 0);
	});

	it("stops updating once the user renames the session", async () => {
		const session = fakeSession(["Login fix", "Signup form"]);
		await session.turn("Fix the login form", "Fixed the validation");
		session.rename("Mine");
		await session.turn("Now the signup form", "Rebuilt it");

		assert.equal(session.name, "Mine");
		assert.equal(session.requests.length, 1);
	});

	it("keeps updating a resumed session it titled", async () => {
		const session = fakeSession(
			["Signup form"],
			[
				{ type: "message", message: { role: "user", content: "Fix the login form" } },
				{ type: "custom", customType: "pi-auto-title", data: { applied: true, title: "Login fix" } },
				{ type: "session_info", name: "Login fix" },
			],
		);
		await session.turn("Now the signup form", "Rebuilt it");

		assert.equal(session.name, "Signup form");
	});

	it("leaves a resumed session the user named alone", async () => {
		const session = fakeSession(
			["Signup form"],
			[
				{ type: "message", message: { role: "user", content: "Fix the login form" } },
				{ type: "custom", customType: "pi-auto-title", data: { applied: true, title: "Login fix" } },
				{ type: "session_info", name: "Mine" },
			],
		);
		await session.turn("Now the signup form", "Rebuilt it");

		assert.equal(session.name, "Mine");
		assert.equal(session.requests.length, 0);
	});
});
