import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentDatabaseRows, AgentProviders } from "@slopus/happy-agent-base";
import {
    BaseProvider,
    BaseSession,
    type ProviderModality,
    type SessionCompaction,
    type SessionEvent,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";

import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
    type PreparedHappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";

const RELAY = "https://push.cluster-fluster.com/v1/push/send";
const PHONE = "7b0c2d2e-5a51-4c0e-9d5f-3a1f6c0b9e42";
const TOKEN = "HappyPushToken[phone00000000000000001]";

/** What the model answers one inference with: events, or a stream that can wait. */
type Answer = SessionEvent[] | ((ctx: Context) => SessionStream);

/** A model whose every answer the test decides, per agent, seeing what the agent was offered. */
class DirectedProvider extends BaseProvider {
    static override readonly name = "directed";
    static override readonly inputTypes: readonly ProviderModality[] = ["text"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly offered = new Map<string, readonly string[]>();
    readonly requests = new Map<string, SessionRunRequest[]>();
    readonly #answers = new Map<string, Answer[]>();

    script(agentId: string, ...answers: Answer[]): void {
        this.#answers.set(agentId, [...(this.#answers.get(agentId) ?? []), ...answers]);
    }

    session(id: string, options: SessionOptions): Promise<BaseSession> {
        this.offered.set(
            id,
            (options.tools ?? []).map((tool) => tool.name),
        );
        return Promise.resolve(new DirectedSession(id, this));
    }

    /** Record one inference request and take the answer scripted for it. */
    answer(agentId: string, request: SessionRunRequest): Answer {
        this.requests.set(agentId, [...(this.requests.get(agentId) ?? []), request]);
        // Titles are named by a side session; it has nothing to say here.
        return this.#answers.get(agentId)?.shift() ?? [done("normal")];
    }

    /** The text of every tool result the model has been shown for this agent, oldest first. */
    toolResults(agentId: string): string[] {
        const last = this.requests.get(agentId)?.at(-1);
        return (last?.context.messages ?? []).flatMap((message) =>
            message.role === "tool"
                ? [message.content.map((block) => (block.type === "text" ? block.text : "")).join()]
                : [],
        );
    }
}

class DirectedSession extends BaseSession {
    readonly #provider: DirectedProvider;

    constructor(id: string, provider: DirectedProvider) {
        super(id);
        this.#provider = provider;
    }

    run(ctx: Context, request: SessionRunRequest): SessionStream {
        const answer = this.#provider.answer(this.id, request);
        if (typeof answer === "function") return answer(ctx);
        return (async function* () {
            yield* answer;
        })();
    }

    compact(): Promise<SessionCompaction> {
        return Promise.reject(new Error("No scripted compaction result."));
    }

    destroy(): void {}
}

function done(state: "normal" | "tool_call"): SessionEvent {
    return { type: "done", state, tokens: { input: 0, output: 0 } };
}

function say(text: string): SessionEvent[] {
    return [
        { type: "block_start" },
        { type: "text_start" },
        { type: "text_delta", delta: text },
        { type: "text_end" },
        { type: "block_stop" },
        done("normal"),
    ];
}

/** One response that calls `send_push_notification` once per given argument object. */
function notify(...calls: readonly Record<string, unknown>[]): SessionEvent[] {
    return [
        ...calls.flatMap((input, index): SessionEvent[] => [
            { type: "block_start" },
            { type: "toolcall_start", callId: `call-${index}`, name: "send_push_notification" },
            { type: "toolcall_end", callId: `call-${index}`, arguments: JSON.stringify(input) },
            { type: "block_stop" },
        ]),
        done("tool_call"),
    ];
}

let root: string | undefined;
let runtime: HappyAgentRuntime | undefined;

afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    vi.unstubAllGlobals();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
});

/** A standalone daemon's runtime on one data folder, with a phone registered and a stub relay. */
async function start(provider: DirectedProvider) {
    root ??= await mkdtemp(join(tmpdir(), "push-idle-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const relay: Record<string, unknown>[] = [];
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) !== RELAY) return nativeFetch(input, init);
        relay.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Promise.resolve(Response.json({ data: [{ status: "ok", id: "ticket-1" }] }));
    });
    const providers = new AgentProviders();
    providers.add("gym", provider, "codex");
    let context: PreparedHappyAgentRuntime["context"] | undefined;
    runtime = await startHappyAgentRuntime({
        happyHome: join(root, ".happy"),
        inference: {
            providers,
            models: [
                {
                    id: "gym/model",
                    providerId: "gym",
                    name: "Gym",
                    defaultEffort: "medium",
                    effortLevels: ["medium"],
                },
            ],
        },
        onPrepared: (prepared) => {
            context = (name) => prepared.context(name);
        },
    });
    const started = runtime;
    const ctx = context!("test.push");
    await started.modules.push.register(ctx, PHONE, {
        token: TOKEN,
        platform: "ios",
        appId: "com.ex3ndr.happy",
    });
    return {
        runtime: started,
        relay,
        config: { modules: { compute: { cwd: workspace } } },
        /** Wait until every notification handed to the sender has been tried. */
        delivered: async () => {
            await vi.waitFor(
                async () => {
                    const waiting = await agentDatabaseRows(
                        ctx.db,
                        sql`SELECT id FROM durable_function_calls WHERE "function" = 'push.deliver'`,
                    );
                    expect(waiting).toEqual([]);
                },
                { timeout: 10_000 },
            );
        },
    };
}

const message = (text: string) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text }],
});

it("sends the last notification of a turn once the agent is idle, and one for each turn", async () => {
    const provider = new DirectedProvider();
    const world = await start(provider);
    const agent = await world.runtime.system.create(world.runtime.ctx, world.config);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let reachedHold = false;
    provider.script(
        agent.id,
        notify(
            { title: "Looking into the failing deploy", subtitle: "Reading the logs" },
            { title: "iOS preview 24 uploaded; prod is blocked" },
        ),
        // The agent has both answers and is still working: nothing may have left yet.
        () =>
            (async function* () {
                reachedHold = true;
                await held;
                yield* say("Uploaded.");
            })(),
        notify({
            title: "Found why cloud replies show twice",
            subtitle: "Fix and test ready, uncommitted. Open a PR?",
        }),
        say("Found it."),
    );

    await agent.send(world.runtime.ctx, message("Ship the preview."));
    await vi.waitFor(() => expect(reachedHold).toBe(true), { timeout: 10_000 });
    expect(provider.offered.get(agent.id)).toContain("send_push_notification");
    expect(provider.toolResults(agent.id)).toEqual(['{"ok":true}', '{"ok":true}']);
    await world.delivered();
    expect(world.relay).toEqual([]);

    release();
    await agent.waitForIdle();
    await world.delivered();
    const instanceId = await world.runtime.modules.config.instanceId();
    expect(world.relay).toEqual([
        {
            to: "HappyPushToken[phone00000000000000001]",
            title: "iOS preview 24 uploaded; prod is blocked",
            body: "",
            data: {
                kind: "happy.cloud.push.v1",
                instanceId,
                userId: "standalone",
                agentId: agent.id,
                notificationId: expect.stringMatching(/^[a-z][a-z0-9]{23}$/),
            },
            sound: "default",
            channelId: "messages",
            ttl: 300,
        },
    ]);

    await agent.send(world.runtime.ctx, message("Why do replies show twice?"));
    await agent.waitForIdle();
    await world.delivered();
    expect(world.relay.map((request) => [request.title, request.body])).toEqual([
        ["iOS preview 24 uploaded; prod is blocked", ""],
        ["Found why cloud replies show twice", "Fix and test ready, uncommitted. Open a PR?"],
    ]);
    const ids = world.relay.map(
        (request) => (request.data as { notificationId: string }).notificationId,
    );
    expect(new Set(ids).size).toBe(2);

    // A turn in which the agent says nothing to the person sends nothing.
    provider.script(agent.id, say("Nothing new."));
    await agent.send(world.runtime.ctx, message("Anything else?"));
    await agent.waitForIdle();
    await world.delivered();
    expect(world.relay).toHaveLength(2);
}, 60_000);

it("never offers the tool to a hidden helper, and a forced call from one sends nothing", async () => {
    const provider = new DirectedProvider();
    const world = await start(provider);
    const parent = await world.runtime.system.create(world.runtime.ctx, world.config);
    const helper = await world.runtime.system.create(world.runtime.ctx, world.config, {
        parent: parent.id,
    });
    provider.script(helper.id, notify({ title: "Removed 4.43 GB as usual" }), say("Done."));

    await helper.send(world.runtime.ctx, message("Sweep the disk."));
    await helper.waitForIdle();
    await world.delivered();

    expect(provider.offered.get(helper.id)).not.toContain("send_push_notification");
    // The loop answers a call to a tool the agent does not hold with its own refusal.
    expect(provider.toolResults(helper.id)).toHaveLength(1);
    expect(provider.toolResults(helper.id)[0]).not.toContain('"ok"');
    expect(world.relay).toEqual([]);
}, 60_000);

it("sends nothing for a run that a restart cut off between the call and idle", async () => {
    const before = new DirectedProvider();
    const first = await start(before);
    const agent = await first.runtime.system.create(first.runtime.ctx, first.config);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let reachedHold = false;
    before.script(
        agent.id,
        notify({ title: "All 4 droplets off but still billing $81/mo" }),
        // The agent is still working when the daemon is told to stop. A stopping daemon lets the
        // response in flight finish and leaves the rest of the run to the next process.
        () =>
            (async function* (): SessionStream {
                reachedHold = true;
                await held;
                yield { type: "block_start" };
                yield { type: "toolcall_start", callId: "call-skills", name: "list_skills" };
                yield { type: "toolcall_end", callId: "call-skills", arguments: "{}" };
                yield { type: "block_stop" };
                yield done("tool_call");
            })(),
    );
    await agent.send(first.runtime.ctx, message("Turn the droplets off."));
    await vi.waitFor(() => expect(reachedHold).toBe(true), { timeout: 10_000 });
    expect(before.toolResults(agent.id)).toEqual(['{"ok":true}']);
    // Closing marks the daemon as stopping before it returns, so the response ends into that.
    const closing = first.runtime.close();
    release();
    await closing;
    runtime = undefined;
    // The first process never asked the model again, so the run did not end there.
    expect(before.requests.get(agent.id)).toHaveLength(2);
    expect(first.relay).toEqual([]);

    const after = new DirectedProvider();
    after.script(agent.id, say("They are off."));
    const second = await start(after);
    // The run resumes by itself on the new process and ends there.
    await vi.waitFor(() => expect(after.requests.get(agent.id)).toHaveLength(1), {
        timeout: 10_000,
    });
    const resumed = await second.runtime.system.resolve(second.runtime.ctx, agent.id);
    await resumed.waitForIdle();
    await second.delivered();

    expect(first.relay).toEqual([]);
    expect(second.relay).toEqual([]);

    // The agent is not silenced for good: its next run speaks and is heard.
    after.script(agent.id, notify({ title: "All 4 droplets deleted" }), say("Deleted."));
    await resumed.send(second.runtime.ctx, message("Delete them."));
    await vi.waitFor(() => expect(second.relay).toHaveLength(1), { timeout: 10_000 });
    expect(second.relay.map((request) => request.title)).toEqual(["All 4 droplets deleted"]);
}, 60_000);
