import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";
import { createGuestServer } from "../../happy-bot-invite-bridge/sources/GuestServer.js";
import { GuestStore } from "../../happy-bot-invite-bridge/sources/persistence/GuestStore.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
}, 30_000);
const nonce = () => randomBytes(32).toString("base64url");

async function scenario(live: boolean) {
    const commands = new Map<string, GymTurn>();
    const gym = await createAgentGym({
        ...(live
            ? {
                  config: `[providers.clip_live]\ntype="codex"\nenabled=true\nauth_file=${JSON.stringify(process.env.HAPPY_CLIP_LIVE_AUTH_FILE)}\n`,
                  liveProviders: ["clip_live"],
              }
            : {}),
        timeoutMs: live ? 120_000 : 30_000,
        inference(request) {
            if (request.instructions.includes("<outcome>"))
                return {
                    content: [
                        {
                            type: "text",
                            text: "<review><outcome>allow</outcome><risk>low</risk><user_authorization>high</user_authorization><rationale>Isolated scenario.</rationale></review>",
                        },
                    ],
                };
            const command = commands.get(request.sessionId);
            if (command !== undefined) {
                commands.delete(request.sessionId);
                return command;
            }
            const text =
                request.messages
                    .findLast((message) => message.role === "user")
                    ?.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
                    .join("\n") ?? "";
            return { content: [{ type: "text", text: `Answering: ${text}` }] };
        },
    });
    cleanups.push(async () => await gym.dispose());
    const chief = (await gym.client.listBots()).bots.find(
        (bot) => bot.username === "chief_of_staff",
    )!;
    const firstBot = (await gym.client.createBot({ name: "Clip one" })).bot;
    const secondBot = (await gym.client.createBot({ name: "Clip two" })).bot;
    const store = await GuestStore.open(join(gym.workspacePath, "clip-state"));
    cleanups.push(async () => await store.close());
    const first = await store.createInvite({
        botId: firstBot.id,
        botName: firstBot.name,
        maxMembers: 2,
        expiresAt: Date.now() + 86_400_000,
        readOnly: false,
    });
    const second = await store.createInvite({
        botId: secondBot.id,
        botName: secondBot.name,
        maxMembers: 1,
        expiresAt: Date.now() + 86_400_000,
        readOnly: false,
    });
    let calls = 0;
    const exportBot = async (botId: string, userIds: string[]) => {
        const callId = `clip_export_${++calls}`;
        commands.set(chief.agent.id, {
            content: [
                {
                    type: "tool_call",
                    name: "set_bridge_exported_bot",
                    callId,
                    arguments: {
                        botId,
                        service: "App Clip",
                        tokenFile: `clip-${calls}.token`,
                        allowedUsers: userIds,
                        unknownSenders: "ignore",
                    },
                },
            ],
        });
        await gym.send(
            `Export only the isolated test bot for guests ${userIds.join(", ")}, request ${callId}.`,
            { sessionId: chief.agent.id, permissionMode: "full_access" },
        );
        const result = await gym.waitUntil(
            () => gym.inference.toolResults().find((entry) => entry.callId === callId),
            "export tool result",
        );
        const tokenFile = /written to (\S+), readable/.exec(result.text)?.[1];
        if (tokenFile === undefined) throw new Error(`Export failed: ${result.text}`);
        return {
            botId,
            connectUrl: `ws+unix://${gym.socketPath}:/v0/exported-bots/connect?protocol=1`,
            bridgeToken: (await readFile(tokenFile, "utf8")).trim(),
        };
    };
    const exports = [
        await exportBot(firstBot.id, first.userIds),
        await exportBot(secondBot.id, second.userIds),
    ];
    await store.approve(first.id, 2);
    await store.approve(second.id, 1);
    if (live) {
        await gym.send(
            "You are a disposable App Clip test bot. Answer guests concisely. Do not use any tools or access files. Reply exactly READY to this setup message.",
            {
                sessionId: firstBot.agent.id,
                providerId: "clip_live",
                modelId: "openai/gpt-6.1-sol",
                effort: "low",
                permissionMode: "auto",
            },
        );
    }
    const failures: Error[] = [];
    const gateway = createGuestServer({ store, exports, fatal: (error) => failures.push(error) });
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => await gateway.stop());
    const address = gateway.server.address();
    if (address === null || typeof address === "string") throw new Error("Missing HTTP listener");
    const origin = `http://127.0.0.1:${address.port}`;
    gateway.start();
    await gym.waitUntil(
        () => ([...gateway.bridges.values()].every((bridge) => bridge.online) ? true : undefined),
        "both dedicated bridges online",
    );
    const redeem = async (token: string, displayName = "Guest") => {
        const response = await fetch(`${origin}/v1/bot-invites/redeem`, {
            method: "POST",
            body: JSON.stringify({ token, redeemNonce: nonce(), displayName }),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as {
            sessionId: string;
            sessionToken: string;
            botName: string;
            memberId: string;
            displayName: string;
        };
    };
    const a = await redeem(first.token, "Ada");
    const c = await redeem(first.token, "Zoë");
    const b = await redeem(second.token);
    const full = await fetch(`${origin}/v1/bot-invites/redeem`, {
        method: "POST",
        body: JSON.stringify({ token: first.token, redeemNonce: nonce(), displayName: "Third" }),
    });
    expect(full.status).toBe(410);
    expect(await full.json()).toMatchObject({ code: "invite_full" });
    const url = (id: string) => `${origin}/v1/bot-guest/sessions/${id}/messages`;
    const headers = (token: string) => ({ authorization: `Bearer ${token}` });
    expect((await fetch(url(a.sessionId))).status).toBe(401);
    expect(
        (
            await fetch(url(a.sessionId), {
                method: "POST",
                headers: headers(a.sessionToken),
                body: JSON.stringify({ localId: "bad id", text: "Hello" }),
            })
        ).status,
    ).toBe(400);
    expect(
        (
            await fetch(url(a.sessionId), {
                method: "POST",
                headers: headers(a.sessionToken),
                body: JSON.stringify({ localId: "large", text: "x".repeat(17_000) }),
            })
        ).status,
    ).toBe(413);
    const readerInvite = await store.createInvite({
        botId: firstBot.id,
        botName: firstBot.name,
        maxMembers: 1,
        expiresAt: Date.now() + 86_400_000,
        readOnly: true,
    });
    const pending = await fetch(`${origin}/v1/bot-invites/redeem`, {
        method: "POST",
        body: JSON.stringify({
            token: readerInvite.token,
            redeemNonce: nonce(),
            displayName: "Reader",
        }),
    });
    expect(pending.status).toBe(503);
    expect(pending.headers.get("retry-after")).toBe("1");
    await store.approve(readerInvite.id, 1);
    const reader = await redeem(readerInvite.token);
    expect(
        (
            await fetch(url(reader.sessionId), {
                method: "POST",
                headers: headers(reader.sessionToken),
                body: JSON.stringify({ localId: "one", text: "Hello" }),
            })
        ).status,
    ).toBe(403);
    const input = live
        ? `Reply exactly CLIP_LIVE_${nonce()} and nothing else. Do not use tools.`
        : "Private first guest message";
    const send = async (session: typeof a, text: string) =>
        await fetch(url(session.sessionId), {
            method: "POST",
            headers: headers(session.sessionToken),
            body: JSON.stringify({ localId: "one", text }),
        });
    expect((await send(a, input)).status).toBe(202);
    expect((await send(a, input)).status).toBe(202);
    expect((await send(b, "Second guest only")).status).toBe(202);
    expect((await send(c, "Same invite second member")).status).toBe(202);
    const awaitReply = async (session: typeof a, description: string) => {
        let cursor: string | null = null;
        const messages: { role: string; text: string }[] = [];
        return await gym.waitUntil(
            async () => {
                const response = await fetch(
                    `${url(session.sessionId)}?wait=25${cursor === null ? "" : `&after=${cursor}`}`,
                    { headers: headers(session.sessionToken) },
                );
                expect(response.status).toBe(200);
                const page = (await response.json()) as {
                    cursor: string | null;
                    messages: { role: string; text: string }[];
                };
                cursor = page.cursor;
                messages.push(...page.messages);
                return messages.some((message) => message.role === "assistant")
                    ? { messages }
                    : undefined;
            },
            description,
            live ? 120_000 : 30_000,
        );
    };
    const aReply = await awaitReply(a, "first guest receives actual exported bot reply");
    if (live)
        expect(aReply.messages.at(-1)?.text).toContain(input.match(/CLIP_LIVE_[A-Za-z0-9_-]+/)![0]);
    else expect(aReply.messages.at(-1)?.text).toBe(`Answering: ${input}`);
    const bReply = await awaitReply(b, "second export independently replies");
    const cReply = await awaitReply(c, "another member of the same invite independently replies");
    expect(JSON.stringify(cReply)).not.toContain(input);
    expect(JSON.stringify(bReply)).not.toContain(input);
    expect((await fetch(url(a.sessionId), { headers: headers(b.sessionToken) })).status).toBe(404);
    const children = (await gym.client.getAgentActivity(firstBot.agent.id)).subagents;
    expect(children).toHaveLength(2);
    const ada = children.find((child) => child.title === "Ada on App Clip");
    expect(ada).toBeDefined();
    expect(children.some((child) => child.title === "Zoë on App Clip")).toBe(true);
    const guestHistory = await gym.client.getMessages(ada!.id);
    const guestMessages = guestHistory.runs
        .flatMap((run) => run.messages)
        .filter((message) => message.role === "user");
    expect(guestMessages).toHaveLength(1);
    const guestUserId = guestMessages[0]!.metadata.userId!;
    expect((await gym.client.getUsers([guestUserId])).users[0]).toMatchObject({
        kind: "guest",
        canLogIn: false,
    });
    const currentPage = (await (
        await fetch(url(a.sessionId), { headers: headers(a.sessionToken) })
    ).json()) as { cursor: string };
    const requestStarted = new Promise<void>((resolve) =>
        gateway.server.once("request", () => resolve()),
    );
    const waitingResponse = fetch(`${url(a.sessionId)}?after=${currentPage.cursor}&wait=25`, {
        headers: headers(a.sessionToken),
    });
    await requestStarted;
    await store.revokeMember(first.id, a.memberId);
    expect((await waitingResponse).status).toBe(404);
    expect((await fetch(url(a.sessionId), { headers: headers(a.sessionToken) })).status).toBe(404);
    expect((await send(a, "No longer allowed")).status).toBe(404);
    expect((await fetch(url(c.sessionId), { headers: headers(c.sessionToken) })).status).toBe(200);
    const reported = await fetch(`${origin}/v1/bot-guest/sessions/${b.sessionId}/report`, {
        method: "POST",
        headers: headers(b.sessionToken),
        body: "{}",
    });
    expect(reported.status).toBe(200);
    expect(await store.reports()).toEqual([
        { inviteId: second.id, memberId: b.memberId, reportedAt: expect.any(Number) },
    ]);
    const blocked = await fetch(`${origin}/v1/bot-guest/sessions/${b.sessionId}/block`, {
        method: "POST",
        headers: headers(b.sessionToken),
        body: "{}",
    });
    expect(blocked.status).toBe(200);
    expect((await fetch(url(b.sessionId), { headers: headers(b.sessionToken) })).status).toBe(404);
    let rateLimited: Response | undefined;
    for (let i = 0; i < 11; i++) {
        const response = await fetch(`${origin}/v1/bot-invites/redeem`, {
            method: "POST",
            body: JSON.stringify({ token: nonce(), redeemNonce: nonce(), displayName: "Guest" }),
        });
        if (response.status === 429) {
            rateLimited = response;
            break;
        }
    }
    expect(rateLimited?.headers.get("retry-after")).toBe("60");
    expect(failures).toEqual([]);
    expect(gym.errors).toEqual([]);
}

describe("App Clip invitation bridge through the real exported-bot pipeline", () => {
    it(
        "keeps two exports and guests isolated with durable, idempotent exchanges",
        async () => await scenario(false),
        90_000,
    );
    it.skipIf(process.env.HAPPY_CLIP_LIVE_AUTH_FILE === undefined)(
        "receives a real online model reply in an isolated guest subtask",
        async () => await scenario(true),
        240_000,
    );
});
