import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const TOKEN = "424242:AAGymTelegramSecretTokenValue_0123456789";
const SECRET = TOKEN.slice(TOKEN.indexOf(":") + 1);
/** A second Telegram bot's token, for exporting a second Happy bot. */
const RANGER_TOKEN = "434343:AAGymRangerTelegramTokenValue_01234567";
const ADA = { id: 111, first_name: "Ada", last_name: "Lovelace", username: "ada" };
const GRACE = { id: 222, first_name: "Grace", last_name: "Hopper" };
const STRANGER = { id: 333, first_name: "Mallory", username: "mallory" };
const VISITOR = { id: 444, first_name: "Victor", username: "victor" };
/** The fixed notice a stranger receives once when they ask to be let in. */
const NOTICE =
    "Thanks for your message. This bot only talks to people its owner has approved, so your request was sent to them. If they approve it, the bot will answer the message you just sent.";
const SAFE_AUTH_FAILURE = "Authentication failed.\n\nRetry this conversation when ready.";

interface Sent {
    readonly chatId: number;
    readonly text: string;
    /** How many times the bot had shown "typing…" in this chat before this message arrived. */
    readonly typedBefore: number;
}

interface Update {
    readonly update_id: number;
    readonly message: Record<string, unknown>;
}

/**
 * The Bot API on loopback, serving one fake Telegram bot per token it knows. Only those tokens
 * are valid.
 */
class FakeBotApi {
    /** Requests made with any token the server does not know. */
    rejected = 0;
    readonly #bots = new Map<string, FakeTelegramBot>();
    readonly #server = createServer((request, response) => void this.#handle(request, response));

    /** Serve one more Telegram bot. */
    add(token: string, username: string): FakeTelegramBot {
        const bot = new FakeTelegramBot(Number(token.slice(0, token.indexOf(":"))), username);
        this.#bots.set(token, bot);
        return bot;
    }

    async start(): Promise<string> {
        await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
        return `http://127.0.0.1:${String((this.#server.address() as AddressInfo).port)}`;
    }

    async stop(): Promise<void> {
        for (const bot of this.#bots.values()) bot.wakeAll();
        this.#server.closeAllConnections();
        await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    }

    async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        let text = "";
        for await (const chunk of request) text += String(chunk);
        const body = (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
        const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(request.url ?? "");
        const bot = match === null ? undefined : this.#bots.get(match[1]!);
        if (bot === undefined) {
            this.rejected += 1;
            answer(response, 401, { ok: false, error_code: 401, description: "Unauthorized" });
            return;
        }
        await bot.handle(match![2]!, body, request, response);
    }
}

/**
 * The few Bot API methods an exported bot uses, for one Telegram bot, keeping every update it was
 * ever given the way an unconfirmed Telegram stream would: a poller that forgot its offset would
 * see them all again.
 */
class FakeTelegramBot {
    readonly sent: Sent[] = [];
    readonly typing: number[] = [];
    readonly offsets: (number | undefined)[] = [];
    /** Update IDs handed out again after the poller had already confirmed them. */
    readonly replayed: number[] = [];
    getMeCalls = 0;
    /** `getUpdates` requests waiting for an answer right now. */
    polling = 0;
    readonly #updates: Update[] = [];
    readonly #waiting = new Set<() => void>();
    #nextUpdateId = 1;
    #nextMessageId = 1;
    /** An update to hand out once more, as Telegram may after a network failure. */
    #replay: Update | undefined;

    constructor(
        readonly id: number,
        readonly username: string,
    ) {}

    wakeAll(): void {
        for (const wake of this.#waiting) wake();
    }

    /** A private-chat text message from `from`. Returns its update ID. */
    write(from: Record<string, unknown> & { id: number }, text: string): number {
        const update = {
            update_id: this.#nextUpdateId++,
            message: {
                message_id: this.#nextMessageId++,
                date: 1_700_000_000,
                chat: { id: from.id, type: "private", first_name: from["first_name"] },
                from: { is_bot: false, ...from },
                text,
            },
        };
        this.#updates.push(update);
        for (const wake of this.#waiting) wake();
        return update.update_id;
    }

    replay(updateId: number): void {
        this.#replay = this.#updates.find((update) => update.update_id === updateId);
    }

    repliesTo(chatId: number): string[] {
        return this.sent.filter((sent) => sent.chatId === chatId).map((sent) => sent.text);
    }

    typedIn(chatId: number): number {
        return this.typing.filter((typed) => typed === chatId).length;
    }

    async handle(
        method: string,
        body: Record<string, unknown>,
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        if (method === "getMe") {
            this.getMeCalls += 1;
            this.#ok(response, {
                id: this.id,
                is_bot: true,
                first_name: "Gym",
                username: this.username,
            });
        } else if (method === "getUpdates") {
            const offset = typeof body["offset"] === "number" ? body["offset"] : undefined;
            this.offsets.push(offset);
            const ready = () => this.#updates.filter((update) => update.update_id >= (offset ?? 0));
            this.polling += 1;
            if (ready().length === 0 && this.#replay === undefined) {
                await new Promise<void>((resolve) => {
                    const wake = () => {
                        this.#waiting.delete(wake);
                        resolve();
                    };
                    this.#waiting.add(wake);
                    request.socket.once("close", wake);
                });
            }
            this.polling -= 1;
            const replayed = this.#replay === undefined ? [] : [this.#replay];
            this.#replay = undefined;
            this.replayed.push(...replayed.map((update) => update.update_id));
            this.#ok(response, [...replayed, ...ready()]);
        } else if (method === "sendMessage") {
            const chatId = body["chat_id"] as number;
            this.sent.push({
                chatId,
                text: body["text"] as string,
                typedBefore: this.typedIn(chatId),
            });
            this.#ok(response, { message_id: this.#nextMessageId++ });
        } else if (method === "sendChatAction") {
            this.typing.push(body["chat_id"] as number);
            this.#ok(response, true);
        } else {
            answer(response, 404, { ok: false, error_code: 404, description: "Not Found" });
        }
    }

    #ok(response: ServerResponse, result: unknown): void {
        answer(response, 200, { ok: true, result });
    }
}

function answer(response: ServerResponse, status: number, body: unknown): void {
    if (response.destroyed) return;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}

const running = new Set<AgentGym>();
const servers = new Set<FakeBotApi>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
    await Promise.all([...servers].map(async (server) => await server.stop()));
    servers.clear();
}, 30_000);

/** How often the conversation an inference request carries was told about an access request. */
function accessRequestsIn(request: GymInferenceRequest | undefined, userId: number): number {
    return (request?.messages ?? [])
        .filter((message) => message.role === "user")
        .flatMap((message) => message.content)
        .filter(
            (block) =>
                block.type === "text" &&
                block.text.startsWith("Exported bot access request:") &&
                block.text.includes(`user ID "${String(userId)}"`),
        ).length;
}

function lastUserText(request: GymInferenceRequest): string {
    const message = request.messages.findLast((candidate) => candidate.role === "user");
    return (message?.content ?? [])
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
}

/**
 * A gym whose Chief of Staff runs exactly the tool calls a scenario asks of it, with Scout, a bot
 * of its own to export. Every Telegram conversation answers by repeating what it was told, says it
 * is on it and runs a command for as many seconds as a message starting with "WORK <seconds>:"
 * asks, and tries to run a command outside the sandbox when a message starts with "ESCALATE:". The Auto
 * reviewer keeps what it was shown and allows every action, except such a command that no
 * trusted user message asked for.
 */
async function telegramGym() {
    const api = new FakeBotApi();
    servers.add(api);
    const telegram = api.add(TOKEN, "gym_happy_bot");
    const apiUrl = await api.start();
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const reviews: string[] = [];
    let escalations = 0;
    let works = 0;
    const gym = await createAgentGym({
        timeoutMs: 30_000,
        config: `[telegram]\napi_url = "${apiUrl}"`,
        inference: (request) => {
            if (request.instructions.includes("<outcome>")) {
                const review = JSON.stringify(request.messages);
                reviews.push(review);
                const proposed = review.slice(review.lastIndexOf("<proposed_action>"));
                const outcome =
                    proposed.includes("exec_command") && !review.includes("User:\\nESCALATE:")
                        ? "deny"
                        : "allow";
                return {
                    content: [
                        {
                            type: "text",
                            text: `<review><outcome>${outcome}</outcome><risk>medium</risk><user_authorization>high</user_authorization><rationale>Scripted review.</rationale></review>`,
                        },
                    ],
                };
            }
            const command = commands.get(request.sessionId);
            if (command !== undefined && lastUserText(request).includes(command.callId)) {
                commands.delete(request.sessionId);
                return command.turn;
            }
            if (request.messages.at(-1)?.role === "tool") {
                return { content: [{ type: "text", text: "Done with that command." }] };
            }
            if (lastUserText(request) === "AUTH_FAILURE")
                return {
                    error: {
                        message: SAFE_AUTH_FAILURE,
                        providerError: { type: "authentication", diagnostics: { status: 401 } },
                    },
                };
            const work = /^WORK (\d+):/.exec(lastUserText(request));
            if (work !== null) {
                return {
                    content: [
                        { type: "text", text: "On it, this takes a moment." },
                        {
                            type: "tool_call",
                            name: "exec_command",
                            arguments: { cmd: `sleep ${work[1]!}`, yield_time_ms: 30_000 },
                            callId: `work${String(++works)}`,
                        },
                    ],
                };
            }
            if (lastUserText(request).startsWith("ESCALATE:")) {
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: "exec_command",
                            arguments: {
                                cmd: "echo released",
                                sandbox_permissions: "require_escalated",
                                justification: "Run the release command that was asked for.",
                            },
                            callId: `escalate${String(++escalations)}`,
                        },
                    ],
                };
            }
            return { content: [{ type: "text", text: `Answering: ${lastUserText(request)}` }] };
        },
    });
    running.add(gym);
    const chief = (await gym.client.listBots()).bots.find(
        (bot) => bot.systemKey === "chief_of_staff",
    )!;
    const scout = (await gym.client.createBot({ name: "Scout" })).bot;
    let calls = 0;
    /** Have the Chief of Staff run one tool, and return what the tool told it. */
    async function chiefRuns(
        name: string,
        args: Record<string, unknown>,
        permissionMode: "auto" | "full_access" = "full_access",
    ): Promise<string> {
        const callId = `chiefcall${String(++calls)}`;
        commands.set(chief.agent.id, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please run ${name}, request ${callId}.`, {
            sessionId: chief.agent.id,
            permissionMode,
        });
        const result = await gym.waitUntil(
            () => gym.inference.toolResults().find((item) => item.callId === callId),
            `${name} to finish`,
        );
        return result.text;
    }
    const chiefRequests = () =>
        gym.inference.requests.filter((request) => request.sessionId === chief.agent.id);
    // People reach Scout only through their own subtasks; its own conversation never takes part.
    const scoutRequests = () =>
        gym.inference.requests.filter((request) => request.sessionId === scout.agent.id);
    return { gym, api, telegram, chief, scout, chiefRuns, chiefRequests, scoutRequests, reviews };
}

describe("a bot exported to Telegram", () => {
    it("preserves the complete safe multiline authentication error in the Telegram reply", async () => {
        const { gym, telegram, scout, chiefRuns } = await telegramGym();
        await chiefRuns("set_telegram_exported_bot", {
            botId: scout.id,
            token: TOKEN,
            allowedUsers: [ADA.id],
        });
        telegram.write(ADA, "AUTH_FAILURE");
        const reply = await gym.waitUntil(
            () => telegram.repliesTo(ADA.id)[0],
            "terminal error Telegram reply",
        );
        expect(reply).toBe(`Sorry, I couldn't finish that reply. ${SAFE_AUTH_FAILURE}`);
    }, 30_000);

    it(
        "sends every text block as it is written and keeps showing typing until the run settles",
        { timeout: 120_000 },
        async () => {
            const { gym, telegram, scout, chiefRuns } = await telegramGym();
            await chiefRuns("set_telegram_exported_bot", {
                botId: scout.id,
                token: TOKEN,
                allowedUsers: [ADA.id, GRACE.id],
            });
            const sentTo = (chatId: number) =>
                telegram.sent.filter((sent) => sent.chatId === chatId);

            // The note written before the command reaches Ada while the command is still
            // running, rather than being dropped as working commentary.
            telegram.write(ADA, "WORK 9: rebuild the report.");
            const note = await gym.waitUntil(() => sentTo(ADA.id)[0], "Ada's progress note");
            expect(note.text).toBe("On it, this takes a moment.");
            const answer = await gym.waitUntil(() => sentTo(ADA.id)[1], "Ada's answer");
            expect(answer.text).toBe("Done with that command.");

            // Telegram shows "typing…" for about five seconds, so a nine-second command only
            // looks worked on if it is renewed while the command runs: right after the note,
            // which hides it, and on its own at least once more.
            expect(answer.typedBefore - note.typedBefore).toBeGreaterThanOrEqual(2);

            // Once Ada's run settles, nothing renews it. Grace's own nine-second command spans
            // more than two renewals, all of them in her chat.
            const ada = (await gym.client.getAgentActivity(scout.agent.id)).subagents.find(
                (agent) => agent.title === "Ada Lovelace on Telegram",
            )!;
            await gym.waitUntil(
                async () =>
                    (await gym.sessionEvents(ada.id)).some((event) => event.type === "run.finished")
                        ? true
                        : undefined,
                "Ada's run to settle",
            );
            const typedForAda = telegram.typedIn(ADA.id);
            telegram.write(GRACE, "WORK 9: tidy the archive.");
            const graceAnswer = await gym.waitUntil(
                () => sentTo(GRACE.id).find((sent) => sent.text === "Done with that command."),
                "Grace's answer",
            );
            expect(graceAnswer.typedBefore).toBeGreaterThanOrEqual(3);
            expect(telegram.typedIn(ADA.id)).toBe(typedForAda);
            expect(telegram.repliesTo(ADA.id)).toEqual([
                "On it, this takes a moment.",
                "Done with that command.",
            ]);
            expect(gym.errors).toEqual([]);
        },
    );

    it(
        "is exported by the Chief of Staff, admits people it allows on the fly, and gives each their own durable subtask",
        { timeout: 120_000 },
        async () => {
            const { gym, telegram, scout, chiefRuns, scoutRequests } = await telegramGym();
            expect(telegram.offsets).toEqual([]);

            // Exporting Scout checks the token with Telegram and starts polling without a
            // reload. This export ignores strangers instead of asking about them.
            const connected = await chiefRuns("set_telegram_exported_bot", {
                botId: scout.id,
                token: TOKEN,
                unknownSenders: "ignore",
            });
            expect(connected).toContain("(Telegram bot @gym_happy_bot, t.me/gym_happy_bot)");
            expect(connected).toContain("Allowed Telegram user IDs: none yet");
            expect(connected).toContain("People not on the allowlist are ignored.");
            await gym.waitUntil(
                () => (telegram.offsets.length > 0 ? true : undefined),
                "the export to start polling",
            );
            const getMeCalls = telegram.getMeCalls;

            // Before anyone is allowed, a message goes nowhere, but the Chief of Staff can see
            // who sent it and allow them.
            const hello = telegram.write(ADA, "Is this thing on?");
            await gym.waitUntil(
                () => (telegram.offsets.at(-1) === hello + 1 ? true : undefined),
                "the export to take in Ada's first message",
            );
            expect(await chiefRuns("get_exported_bot_status", {})).toContain(
                "Ignored a message from Telegram user 111 (@ada)",
            );
            const allowed = await chiefRuns("set_telegram_exported_bot", {
                botId: scout.id,
                allowedUsers: [ADA.id, GRACE.id],
            });
            expect(allowed).toContain("Allowed Telegram user IDs: 111, 222.");
            expect(allowed).not.toContain("Ignored a message from Telegram user 111");
            // The allowlist applied to the running export; nothing reconnected.
            expect(telegram.getMeCalls).toBe(getMeCalls);

            telegram.write(STRANGER, "Let me in, please.");
            const first = telegram.write(ADA, "Hello from Ada.");
            const adaReply = await gym.waitUntil(
                () => telegram.repliesTo(ADA.id)[0],
                "Ada's first reply",
            );
            expect(adaReply).toBe("Answering: Hello from Ada.");

            const conversations = async () =>
                (await gym.client.getAgentActivity(scout.agent.id)).subagents;
            const ada = (await conversations()).find(
                (agent) => agent.title === "Ada Lovelace on Telegram",
            );
            expect(ada).toBeDefined();
            const adaRequests = () =>
                gym.inference.requests.filter((request) => request.sessionId === ada!.id);
            expect(adaRequests()).toHaveLength(1);
            expect(adaRequests()[0]!.instructions).toContain("# Telegram conversation");
            expect(adaRequests()[0]!.instructions).toContain("Ada Lovelace (@ada)");
            expect(telegram.typing).toContain(ADA.id);

            // A second message reaches the same conversation.
            telegram.write(ADA, "Ada again.");
            await gym.waitUntil(
                () => telegram.repliesTo(ADA.id).find((text) => text.includes("Ada again.")),
                "Ada's second reply",
            );
            expect(adaRequests()).toHaveLength(2);

            // Another allowed person gets a conversation of their own, answered in their chat.
            const graceUpdate = telegram.write(GRACE, "Grace here.");
            await gym.waitUntil(
                () => telegram.repliesTo(GRACE.id).find((text) => text.includes("Grace here.")),
                "Grace's reply",
            );
            const grace = (await conversations()).find(
                (agent) => agent.title === "Grace Hopper on Telegram",
            );
            expect(grace).toBeDefined();
            expect(grace!.id).not.toBe(ada!.id);
            expect(telegram.repliesTo(ADA.id).some((text) => text.includes("Grace"))).toBe(false);
            await gym.waitUntil(
                () => (telegram.offsets.at(-1) === graceUpdate + 1 ? true : undefined),
                "the export to confirm Grace's update",
            );

            const status = await chiefRuns("get_exported_bot_status", {});
            expect(status).toContain(
                "The Telegram export of bot scout is connected (Telegram bot @gym_happy_bot",
            );
            expect(status).toContain(`Conversation with Ada Lovelace (111): subtask ${ada!.id}.`);
            expect(status).toContain("Ignored a message from Telegram user 333 (@mallory)");

            // Nothing from before Ada was allowed or from the stranger reached any model, and
            // nothing was sent to the stranger.
            const asked = JSON.stringify(gym.inference.requests.map((request) => request.messages));
            expect(asked).not.toContain("Is this thing on?");
            expect(asked).not.toContain("Let me in");
            expect(telegram.repliesTo(STRANGER.id)).toEqual([]);
            expect(telegram.repliesTo(ADA.id)).not.toContain(NOTICE);

            // The export is durable: after a restart it resumes after the last
            // update it took in, and Telegram offering a delivered update again changes nothing.
            const sentBefore = telegram.sent.length;
            const pollsBefore = telegram.offsets.length;
            await gym.restart();
            await gym.waitUntil(
                () => (telegram.offsets.length > pollsBefore ? true : undefined),
                "the restarted export to poll",
            );
            expect(telegram.offsets[pollsBefore]).toBe(graceUpdate + 1);
            telegram.replay(first);
            telegram.write(ADA, "After the restart.");
            await gym.waitUntil(
                () =>
                    telegram.repliesTo(ADA.id).find((text) => text.includes("After the restart.")),
                "Ada's reply after the restart",
            );
            expect(telegram.replayed).toEqual([first]);
            expect(adaRequests()).toHaveLength(3);
            expect(
                (await conversations()).filter((agent) => agent.title?.endsWith("on Telegram")),
            ).toHaveLength(2);
            expect(telegram.sent.length).toBe(sentBefore + 1);
            const adaSaid = adaRequests()
                .at(-1)!
                .messages.filter((message) => message.role === "user")
                .flatMap((message) => message.content)
                .filter((block) => block.type === "text" && block.text.includes("Hello from Ada."));
            expect(adaSaid).toHaveLength(1);

            // Removing the export stops polling at once and keeps the conversations.
            expect(
                await chiefRuns("remove_exported_bot", { kind: "telegram", botId: scout.id }),
            ).toContain("Stopped exporting the bot to Telegram.");
            await gym.waitUntil(
                () => (telegram.polling === 0 ? true : undefined),
                "the export to stop polling",
            );
            expect(await chiefRuns("get_exported_bot_status", {})).toBe("No bot is exported yet.");
            expect(
                (await conversations()).filter((agent) => agent.title?.endsWith("on Telegram")),
            ).toHaveLength(2);

            // No tool ever repeated the token, and the daemon never logged it.
            expect(gym.inference.toolResults().some((result) => result.text.includes(SECRET))).toBe(
                false,
            );
            const log = await readFile(join(gym.happyHome, "agent", "observation", "agent.log"));
            expect(log.length).toBeGreaterThan(0);
            expect(log.includes(SECRET)).toBe(false);
            expect(scoutRequests()).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
    );

    it(
        "needs the bot named, and refuses a token Telegram rejects and a Telegram bot that already serves another bot",
        { timeout: 60_000 },
        async () => {
            const { gym, api, telegram, scout, chiefRuns } = await telegramGym();
            const revoked = "424242:AARevokedTelegramTokenValue_9876543210";

            // A change never falls back to the Chief of Staff itself: the bot must be named.
            const unnamed = await chiefRuns("set_telegram_exported_bot", { token: TOKEN });
            expect(unnamed).toContain(
                'The arguments for "set_telegram_exported_bot" did not match',
            );
            expect(unnamed).toContain("botId");
            expect(unnamed).toContain("Required property is missing.");
            expect(
                await chiefRuns("approve_exported_bot_user", { kind: "telegram", userId: ADA.id }),
            ).toContain("Required property is missing.");
            expect(telegram.getMeCalls).toBe(0);

            expect(
                await chiefRuns("set_telegram_exported_bot", { botId: scout.id, token: revoked }),
            ).toContain("Telegram rejected the bot token.");
            expect(api.rejected).toBe(1);
            expect(await chiefRuns("get_exported_bot_status", {})).toBe("No bot is exported yet.");
            expect(telegram.offsets).toEqual([]);

            await chiefRuns("set_telegram_exported_bot", {
                botId: scout.id,
                token: TOKEN,
                allowedUsers: [ADA.id],
            });
            const ranger = (await gym.client.createBot({ name: "Ranger" })).bot;
            expect(
                await chiefRuns("set_telegram_exported_bot", { botId: ranger.id, token: TOKEN }),
            ).toContain("That Telegram bot is already connected to Scout.");
            // Status can be narrowed to one bot.
            expect(await chiefRuns("get_exported_bot_status", { botId: ranger.id })).toBe(
                "That bot is not exported yet.",
            );
            expect(await chiefRuns("get_exported_bot_status", { botId: scout.id })).toContain(
                "The Telegram export of bot scout is",
            );

            const log = await readFile(join(gym.happyHome, "agent", "observation", "agent.log"));
            expect(log.includes(revoked.slice(revoked.indexOf(":") + 1))).toBe(false);
            expect(log.includes(SECRET)).toBe(false);
            expect(gym.errors).toEqual([]);
        },
    );

    it(
        "asks the Chief of Staff once about a stranger writing to an exported bot, holds their message until approved for that bot, and stays silent to someone turned away",
        { timeout: 120_000 },
        async () => {
            const {
                gym,
                telegram,
                chief,
                scout,
                chiefRuns,
                chiefRequests,
                scoutRequests,
                reviews,
            } = await telegramGym();
            const connected = await chiefRuns("set_telegram_exported_bot", {
                botId: scout.id,
                token: TOKEN,
            });
            expect(connected).toContain("People not on the allowlist are asked about");
            await gym.waitUntil(
                () => (telegram.offsets.length > 0 ? true : undefined),
                "the export to start polling",
            );

            // A stranger's first message is held: the Chief of Staff is told who is asking, never
            // what they said, and the stranger is told once that their request was sent.
            telegram.write(STRANGER, "Please let me in, I need the quarterly numbers.");
            await gym.waitUntil(
                () =>
                    accessRequestsIn(chiefRequests().at(-1), STRANGER.id) === 1 ? true : undefined,
                "the Chief of Staff to hear about Mallory",
            );
            const again = telegram.write(STRANGER, "Hello? Anyone there?");
            await gym.waitUntil(
                () => (telegram.offsets.at(-1) === again + 1 ? true : undefined),
                "the export to take in Mallory's second message",
            );
            await gym.waitUntil(
                () => (telegram.repliesTo(STRANGER.id).length > 0 ? true : undefined),
                "Mallory's notice",
            );
            expect(telegram.repliesTo(STRANGER.id)).toEqual([NOTICE]);
            const request = chiefRequests().find(
                (candidate) => accessRequestsIn(candidate, STRANGER.id) === 1,
            )!;
            const told = JSON.stringify(request.messages);
            expect(told).toContain("Mallory");
            expect(told).toContain("@mallory");
            expect(told).toContain("Scout");
            expect(told).toContain(scout.id);
            expect(told).not.toContain("quarterly numbers");
            expect(request.instructions).toContain("# Exported bot access requests");
            const waiting = await chiefRuns("get_exported_bot_status", {});
            expect(waiting).toContain("Waiting to be let in since");
            expect(waiting).toContain("Mallory (@mallory), Telegram user 333.");
            expect(accessRequestsIn(chiefRequests().at(-1), STRANGER.id)).toBe(1);

            // Approving, reviewed in Auto, delivers the held message to a new conversation, which
            // answers it. The review names the person and never carries the token.
            const approved = await chiefRuns(
                "approve_exported_bot_user",
                { kind: "telegram", botId: scout.id, userId: STRANGER.id },
                "auto",
            );
            expect(approved).toContain("Approved Mallory (Telegram user 333) for Scout as guest ");
            expect(approved).toContain(
                "The message they were waiting with went to their conversation",
            );
            const reply = await gym.waitUntil(
                () =>
                    telegram
                        .repliesTo(STRANGER.id)
                        .find((text) => text.includes("quarterly numbers")),
                "Mallory's held message to be answered",
            );
            expect(reply).toBe("Answering: Please let me in, I need the quarterly numbers.");
            // Approval made Mallory exactly one guest, who wrote the held message and every
            // later one.
            const guestId = /as guest ([a-z0-9]+)\./.exec(approved)?.[1];
            expect(guestId).toBeDefined();
            const mallory = (await gym.client.getAgentActivity(scout.agent.id)).subagents.find(
                (agent) => agent.title === "Mallory on Telegram",
            )!;
            telegram.write(STRANGER, "One more thing.");
            await gym.waitUntil(
                () => telegram.repliesTo(STRANGER.id).find((text) => text.includes("One more")),
                "Mallory's second message to be answered",
            );
            const authors = (await gym.client.getMessages(mallory.id)).runs
                .flatMap((run) => run.messages)
                .filter((message) => message.role === "user")
                .map((message) => message.metadata.userId);
            expect(authors).toEqual([guestId, guestId]);
            expect((await gym.client.getUsers([guestId!])).users).toEqual([
                expect.objectContaining({ id: guestId, name: "Mallory", kind: "guest" }),
            ]);
            // The action under review names the person and the bot, and never the token. (The
            // token is earlier in the transcript, where the user pasted it to connect.)
            const proposed = reviews
                .map((review) => review.slice(review.lastIndexOf("<proposed_action>")))
                .find((action) => action.includes("approve_exported_bot_user"));
            expect(proposed).toMatch(new RegExp(`user ID\\W+333\\W+ talk to bot ${scout.id}`));
            expect(proposed).not.toContain(SECRET);
            const asked = JSON.stringify(gym.inference.requests.map((each) => each.messages));
            expect(asked).not.toContain("Anyone there?");
            // The conversation belongs to Scout, not to the Chief of Staff that let Mallory in.
            const subtaskTitles = async (agentId: string) =>
                (await gym.client.getAgentActivity(agentId)).subagents.map((agent) => agent.title);
            expect(await subtaskTitles(scout.agent.id)).toContain("Mallory on Telegram");
            expect(await subtaskTitles(chief.agent.id)).not.toContain("Mallory on Telegram");

            // Someone turned away is dropped silently from then on, and nobody is asked again.
            telegram.write(VISITOR, "Victor here, can I join?");
            await gym.waitUntil(
                () =>
                    accessRequestsIn(chiefRequests().at(-1), VISITOR.id) === 1 ? true : undefined,
                "the Chief of Staff to hear about Victor",
            );
            const denied = await chiefRuns("deny_exported_bot_user", {
                kind: "telegram",
                botId: scout.id,
                userId: "444",
            });
            expect(denied).toContain("Turned away Telegram user 444 from Scout.");
            expect(denied).toContain("The message they were waiting with was discarded.");
            const later = telegram.write(VISITOR, "Victor again, please?");
            await gym.waitUntil(
                () => (telegram.offsets.at(-1) === later + 1 ? true : undefined),
                "the export to take in Victor's later message",
            );
            const status = await chiefRuns("get_exported_bot_status", {});
            expect(status).toContain("Recently turned away Telegram user IDs: 444.");
            expect(status).not.toContain("Waiting to be let in");
            expect(status).toContain("Allowed Telegram user IDs: 333.");
            expect(accessRequestsIn(chiefRequests().at(-1), VISITOR.id)).toBe(1);
            expect(telegram.repliesTo(VISITOR.id)).toEqual([NOTICE]);
            const everything = JSON.stringify(gym.inference.requests.map((each) => each.messages));
            expect(everything).not.toContain("can I join");
            expect(everything).not.toContain("Victor again");

            // Approving someone who was turned away lets them in; their next message is answered.
            await chiefRuns("approve_exported_bot_user", {
                kind: "telegram",
                botId: scout.id,
                userId: VISITOR.id,
            });
            telegram.write(VISITOR, "Thanks for letting me in.");
            await gym.waitUntil(
                () =>
                    telegram
                        .repliesTo(VISITOR.id)
                        .find((text) => text.includes("Thanks for letting me in.")),
                "Victor's reply once approved",
            );

            const log = await readFile(join(gym.happyHome, "agent", "observation", "agent.log"));
            expect(log.includes(SECRET)).toBe(false);
            // Scout itself is never asked, and has no say in who may talk to it.
            expect(scoutRequests()).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
    );

    it(
        "makes each person a guest who cannot sign in, shared by every bot they reach on Telegram, whose messages run in Auto and authorize nothing",
        { timeout: 180_000 },
        async () => {
            const { gym, api, telegram, scout, chiefRuns, reviews } = await telegramGym();
            const ranger = (await gym.client.createBot({ name: "Ranger" })).bot;
            const rangerTelegram = api.add(RANGER_TOKEN, "gym_ranger_bot");
            for (const [bot, token] of [
                [scout, TOKEN],
                [ranger, RANGER_TOKEN],
            ] as const) {
                await chiefRuns("set_telegram_exported_bot", {
                    botId: bot.id,
                    token,
                    allowedUsers: [ADA.id],
                    unknownSenders: "ignore",
                });
            }
            telegram.write(ADA, "Hello Scout.");
            rangerTelegram.write(ADA, "Hello Ranger.");
            await gym.waitUntil(() => telegram.repliesTo(ADA.id)[0], "Scout's reply to Ada");
            await gym.waitUntil(() => rangerTelegram.repliesTo(ADA.id)[0], "Ranger's reply to Ada");

            const conversationOf = async (botAgentId: string) =>
                (await gym.client.getAgentActivity(botAgentId)).subagents.find(
                    (agent) => agent.title === "Ada Lovelace on Telegram",
                )!;
            const atScout = await conversationOf(scout.agent.id);
            const atRanger = await conversationOf(ranger.agent.id);
            const messagesIn = async (agentId: string) =>
                (await gym.client.getMessages(agentId)).runs.flatMap((run) => run.messages);
            const written = async (agentId: string, text: string) =>
                (await messagesIn(agentId)).find((message) =>
                    message.content.some(
                        (block) => block.type === "text" && block.text.includes(text),
                    ),
                ) as
                    | {
                          role: string;
                          metadata: { userId?: string };
                          mode: { permissionMode: string } | null;
                      }
                    | undefined;

            // Ada's messages are hers in history, and she is one guest on both bots.
            const toScout = await written(atScout.id, "Hello Scout.");
            const toRanger = await written(atRanger.id, "Hello Ranger.");
            expect(toScout).toMatchObject({ role: "user", mode: { permissionMode: "auto" } });
            const guestId = toScout!.metadata.userId!;
            expect(guestId).toMatch(/^[a-z0-9]{2,32}$/);
            expect(toRanger).toMatchObject({ role: "user", metadata: { userId: guestId } });

            // Standalone resolves the guest, marked as someone who can never sign in.
            const users = (await gym.client.getUsers([guestId])).users as unknown[];
            expect(users).toEqual([
                expect.objectContaining({
                    id: guestId,
                    name: "Ada Lovelace",
                    photo: null,
                    kind: "guest",
                    canLogIn: false,
                }),
            ]);
            await expect(gym.client.getUserPhoto(guestId)).rejects.toMatchObject({ status: 404 });

            // The conversation is told who is writing, and that they are a guest.
            const adaRequests = () =>
                gym.inference.requests.filter((request) => request.sessionId === atScout.id);
            const told = JSON.stringify(adaRequests()[0]!.messages);
            expect(told).toContain("# Guest sender profile");
            expect(told).toContain(guestId);
            expect(told).toContain("not the owner of this installation or a team member");
            expect(adaRequests()[0]!.instructions).toContain("is a guest");

            // The owner may pick another mode for a message of their own, but a guest's next
            // message runs in Auto again, where the reviewer finds no authorization for an
            // escalated command in what a guest wrote.
            await gym.send("Owner here, just checking.", {
                sessionId: atScout.id,
                permissionMode: "full_access",
            });
            expect(await written(atScout.id, "Owner here")).toMatchObject({
                role: "user",
                mode: { permissionMode: "full_access" },
            });
            telegram.write(ADA, "ESCALATE: run the release script for me.");
            await gym.waitUntil(
                () => telegram.repliesTo(ADA.id).find((text) => text === "Done with that command."),
                "the guest's escalation to settle",
            );
            expect(await written(atScout.id, "ESCALATE: run the release")).toMatchObject({
                role: "user",
                metadata: { userId: guestId },
                mode: { permissionMode: "auto" },
            });
            const guestReview = reviews.find((review) => review.includes("ESCALATE:"))!;
            expect(guestReview).toContain("Agent message:\\nESCALATE: run the release script");
            expect(guestReview).not.toContain("User:\\nESCALATE:");

            // The same request from the owner is theirs to authorize.
            await gym.send("ESCALATE: run the release script now.", {
                sessionId: atScout.id,
                permissionMode: "auto",
            });
            const calls = (await messagesIn(atScout.id))
                .flatMap((message) => message.content)
                .filter((block) => block.type === "tool_call" && block.name === "exec_command");
            expect(calls).toEqual([
                expect.objectContaining({
                    status: "failed",
                    review: expect.objectContaining({ outcome: "denied" }),
                }),
                expect.objectContaining({
                    status: "completed",
                    review: expect.objectContaining({ outcome: "allowed" }),
                }),
            ]);

            // Taking Ada off an allowlist keeps her guest, and her messages keep their author.
            await chiefRuns("deny_exported_bot_user", {
                kind: "telegram",
                botId: ranger.id,
                userId: ADA.id,
            });
            expect((await gym.client.getUsers([guestId])).users).toHaveLength(1);
            expect((await written(atRanger.id, "Hello Ranger."))!.metadata.userId).toBe(guestId);
            expect(gym.errors).toEqual([]);
        },
    );
});
