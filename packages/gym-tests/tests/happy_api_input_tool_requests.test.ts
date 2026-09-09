import { afterEach, describe, expect, it } from "vitest";
import { createAgentGym, frameEvent, type AgentGym } from "@slopus/happy-agent-gym";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("user input tool requests", () => {
    it.each([1_010_000, 6_000_000])(
        "fails %i-character tool arguments without blocking later messages or losing their history",
        async (length) => {
            const gym = await createAgentGym({
                files: { "requested.txt": "original" },
                inference: [
                    { content: [{ type: "text", text: "The requested tool failed." }] },
                    { content: [{ type: "text", text: "The next message still works." }] },
                ],
            });
            running.add(gym);
            const request = {
                type: "tool_call_request" as const,
                name: "exec_command",
                arguments: { cmd: `printf '${"x".repeat(length)}' > requested.txt` },
            };
            const sent = await gym.client.sendMessage(gym.defaultSessionId, {
                text: "Run this exact command",
                content: [request],
                mode: { ...gym.selection, permissionMode: "full_access", serviceTier: null },
            });
            await gym.waitForEvent(
                (event) => event.type === "run.finished",
                "oversized tool to fail normally",
            );
            const history = await gym.client.getMessages(gym.defaultSessionId);
            const messages = history.runs.flatMap((run) => run.messages);
            expect(messages[0]).toMatchObject({ id: sent.message.id, status: "accepted" });
            expect(messages[0]!.content).toContainEqual(request);
            expect(messages[1]).toMatchObject({
                content: [
                    {
                        type: "tool_call",
                        name: request.name,
                        arguments: request.arguments,
                        status: "failed",
                    },
                ],
            });
            expect(JSON.stringify(gym.inference.toolResults())).toContain("Tool arguments exceed");
            expect(await gym.readFile("requested.txt")).toBe("original");
            expect((await gym.client.getAgentBootstrap(gym.defaultSessionId)).pending).toEqual([]);
            await gym.restart();
            expect((await gym.client.getMessages(gym.defaultSessionId)).runs).toEqual(history.runs);
            await gym.send("Continue with a normal message.");
            expect(gym.inference.requests).toHaveLength(2);
            expect(gym.errors).toEqual([]);
        },
        30_000,
    );

    it.each(["allow", "deny"] as const)(
        "reviews user authorization before inference and honors %s",
        async (outcome) => {
            const order: string[] = [];
            let reviewText = "";
            const cmd = "printf 'updated' > requested.txt";
            const gym = await createAgentGym({
                files: { "requested.txt": "original" },
                inference: (request) => {
                    if (request.sessionId.startsWith("naming:"))
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "<title>Requested call</title><slug>requested-call</slug>",
                                },
                            ],
                        };
                    if (
                        request.instructions.includes(
                            "You are judging one planned coding-agent action.",
                        )
                    ) {
                        order.push("review");
                        reviewText = JSON.stringify(request.messages);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `<review><risk_level>low</risk_level><user_authorization>high</user_authorization><outcome>${outcome}</outcome><rationale>Reviewing the exact requested file write.</rationale></review>`,
                                },
                            ],
                        };
                    }
                    order.push("inference");
                    return { content: [{ type: "text", text: "Requested write settled." }] };
                },
            });
            running.add(gym);
            await gym.client.sendMessage(gym.defaultSessionId, {
                text: "Perform the requested operation.",
                content: [
                    {
                        type: "tool_call_request",
                        name: "exec_command",
                        arguments: {
                            cmd,
                            sandbox_permissions: "require_escalated",
                            justification: "Perform the exact user-requested write.",
                        },
                    },
                ],
                mode: { ...gym.selection, permissionMode: "auto", serviceTier: null },
            });
            await gym.waitForEvent(
                (event) => event.type === "run.finished",
                "reviewed requested call to settle",
            );
            expect(order).toEqual(["review", "inference"]);
            expect(reviewText).toContain(
                "User:\\nPerform the requested operation.\\nRequested tool (exec_command)",
            );
            expect(reviewText).toContain(cmd);
            expect(await gym.readFile("requested.txt")).toBe(
                outcome === "allow" ? "updated" : "original",
            );
            const call = (await gym.client.getMessages(gym.defaultSessionId)).runs
                .flatMap((run) => run.messages)
                .flatMap((message) => message.content)
                .find((block) => block.type === "tool_call");
            expect(call).toMatchObject({
                status: outcome === "allow" ? "completed" : "failed",
                review: { outcome: outcome === "allow" ? "allowed" : "denied" },
            });
            expect(gym.errors).toEqual([]);
        },
    );

    it.each([
        { name: "missing_tool", arguments: { nested: [true, null, "keep me"] } },
        { name: "invalid\ntool", arguments: {} },
        { name: "list_skills", arguments: { invalid: true } },
    ])("records an ordinary failed result for $name before inference", async (tool) => {
        const gym = await createAgentGym({
            inference: [{ content: [{ type: "text", text: "The requested call failed." }] }],
        });
        running.add(gym);
        const request = { type: "tool_call_request" as const, ...tool };
        const sent = await gym.client.sendMessage(gym.defaultSessionId, {
            text: "Run this exact request",
            content: [request],
            mode: { ...gym.selection, permissionMode: "auto", serviceTier: null },
        });
        await gym.waitForEvent(
            (event) => event.type === "run.finished",
            "failed requested call to settle",
        );
        const messages = (await gym.client.getMessages(gym.defaultSessionId)).runs.flatMap(
            (run) => run.messages,
        );
        expect(messages[0]).toMatchObject({
            id: sent.message.id,
            content: [{ type: "text", text: "Run this exact request" }, request],
        });
        expect(messages[1]).toMatchObject({
            content: [{ type: "tool_call", ...tool, status: "failed" }],
        });
        expect(gym.inference.requests).toHaveLength(1);
        expect(gym.inference.toolResults()).toHaveLength(1);
        expect(gym.inference.requests[0]!.messages.at(-1)).toMatchObject({
            role: "tool",
            isError: true,
        });
        expect(gym.errors).toEqual([]);
    });

    it("keeps a mixed request pending without execution until acceptance", async () => {
        let started!: () => void;
        let release!: () => void;
        const firstStarted = new Promise<void>((resolve) => {
            started = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let calls = 0;
        const gym = await createAgentGym({
            inference: async (request) => {
                if (request.sessionId.startsWith("naming:"))
                    return {
                        content: [{ type: "text", text: "<title>Tools</title><slug>tools</slug>" }],
                    };
                calls += 1;
                if (calls === 1) {
                    started();
                    await gate;
                }
                return { content: [{ type: "text", text: "Done" }] };
            },
        });
        running.add(gym);
        const mode = { ...gym.selection, permissionMode: "auto" as const, serviceTier: null };
        try {
            await gym.client.sendMessage(gym.defaultSessionId, { text: "Wait", mode });
            await firstStarted;
            const content = [
                { type: "text" as const, text: "Before" },
                { type: "tool_call_request" as const, name: "list_skills", arguments: {} },
                { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" },
            ];
            const queued = await gym.client.sendMessage(gym.defaultSessionId, {
                id: "pendinginputtool1",
                text: "Inspect",
                content,
                mode,
            });
            expect(queued.message).toMatchObject({
                status: "pending",
                content: [{ type: "text", text: "Inspect" }, ...content],
            });
            expect(
                (await gym.client.getAgentBootstrap(gym.defaultSessionId)).pending,
            ).toContainEqual(queued.message);
            expect(gym.inference.toolResults()).toEqual([]);
            const retry = await gym.client.sendMessage(gym.defaultSessionId, {
                id: queued.message.id,
                text: "Changed",
                mode,
            });
            expect(retry.message).toEqual(queued.message);
            release();
            const startedEvent = await gym.waitForEvent(
                (event) =>
                    event.type === "run.started" &&
                    event.payload.acceptedMessageIds.includes(queued.message.id),
                "queued request to be accepted",
            );
            if (startedEvent.type !== "run.started")
                throw new Error("Expected a queued run to start.");
            await gym.waitForRun(startedEvent.payload.run.id);
            const history = await gym.client.getMessages(gym.defaultSessionId);
            const accepted = history.runs
                .flatMap((run) => run.messages)
                .find((message) => message.id === queued.message.id);
            expect(accepted).toMatchObject({ status: "accepted", content: queued.message.content });
            expect(gym.inference.toolResults()).toHaveLength(1);
            await gym.restart();
            expect((await gym.client.getMessages(gym.defaultSessionId)).runs).toEqual(history.runs);
        } finally {
            release();
        }
    }, 60_000);

    it("executes before inference and preserves the request and call through events, retries, and restart", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ type: "text", text: "Skills inspected." }] }],
        });
        running.add(gym);
        const request = { type: "tool_call_request" as const, name: "list_skills" };
        const mode = { ...gym.selection, permissionMode: "auto" as const, serviceTier: null };
        const stream = gym.stream("/v0/events/stream");
        try {
            await stream.opened();
            const sent = await gym.client.sendMessage(gym.defaultSessionId, {
                id: "userrequestedtool1",
                text: "Inspect skills.",
                content: [request],
                mode,
            });
            expect(sent.message.content).toContainEqual(request);
            await gym.waitForEvent(
                (event) => event.type === "run.finished",
                "requested tool run to finish",
            );
            await stream.waitFor((frame) => frameEvent(frame)?.type === "run.finished");

            const history = await gym.client.getMessages(gym.defaultSessionId);
            const messages = history.runs.flatMap((run) => run.messages);
            expect(messages).toHaveLength(3);
            expect(messages[0]).toMatchObject({
                id: sent.message.id,
                role: "user",
                content: [{ type: "text", text: "Inspect skills." }, request],
            });
            expect(messages[1]).toMatchObject({
                role: "agent",
                content: [
                    { type: "tool_call", name: "list_skills", arguments: {}, status: "completed" },
                ],
            });
            expect(messages[2]).toMatchObject({
                role: "agent",
                content: [{ type: "text", text: "Skills inspected." }],
            });
            expect(new Set(messages.map((message) => message.id)).size).toBe(3);
            expect(gym.inference.requests).toHaveLength(1);
            expect(gym.inference.requests[0]!.messages.map((message) => message.role)).toEqual([
                "user",
                "assistant",
                "tool",
            ]);
            expect(JSON.stringify(gym.inference.requests[0]!.messages)).not.toContain(
                "tool_call_request",
            );
            expect(gym.inference.toolResults()).toHaveLength(1);

            const events = await gym.events();
            expect(
                events.some(
                    (event) =>
                        event.type === "message.created" &&
                        event.payload.message.content.some(
                            (block) => block.type === "tool_call_request",
                        ),
                ),
            ).toBe(true);
            // Acceptance is a run event, not a duplicate message.updated (API contract).
            expect(
                events.some(
                    (event) =>
                        event.type === "run.started" &&
                        event.payload.acceptedMessageIds.includes(sent.message.id),
                ),
            ).toBe(true);
            const createdIds = events.flatMap((event) =>
                event.type === "message.created" ? [event.payload.message.id] : [],
            );
            expect(createdIds).toEqual(messages.map((message) => message.id));
            const completedCall = events
                .filter(
                    (event) =>
                        event.type === "message.updated" &&
                        event.payload.message.id === messages[1]!.id,
                )
                .at(-1);
            expect(completedCall).toMatchObject({ payload: { message: messages[1] } });

            await gym.restart();
            expect((await gym.client.getMessages(gym.defaultSessionId)).runs).toEqual(history.runs);
            const retry = await gym.client.sendMessage(gym.defaultSessionId, {
                id: sent.message.id,
                text: "Do not replace the original",
                content: [{ ...request, name: "missing_tool" }],
                mode,
            });
            expect(retry.message).toEqual(messages[0]);
            expect(gym.inference.requests).toHaveLength(1);
            expect(gym.errors).toEqual([]);
        } finally {
            stream.close();
        }
    }, 60_000);
});
