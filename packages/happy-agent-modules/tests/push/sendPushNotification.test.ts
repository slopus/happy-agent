import { createHash } from "node:crypto";

import { AgentKV, type AgentModuleScope, type AnyAgentTool } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { afterEach, expect, it, vi } from "vitest";

import { InMemoryPersistence } from "../support/InMemoryPersistence.js";

import {
    ALICE,
    BOB,
    id,
    member,
    phone,
    RELAY,
    startWorld,
    stubRelay,
    type PushWorldAgents,
} from "./support/pushWorld.js";

const AGENT = "pfh0haxfpzowht3oi213cqos";
const HELPER = "h3lperagentaaaaaaaaaaaaa";
const FIRST_CALL = "c1aaaaaaaaaaaaaaaaaaaaaa";
const SECOND_CALL = "c2aaaaaaaaaaaaaaaaaaaaaa";

afterEach(() => {
    vi.unstubAllGlobals();
});

type World = Awaited<ReturnType<typeof startWorld>>;

/** One agent as its hooks see it, with a run store that lasts until the run settles. */
function agent(agentId: string): AgentModuleScope {
    return {
        agent: { id: agentId, metadata: undefined },
        runKV: new AgentKV(new InMemoryPersistence(), `run.${agentId}.`),
    } as unknown as AgentModuleScope;
}

async function toolOf(world: World, scope: AgentModuleScope): Promise<AnyAgentTool | undefined> {
    const tools = (await world.hooks.tools?.(world.ctx, scope)) ?? [];
    return tools.find((tool) => tool.name === "send_push_notification");
}

/** Call the tool as the agent loop does: validated arguments, then the rendered result. */
async function call(world: World, scope: AgentModuleScope, callId: string, input: unknown) {
    const tool = await toolOf(world, scope);
    if (tool === undefined) throw new Error("The agent does not hold the tool.");
    if (!Value.Check(tool.parameters, input)) throw new Error("The arguments are invalid.");
    const result: unknown = await tool.execute(world.ctx, input, { id: callId } as never);
    return tool.toLLM(result);
}

/** End the agent's run as the loop does: the settling hook, then the run store is erased. */
async function settle(world: World, scope: AgentModuleScope, error?: string) {
    await world.ctx.inTx(async (txCtx) => {
        await world.hooks.afterAgentSettledTransact?.(txCtx, scope, {
            loopId: "loop-1",
            settlementId: "settlement-1",
            ...(error === undefined ? {} : { error }),
        });
        await scope.runKV.clear(txCtx);
    });
    await world.settle();
}

async function world(name: string, team = false, agents?: PushWorldAgents) {
    return await startWorld(name, { team, ...(agents === undefined ? {} : { agents }) });
}

it("offers the tool the push program specifies, loaded by default and never reviewed", async () => {
    const standalone = await world("tool-definition");
    try {
        const tool = await toolOf(standalone, agent(AGENT));
        if (tool === undefined) throw new Error("The agent does not hold the tool.");

        expect(tool.name).toBe("send_push_notification");
        // The same text Happy Cloud pins, so the two servers cannot drift apart.
        expect(createHash("sha256").update(String(tool.description)).digest("hex")).toBe(
            "5e268d1261ce0562ec6ff33ace780a2684a6a8a140a25442772ceef242fa7de7",
        );
        expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual({
            type: "object",
            additionalProperties: false,
            properties: {
                title: { type: "string", minLength: 1, maxLength: 80 },
                subtitle: { type: "string", maxLength: 160 },
            },
            required: ["title"],
        });
        // Byte for byte what a plain string schema sends, although the limits count characters.
        expect(JSON.stringify(tool.parameters?.properties)).toBe(
            '{"title":{"minLength":1,"maxLength":80,"type":"string"},"subtitle":{"maxLength":160,"type":"string"}}',
        );
        expect(tool.defer).toBe(false);
        expect(tool.capabilities).toEqual(["Send a push notification to the person you work for."]);
        // Every permission mode, no review, and no elevation.
        expect(tool.requiresAutoOrFullAccess).toBeUndefined();
        expect(tool.autoReview).toBe("never");
        expect(await tool.shouldReviewInAutoMode({ title: "x" }, standalone.ctx)).toBe(false);
        expect(tool.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(tool.toLLM({ ok: true })).toEqual([{ type: "text", text: '{"ok":true}' }]);
    } finally {
        standalone.close();
    }
});

it.each([
    ["no title", {}],
    ["an empty title", { title: "" }],
    ["a title over 80 characters", { title: "x".repeat(81) }],
    ["a subtitle over 160 characters", { title: "x", subtitle: "y".repeat(161) }],
    ["a recipient", { title: "x", userId: ALICE }],
    ["the old body field", { title: "x", body: "y" }],
])("refuses a call with %s", async (_name, input) => {
    const standalone = await world("tool-invalid");
    try {
        const tool = await toolOf(standalone, agent(AGENT));
        expect(tool === undefined ? undefined : Value.Check(tool.parameters, input)).toBe(false);
    } finally {
        standalone.close();
    }
});

it("counts a title and a subtitle in characters, as Happy Cloud does", async () => {
    const standalone = await world("tool-characters");
    try {
        await standalone.push.register(standalone.ctx, id(1), phone(1));
        const relay = stubRelay();
        const scope = agent(AGENT);
        const tool = await toolOf(standalone, scope);
        if (tool === undefined) throw new Error("The agent does not hold the tool.");
        // One character outside the Basic Multilingual Plane is two UTF-16 units and one character.
        const title = "\u{1F680}".repeat(80);
        const subtitle = "\u{1F4A5}".repeat(160);

        expect(Value.Check(tool.parameters, { title: `${title}\u{1F680}` })).toBe(false);
        expect(Value.Check(tool.parameters, { title, subtitle: `${subtitle}\u{1F4A5}` })).toBe(
            false,
        );
        // Half of a pair is no character at all.
        expect(Value.Check(tool.parameters, { title: "\ud83d" })).toBe(false);
        expect(Value.Check(tool.parameters, { title, subtitle: "\udca5" })).toBe(false);
        expect(Value.Check(tool.parameters, { title: 80 })).toBe(false);

        expect(await call(standalone, scope, FIRST_CALL, { title, subtitle })).toEqual([
            { type: "text", text: '{"ok":true}' },
        ]);
        await settle(standalone, scope);
        expect(relay.map((request) => [request.body.title, request.body.body])).toEqual([
            [title, subtitle],
        ]);
    } finally {
        standalone.close();
    }
});

it("answers ok at once and sends the last call of the run when the agent goes idle", async () => {
    const standalone = await world("tool-idle");
    try {
        await standalone.push.register(standalone.ctx, id(1), phone(1));
        const relay = stubRelay();
        const scope = agent(AGENT);

        expect(
            await call(standalone, scope, FIRST_CALL, {
                title: "Looking into the failing deploy",
                subtitle: "Reading the logs",
            }),
        ).toEqual([{ type: "text", text: '{"ok":true}' }]);
        expect(
            await call(standalone, scope, SECOND_CALL, {
                title: "iOS preview 24 uploaded; prod is blocked",
            }),
        ).toEqual([{ type: "text", text: '{"ok":true}' }]);
        await standalone.settle();
        // Nothing leaves at call time.
        expect(relay).toEqual([]);

        await settle(standalone, scope);

        expect(relay).toEqual([
            {
                url: RELAY,
                method: "POST",
                contentType: "application/json",
                redirect: "manual",
                body: {
                    to: "HappyPushToken[phone00000000000000001]",
                    title: "iOS preview 24 uploaded; prod is blocked",
                    body: "",
                    data: {
                        kind: "happy.cloud.push.v1",
                        instanceId: "k3x9q2m7p0a4b8c1d5e6f7g2",
                        userId: "standalone",
                        agentId: "pfh0haxfpzowht3oi213cqos",
                        notificationId: "c2aaaaaaaaaaaaaaaaaaaaaa",
                    },
                    sound: "default",
                    channelId: "messages",
                    ttl: 300,
                },
            },
        ]);

        // The run is over: a later run that says nothing sends nothing, and one that speaks sends.
        await settle(standalone, scope);
        expect(relay).toHaveLength(1);
        await call(standalone, scope, FIRST_CALL, {
            title: "Found why cloud replies show twice",
            subtitle: "Fix and test ready, uncommitted. Open a PR?",
        });
        await settle(standalone, scope);
        expect(relay.map((request) => [request.body.title, request.body.body])).toEqual([
            ["iOS preview 24 uploaded; prod is blocked", ""],
            ["Found why cloud replies show twice", "Fix and test ready, uncommitted. Open a PR?"],
        ]);
    } finally {
        standalone.close();
    }
});

it("gives the tool to a person's own agents and subtasks, and never to a hidden helper", async () => {
    const standalone = await world("tool-visible", false, {
        parents: { [HELPER]: AGENT, subtaskaaaaaaaaaaaaaaaaa: AGENT },
        subtasks: ["subtaskaaaaaaaaaaaaaaaaa"],
    });
    try {
        await standalone.push.register(standalone.ctx, id(1), phone(1));
        const relay = stubRelay();

        expect(await toolOf(standalone, agent(AGENT))).toBeDefined();
        expect(await toolOf(standalone, agent("subtaskaaaaaaaaaaaaaaaaa"))).toBeDefined();
        expect(await toolOf(standalone, agent(HELPER))).toBeUndefined();

        // A record that reached a hidden agent's run by any other road still sends nothing.
        const helper = agent(HELPER);
        await helper.runKV.write(standalone.ctx, "pending", {
            notificationId: FIRST_CALL,
            title: "Removed 4.43 GB as usual",
            body: "",
        });
        await settle(standalone, helper);

        expect(relay).toEqual([]);
        expect(standalone.logs).toEqual([
            `push:notification outcome=hidden_agent notificationId=${FIRST_CALL} agentId=${HELPER}`,
        ]);
    } finally {
        standalone.close();
    }
});

it.each([
    [
        "the run failed",
        async (standalone: World, scope: AgentModuleScope) => {
            await settle(standalone, scope, "You've hit your usage limit.");
        },
        "run_failed",
    ],
    [
        "the turn was stopped",
        async (standalone: World, scope: AgentModuleScope) => {
            await standalone.hooks.afterTurnTransact?.(standalone.ctx, scope, {
                loopId: "loop-1",
                turnId: "turn-1",
                contextTokens: undefined,
                aborted: true,
            });
            await settle(standalone, scope);
        },
        "stopped",
    ],
    [
        "the daemon restarted during the run",
        async (standalone: World, scope: AgentModuleScope) => {
            await standalone.hooks.afterAgentActivatedTransact?.(standalone.ctx, scope, {
                restored: true,
            });
            await settle(standalone, scope);
        },
        "restarted",
    ],
])("drops the notification when %s, and tells the operator", async (_name, end, reason) => {
    const standalone = await world("tool-dropped");
    try {
        await standalone.push.register(standalone.ctx, id(1), phone(1));
        const relay = stubRelay();
        const scope = agent(AGENT);
        await call(standalone, scope, FIRST_CALL, {
            title: "All 4 droplets off but still billing $81/mo",
            subtitle: "Only deleting them stops the charges",
        });

        await end(standalone, scope);

        expect(relay).toEqual([]);
        expect(standalone.logs).toEqual([
            `push:notification outcome=${reason} notificationId=${FIRST_CALL} agentId=${AGENT}`,
        ]);
    } finally {
        standalone.close();
    }
});

it("keeps the notification through a turn that ends normally and an ordinary activation", async () => {
    const standalone = await world("tool-kept");
    try {
        await standalone.push.register(standalone.ctx, id(1), phone(1));
        const relay = stubRelay();
        const scope = agent(AGENT);
        await call(standalone, scope, FIRST_CALL, { title: "Scratch volume down to 16 GB free" });

        await standalone.hooks.afterTurnTransact?.(standalone.ctx, scope, {
            loopId: "loop-1",
            turnId: "turn-1",
            contextTokens: undefined,
            aborted: false,
        });
        await standalone.hooks.afterAgentActivatedTransact?.(standalone.ctx, scope, {
            restored: false,
        });
        await settle(standalone, scope);

        expect(relay.map((request) => request.body.title)).toEqual([
            "Scratch volume down to 16 GB free",
        ]);
    } finally {
        standalone.close();
    }
});

it("sends to the owner of the task the agent works under, and to nobody else", async () => {
    const team = await world("tool-team", true, {
        parents: { subtaskaaaaaaaaaaaaaaaaa: AGENT },
        subtasks: ["subtaskaaaaaaaaaaaaaaaaa"],
        taskOwners: { [AGENT]: ALICE },
    });
    try {
        await team.push.register(member(team.ctx, ALICE), id(1), phone(1));
        await team.push.register(member(team.ctx, BOB), id(2), phone(2));
        const relay = stubRelay();

        // The task's own agent, and a subtask below it, both reach the task's owner.
        const task = agent(AGENT);
        await call(team, task, FIRST_CALL, { title: "Found why cloud replies show twice" });
        await settle(team, task);
        const subtask = agent("subtaskaaaaaaaaaaaaaaaaa");
        await call(team, subtask, SECOND_CALL, { title: "Fix and test ready" });
        await settle(team, subtask);

        expect(
            relay.map((request) => [request.body.to, request.body.data, request.body.title]),
        ).toEqual([
            [
                "HappyPushToken[phone00000000000000001]",
                {
                    kind: "happy.cloud.push.v1",
                    instanceId: "k3x9q2m7p0a4b8c1d5e6f7g2",
                    userId: "alice0000000000000000001",
                    agentId: "pfh0haxfpzowht3oi213cqos",
                    notificationId: "c1aaaaaaaaaaaaaaaaaaaaaa",
                },
                "Found why cloud replies show twice",
            ],
            [
                "HappyPushToken[phone00000000000000001]",
                {
                    kind: "happy.cloud.push.v1",
                    instanceId: "k3x9q2m7p0a4b8c1d5e6f7g2",
                    userId: "alice0000000000000000001",
                    agentId: "subtaskaaaaaaaaaaaaaaaaa",
                    notificationId: "c2aaaaaaaaaaaaaaaaaaaaaa",
                },
                "Fix and test ready",
            ],
        ]);
    } finally {
        team.close();
    }
});

it("sends nothing for a team agent that works for no one person, and tells the operator", async () => {
    const team = await world("tool-team-shared", true);
    try {
        await team.push.register(member(team.ctx, ALICE), id(1), phone(1));
        const relay = stubRelay();
        const bot = agent(AGENT);
        await call(team, bot, FIRST_CALL, { title: "Found why cloud replies show twice" });
        await settle(team, bot);

        expect(relay).toEqual([]);
        expect(team.logs).toEqual([
            `push:notification outcome=no_recipient notificationId=${FIRST_CALL} agentId=${AGENT}`,
        ]);
    } finally {
        team.close();
    }
});

it("tells the operator why nothing reached a phone, without the words or a token", async () => {
    const standalone = await world("tool-operator-log");
    try {
        stubRelay(() => new Response("refused", { status: 400 }));
        const scope = agent(AGENT);
        const speak = async (callId: string) => {
            await call(standalone, scope, callId, {
                title: "Scratch volume down to 16 GB free",
                subtitle: "Switching to the 400 GB volume still needs your approval",
            });
            await settle(standalone, scope);
        };

        await speak(FIRST_CALL);
        await standalone.push.register(standalone.ctx, id(1), phone(1));
        await standalone.push.saveSettings(standalone.ctx, { enabled: false });
        await speak(SECOND_CALL);
        await standalone.push.saveSettings(standalone.ctx, { enabled: true });
        await speak(FIRST_CALL);

        expect(standalone.logs).toEqual([
            `push:delivery outcome=no_phones notificationId=${FIRST_CALL} agentId=${AGENT}`,
            `push:delivery outcome=disabled notificationId=${SECOND_CALL} agentId=${AGENT}`,
            `push:delivery outcome=request_rejected registrationId=${id(1)} notificationId=${FIRST_CALL} agentId=${AGENT}`,
        ]);
        const everything = standalone.logs.join("\n");
        expect(everything).not.toContain("Scratch volume");
        expect(everything).not.toContain("400 GB");
        expect(everything).not.toContain("HappyPushToken");
    } finally {
        standalone.close();
    }
});
