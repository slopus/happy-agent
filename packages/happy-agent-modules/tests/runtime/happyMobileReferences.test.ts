import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProviders, withAgentDatabase } from "@slopus/happy-agent-base";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { createMobileRelayFixture } from "../support/MobileRelayFixture.js";
import { ScriptedProvider, type ScriptedTurn } from "../support/ScriptedProvider.js";

const ACCOUNT = "phone";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A standalone daemon with one bot, paired through the protocol relay once it exists. */
async function linkedDaemon(
    options: {
        readonly bots?: number;
        readonly relay?: { readonly sessionSubscribe?: boolean };
        readonly script?: ScriptedTurn[];
    } = {},
) {
    const root = await mkdtemp(join(tmpdir(), "happy-mobile-references-"));
    cleanups.push(async () => await rm(root, { force: true, recursive: true }));
    const relay = await createMobileRelayFixture(options.relay);
    cleanups.push(async () => await relay.close());
    const happyHome = join(root, ".happy");
    const providers = new AgentProviders();
    providers.add("gym", new ScriptedProvider(options.script ?? []), "codex");
    const runtime: HappyAgentRuntime = await startHappyAgentRuntime({
        happyHome,
        environment: { HAPPY_HOME_DIR: happyHome, HAPPY_AGENT_HAPPY_SERVER_URL: relay.url },
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
    });
    const server: Server = createServer((request, response) => {
        void runtime.api.handleRequest(
            withAgentDatabase(runtime.ctx.named("test.references-http"), runtime.database),
            request,
            response,
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await runtime.close();
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing address.");
    const client = new HappyAgentClient({
        endpoint: `http://127.0.0.1:${String(address.port)}`,
        token: (await readFile(runtime.configuration.paths.tokenPath, "utf8")).trim(),
    });
    const bots = [];
    for (let index = 0; index < (options.bots ?? 1); index += 1) {
        bots.push((await client.createBot({ name: `Multiplexed bot ${String(index)}` })).bot);
    }
    const pairing = await client.startHappyIntegration();
    relay.authorize(pairing.integration.authorization!.data, ACCOUNT);
    const bot = bots[0]!;
    /** The one remote session that publishes this bot. */
    const sessionOf = (botId: string) => {
        const ids = relay.botSessions(ACCOUNT, botId);
        expect(ids).toHaveLength(1);
        return ids[0]!;
    };
    await vi.waitFor(
        async () => {
            expect((await client.getHappyIntegration()).integration.status).toBe("connected");
            sessionOf(bot.id);
        },
        { timeout: 10_000 },
    );
    return { bot, bots, client, relay, sessionOf };
}

async function messages(client: HappyAgentClient, agentId: string): Promise<string> {
    const history = await client.getMessages(agentId);
    return JSON.stringify(history.runs.flatMap((run) => run.messages));
}

describe("Happy links on the phone", () => {
    it("relays an agent's entity links as the names they refer to, and file links as their labels", async () => {
        const script: ScriptedTurn[] = [];
        const { bot, client, relay, sessionOf } = await linkedDaemon({ script });
        const { artifact } = await client.createArtifact({
            mutationId: "create-report",
            type: "markdown",
            title: "Q3 *revenue* report",
            files: [{ path: "index.md", text: "# Q3 revenue\n" }],
        });
        const fileLink = `[index.ts:3](happy://agents/${bot.agent.id}/files/src/index.ts#L3)`;
        const apiFileLink = `[index.ts:4](happy-file://agents/${bot.agent.id}/src/index.ts#L4)`;
        const reply = [
            `Published [an old title](happy://artifacts/${artifact.id}) for [](happy://agents/${bot.agent.id}).`,
            `It starts in ${fileLink} and ${apiFileLink}.`,
            "The old one, [Q2 report](happy://artifacts/missingartifact), is gone,",
            'and so is <happy-artifact id="missingartifact"/>.',
            "Write links like `[x](happy://artifacts/x)`.",
        ].join(" ");
        script.push([
            { type: "text_start" },
            { type: "text_delta", delta: reply },
            { type: "text_end" },
            { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
        ]);
        const sid = sessionOf(bot.id);

        relay.deliver(ACCOUNT, bot.id, "What did you publish?");
        await vi.waitFor(
            () => {
                const sent = JSON.stringify(relay.outgoing.get(sid) ?? []);
                expect(sent).toContain(
                    JSON.stringify(
                        `Published Q3 \\*revenue\\* report for ${bot.name}. It starts in index.ts:3 and index.ts:4. The old one, Q2 report, is gone, and so is an unavailable artifact. Write links like \`[x](happy://artifacts/x)\`.`,
                    ).slice(1, -1),
                );
            },
            { timeout: 10_000 },
        );
        // The daemon's own history keeps exactly what the agent wrote.
        const history = await messages(client, bot.agent.id);
        expect(history).toContain(
            JSON.stringify(`[an old title](happy://artifacts/${artifact.id})`).slice(1, -1),
        );
        expect(history).toContain(fileLink);
    }, 30_000);
});
