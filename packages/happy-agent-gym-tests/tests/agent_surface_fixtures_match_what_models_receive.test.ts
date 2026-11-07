import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
    createAgentGym,
    type AgentGym,
    type GymCompactionRequest,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import type { HappyAgentClient } from "@slopus/happy-agent-client";
import { expect, it, vi } from "vitest";

import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

/**
 * Exports every system prompt and tool array the real daemon hands a model, so another codebase
 * can prove it offers the same surface. `pnpm export:agent-surface` rewrites the fixtures; without
 * it this test fails when they no longer match the daemon.
 *
 * Each context is one inference the gym observed. `prompts/<context>.md` is its system prompt,
 * `messages/<context>.json` what it was asked, and `tools/<context>.json` the ordered keys of its
 * tools in `tools/definitions/`. Run-specific values become `{{placeholders}}`, listed per context
 * in `prompts/index.json`; instruction documents are marker files, such as `{{globalAgentsMd}}`.
 * `variants.json` lists what each context adds, removes, or changes against `permission.auto`.
 * Contexts prefixed `team.` ran on a team server; `flows/` holds provider sign-in API exchanges.
 * `wire/<family>/` holds each tool exactly as the real provider serialized it into its vendor
 * request, in the original key order, with `wire/<family>/order.json` giving the sent order and
 * `wire/<family>/request.json` the request target the vendor saw.
 */
const FIXTURES = resolve(import.meta.dirname, "../fixtures/agent-surface");
const UPDATE = process.env.HAPPY_AGENT_SURFACE_UPDATE === "1";
const SCRIPT = "pnpm --filter @slopus/happy-agent-gym-tests export:agent-surface";

const EFFORT = ["medium"] as const;
const model = (providerId: string, id: string, name: string) => ({
    providerId,
    id,
    name,
    effortLevels: EFFORT,
    defaultEffort: "medium" as const,
});

/** One main agent per distinct prompt the daemon selects, on the provider kind that serves it. */
const MAIN = [
    ["claude-opus-5-5", model("claude", "anthropic/opus-5-5", "Opus 5.5")],
    ["claude-opus-5", model("claude", "anthropic/opus-5", "Opus 5")],
    ["claude-sonnet-5-5", model("claude", "anthropic/sonnet-5-5", "Sonnet 5.5")],
    ["claude-sonnet-5", model("claude", "anthropic/sonnet-5", "Sonnet 5")],
    ["claude-fable-5-1", model("claude", "anthropic/fable-5-1", "Fable 5.1")],
    ["claude-fable-5", model("claude", "anthropic/fable-5", "Fable 5")],
    ["claude-opus-4-8", model("claude", "anthropic/opus-4-8", "Opus 4.8")],
    ["claude-family-fallback", model("claude", "anthropic/future-model", "Future Claude")],
    ["codex-gpt-6-1-sol", model("codex", "openai/gpt-6.1-sol", "GPT-6.1 Sol")],
    ["codex-gpt-6-1-terra", model("codex", "openai/gpt-6.1-terra", "GPT-6.1 Terra")],
    ["codex-family-fallback", model("codex", "openai/future-model", "Future GPT")],
    ["grok-family-fallback", model("grok", "xai/grok-4.5", "Grok 4.5")],
    ["bedrock-opus-5-5", model("bedrock", "anthropic/opus-5-5", "Opus 5.5 on Bedrock")],
    ["openai-compatible", model("compatible", "zai/glm-5.3", "GLM 5.3")],
    ["kimi-k3", model("gym", "moonshotai/kimi-k3", "Kimi K3")],
    ["simple-fallback", model("gym", "gym/model", "Gym model")],
] as const;

const PROVIDER_TYPES = {
    claude: "claude",
    codex: "codex",
    grok: "grok",
    bedrock: "bedrock",
    compatible: "openai_compatible",
    gym: "gym",
} as const;

/** The tool list every other context is described against in `variants.json`. */
const BASELINE = "permission.auto";

const PERMISSION_MODES = ["read_only", "workspace_write", "auto", "full_access"] as const;

interface Substitutions {
    readonly ids: Readonly<Record<string, string>>;
    readonly paths: readonly (readonly [string, string])[];
}

interface Capture {
    readonly context: string;
    readonly builtBy: string;
    readonly request: GymInferenceRequest;
    readonly substitutions: Substitutions;
}

type PendingCapture = Omit<Capture, "substitutions">;

/** A 1×1 transparent PNG, the smallest image a person can attach. */
const PIXEL =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const ECHO_SERVER = fileURLToPath(new URL("./fixtures/echoMcpServer.mjs", import.meta.url));
const REVIEW_PROMPT = "You are judging one planned coding-agent action.";

/**
 * The scripted model. A user message naming a scripted turn gets it once; a permission review
 * answers with the verdict the scenario set; everything else just finishes.
 */
function scriptedModel() {
    const turns = new Map<string, GymTurn>();
    let verdict: "allow" | "deny" | "garbled" = "allow";
    const handler = (request: GymInferenceRequest): GymTurn => {
        if (request.instructions.startsWith(REVIEW_PROMPT)) {
            const text =
                verdict === "garbled"
                    ? "I could not decide."
                    : `<review>\n<risk_level>high</risk_level>\n<user_authorization>low</user_authorization>\n<outcome>${verdict}</outcome>\n<rationale>Scripted ${verdict}.</rationale>\n</review>`;
            return { content: [{ type: "text", text }] };
        }
        if (request.sessionId.startsWith("naming:"))
            return { content: [{ type: "text", text: "<title>Surface export</title>" }] };
        const last = request.messages.at(-1);
        const text =
            last?.role === "user"
                ? last.content.map((block) => (block.type === "text" ? block.text : "")).join("")
                : "";
        const turn = turns.get(text.trim());
        if (turn !== undefined) {
            turns.delete(text.trim());
            return turn;
        }
        return { content: [{ type: "text", text: "Done." }] };
    };
    return {
        handler,
        script: (message: string, name: string, args: Record<string, unknown>) =>
            turns.set(message, {
                content: [{ type: "tool_call", name, callId: `surface_${name}`, arguments: args }],
            }),
        review: (next: typeof verdict) => {
            verdict = next;
        },
    };
}

const INSTRUCTION_FILES = {
    "AGENTS.md": "{{projectAgentsMd}}\n",
    "AGENTS_SECURITY.md": "{{projectSecurityMd}}\n",
    "README.md": "{{readme}}\n",
    ".agents/skills/example/SKILL.md":
        "---\nname: example\ndescription: '{{skillDescription}}'\n---\n\n{{skillBody}}\n",
};

async function writeHomeInstructions(gym: AgentGym): Promise<void> {
    await writeFile(join(gym.publicHomePath, "config", "AGENTS.md"), "{{globalAgentsMd}}\n");
    await writeFile(join(gym.publicHomePath, "config", "SECURITY.md"), "{{globalSecurityMd}}\n");
    await writeFile(join(gym.publicHomePath, "AGENTS_SECURITY.md"), "{{homeSecurityMd}}\n");
}

function gymPaths(gym: AgentGym): [string, string][] {
    return [
        [gym.workspacePath, "workspacePath"],
        [gym.happyHome, "happyHome"],
        [gym.publicHomePath, "happyPublicHome"],
        [join(gym.workspacePath, ".."), "installationRoot"],
    ];
}

async function firstRequest(gym: AgentGym, sessionId: string): Promise<GymInferenceRequest> {
    return await gym.waitUntil(
        async () => gym.inference.requests.find((request) => request.sessionId === sessionId),
        `the first request of ${sessionId}`,
    );
}

/**
 * Drives every agent kind once on a running gym and returns what each first inference was asked,
 * with the IDs that run minted named for their role.
 */
async function driveAgentKinds(
    gym: AgentGym,
    model: ReturnType<typeof scriptedModel>,
    prefix: string,
    mains: readonly (typeof MAIN)[number][],
): Promise<{ captures: PendingCapture[]; ids: Record<string, string> }> {
    const captures: PendingCapture[] = [];
    for (const [label, entry] of mains) {
        const agent = await gym.createSession({ title: label });
        await gym.send("Hello.", {
            sessionId: agent.id,
            providerId: entry.providerId,
            modelId: entry.id,
            permissionMode: "auto",
        });
        captures.push({
            context: `${prefix}main.${label}`,
            builtBy: "systemPrompt/SystemPromptModule.ts:SystemPromptModule.instructions",
            request: await firstRequest(gym, agent.id),
        });
    }

    for (const mode of PERMISSION_MODES) {
        const agent = await gym.createSession({ title: mode });
        await gym.send("Hello.", { sessionId: agent.id, permissionMode: mode });
        captures.push({
            context: `${prefix}permission.${mode}`,
            builtBy: "permissions/PermissionsModule.ts:PermissionsModule",
            request: await firstRequest(gym, agent.id),
        });
    }

    const chief = (await gym.client.listBots()).bots.find((bot) => bot.isAdmin)!;
    await gym.send("Hello.", { sessionId: chief.agent.id, permissionMode: "auto" });
    captures.push({
        context: `${prefix}chief_of_staff`,
        builtBy: "bots/impl/formatChiefOfStaffInstructions.ts:formatChiefOfStaffInstructions",
        request: await firstRequest(gym, chief.agent.id),
    });

    const bot = (await gym.client.createBot({ name: "Research Bot" })).bot;
    await gym.send("Hello.", { sessionId: bot.agent.id, permissionMode: "auto" });
    captures.push({
        context: `${prefix}bot`,
        builtBy: "bots/BotsModule.ts:BotsModule",
        request: await firstRequest(gym, bot.agent.id),
    });

    const { task } = await gym.client.createTask({ name: "Quarterly review" });
    await gym.send("Hello.", { sessionId: task.agent.id, permissionMode: "auto" });
    captures.push({
        context: `${prefix}task`,
        builtBy: "tasks/TasksModule.ts:TasksModule",
        request: await firstRequest(gym, task.agent.id),
    });

    const selection = gym.selection;
    const spawn = { model: selection.modelId, provider: selection.providerId, effort: "medium" };
    model.script("Start a subtask.", "create_subtask", {
        title: "Subtask",
        text: "Subtask hello.",
        ...spawn,
    });
    await gym.send("Start a subtask.", { sessionId: task.agent.id, permissionMode: "auto" });
    captures.push({
        context: `${prefix}subtask`,
        builtBy: "subtasks/SubtasksModule.ts:SubtasksModule",
        request: await firstRequestWithText(gym, "Subtask hello."),
    });

    model.script("Start a collaborator.", "create_agent", {
        title: "Collaborator",
        text: "Collaborator hello.",
        ...spawn,
    });
    await gym.send("Start a collaborator.", { permissionMode: "auto" });
    captures.push({
        context: `${prefix}collaborator`,
        builtBy: "collaboration/CollaborationModule.ts:CollaborationModule",
        request: await firstRequestWithText(gym, "Collaborator hello."),
    });

    const sessions = new Set(captures.map((capture) => capture.request.sessionId));
    const outside = {
        command: "ls /",
        description: "List the root folder",
        dangerouslyDisableSandbox: true,
    };
    for (const verdict of ["allow", "deny", "garbled"] as const) {
        const message = `Run outside the sandbox (${verdict}).`;
        model.review(verdict);
        model.script(message, "Bash", outside);
        const before = gym.inference.requests.length;
        await gym.send(message, { permissionMode: "auto" });
        const after = gym.inference.requests.slice(before);
        const reviews = after.filter(
            (request) =>
                !sessions.has(request.sessionId) &&
                request.sessionId !== gym.defaultSessionId &&
                !request.sessionId.startsWith("naming:"),
        );
        expect(reviews.length).toBeGreaterThan(0);
        if (verdict === "allow")
            captures.push({
                context: `${prefix}auto_review`,
                builtBy: "auto/prompts/guardian-policy-template.md",
                request: reviews[0]!,
            });
        const answered = after.filter((request) => request.sessionId === gym.defaultSessionId);
        captures.push({
            context: `${prefix}auto_review.${verdict}.result`,
            builtBy: "auto/AutoModule.ts:AutoModule",
            request: answered.at(-1)!,
        });
    }
    model.review("allow");

    const naming = gym.inference.requests.find((request) =>
        request.sessionId.startsWith("naming:"),
    );
    expect(naming).toBeDefined();
    captures.push({
        context: `${prefix}naming`,
        builtBy: "titles/impl/runNamingInference.ts:runNamingInference",
        request: naming!,
    });

    const ids: Record<string, string> = {
        [gym.defaultSessionId]: "mainAgentId",
        [chief.agent.id]: "chiefOfStaffAgentId",
        [chief.id]: "chiefOfStaffBotId",
        [bot.agent.id]: "botAgentId",
        [bot.id]: "botId",
        [task.agent.id]: "taskAgentId",
        [task.id]: "taskId",
    };
    for (const workspace of [chief.workspaceId, bot.workspaceId, task.agent.workspaceId])
        ids[workspace] ??= "workspaceId";
    return { captures, ids };
}

/** A follow-up turn after a tool call, then a message carrying an image. */
async function driveConversation(
    gym: AgentGym,
    model: ReturnType<typeof scriptedModel>,
): Promise<PendingCapture[]> {
    const agent = await gym.createSession({ title: "Conversation" });
    model.script("Read the readme.", "Read", {
        file_path: join(gym.workspacePath, "README.md"),
    });
    await gym.send("Read the readme.", { sessionId: agent.id, permissionMode: "auto" });
    const response = await gym.client.sendMessage(agent.id, {
        text: "What is in this picture?",
        content: [{ type: "image", mimeType: "image/png", data: PIXEL }],
        mode: {
            effort: "medium",
            modelId: gym.selection.modelId,
            permissionMode: "auto",
            providerId: gym.selection.providerId,
            serviceTier: null,
        },
    });
    await gym.waitUntil(
        async () =>
            gym.inference.requests.findLast(
                (request) =>
                    request.sessionId === agent.id &&
                    JSON.stringify(request.messages).includes(PIXEL),
            ),
        "the image turn",
    );
    void response;
    await gym
        .steer("Also describe the colors.", { sessionId: agent.id, wait: true })
        .catch(() => undefined);
    const last = await gym.waitUntil(
        async () =>
            gym.inference.requests.findLast(
                (request) =>
                    request.sessionId === agent.id &&
                    JSON.stringify(request.messages).includes("Also describe the colors."),
            ),
        "the steered turn",
    );
    return [
        {
            context: "conversation.multi_turn",
            builtBy: "happy-agent-base:AgentBase",
            request: last,
        },
    ];
}

async function driveWorkflow(
    gym: AgentGym,
    model: ReturnType<typeof scriptedModel>,
): Promise<PendingCapture[]> {
    model.script("Run a workflow.", "run_workflow", {
        input: {
            script: `agent("Workflow hello.", {"model": "${gym.selection.modelId}", "provider": "${gym.selection.providerId}", "effort": "medium", "label": "Step"})`,
        },
    });
    await gym.send("Run a workflow.", { permissionMode: "auto" });
    const workflowAgent = await firstRequestWithText(gym, "Workflow hello.");
    await gym.send("Anything else?", { permissionMode: "auto" });
    return [
        {
            context: "workflow_agent",
            builtBy: "workflows/WorkflowsModule.ts:WorkflowsModule",
            request: workflowAgent,
        },
        {
            context: "main.with_collaborators",
            builtBy: "collaboration/CollaborationModule.ts:CollaborationModule",
            request: await firstRequestWithText(gym, "Anything else?"),
        },
    ];
}

async function startRemoteMcpServer(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = new McpServer({ name: "remote-notes", version: "1.0.0" });
    server.registerTool("lookup", { description: "Look a note up by its title." }, async () => ({
        content: [{ type: "text", text: "A note." }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    // The SDK's own transport types disagree with exactOptionalPropertyTypes.
    await server.connect(transport as unknown as Transport);
    const http: Server = createServer((request, response) => {
        void transport.handleRequest(request, response);
    });
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    const { port } = http.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${String(port)}/mcp`,
        close: async () => {
            await server.close();
            await new Promise<void>((done) => http.close(() => done()));
        },
    };
}

/** One user-wide stdio server and one project-level remote server, on Claude and Codex. */
async function driveMcp(): Promise<Capture[]> {
    const remote = await startRemoteMcpServer();
    const model = scriptedModel();
    const gym = await createAgentGym({
        timeoutMs: 30_000,
        providerIds: ["claude", "codex"],
        providerTypes: { claude: "claude", codex: "codex" },
        models: MAIN.filter(([, entry]) => ["claude", "codex"].includes(entry.providerId)).map(
            ([, entry]) => entry,
        ),
        files: {
            ...INSTRUCTION_FILES,
            "mcp.toml": [
                `[mcp_servers.remote_notes]\nurl = "${remote.url}"\n`,
                `[mcp_servers.echo]\ncommand = ${JSON.stringify(process.execPath)}`,
                `args = ${JSON.stringify([ECHO_SERVER, "echo"])}\n`,
            ].join("\n"),
        },
        inference: model.handler,
    });
    try {
        await writeHomeInstructions(gym);
        const captures: Capture[] = [];
        for (const label of ["claude-opus-5-5", "codex-gpt-6-1-sol"]) {
            const entry = MAIN.find(([candidate]) => candidate === label)![1];
            const send = async (sessionId: string) =>
                await gym.send("Hello.", {
                    sessionId,
                    providerId: entry.providerId,
                    modelId: entry.id,
                    permissionMode: "auto",
                });
            // Servers connect in the background; a probe agent waits until both have listed.
            const probe = await gym.createSession({ title: `${label} probe` });
            await gym.waitUntil(async () => {
                await send(probe.id);
                const names = (
                    gym.inference.requests.findLast((candidate) => candidate.sessionId === probe.id)
                        ?.tools ?? []
                ).map((tool) => tool.name);
                return names.includes("mcp__echo__echo") &&
                    names.includes("mcp__remote_notes__lookup")
                    ? true
                    : undefined;
            }, `${label} to be offered both MCP servers`);
            const agent = await gym.createSession({ title: label });
            await send(agent.id);
            const request = await firstRequest(gym, agent.id);
            captures.push({
                context: `mcp.${label}`,
                builtBy: "mcp/McpModule.ts:McpModule",
                request,
                substitutions: {
                    ids: { [gym.defaultSessionId]: "mainAgentId" },
                    paths: [
                        [remote.url, "mcpRemoteUrl"],
                        [ECHO_SERVER, "mcpStdioServerPath"],
                        [process.execPath, "mcpStdioCommand"],
                        ...gymPaths(gym),
                    ],
                },
            });
        }
        return captures;
    } finally {
        await gym.dispose();
        await remote.close();
    }
}

/** The same agent kinds as a team server's owner and member see them. */
async function driveTeam(): Promise<Capture[]> {
    const model = scriptedModel();
    const team = await surfaceTeamClients({
        timeoutMs: 30_000,
        providerIds: Object.keys(PROVIDER_TYPES),
        providerTypes: PROVIDER_TYPES,
        models: MAIN.map(([, entry]) => entry),
        files: INSTRUCTION_FILES,
        inference: model.handler,
    });
    const { gym } = team;
    try {
        await writeHomeInstructions(gym);
        const mains = MAIN.filter(([label]) =>
            ["claude-opus-5-5", "codex-gpt-6-1-sol", "grok-family-fallback"].includes(label),
        );
        const { captures, ids } = await driveAgentKinds(gym, model, "team.", mains);
        const owned = await gym.createSession({ title: "Shared" });
        const member = await sendAs(team.bob, gym, owned.workspaceId);
        captures.push({
            context: "team.member.main",
            builtBy: "systemPrompt/SystemPromptModule.ts:SystemPromptModule.instructions",
            request: await firstRequest(gym, member),
        });
        ids[team.aliceId] = "ownerUserId";
        ids[team.bobId] = "memberUserId";
        return captures.map((capture) => ({
            ...capture,
            substitutions: { ids, paths: gymPaths(gym) },
        }));
    } finally {
        await gym.dispose();
    }
}

async function sendAs(
    client: HappyAgentClient,
    gym: AgentGym,
    workspaceId: string,
): Promise<string> {
    const { agent } = await client.createAgent({ workspaceId, title: "Member" });
    await client.sendMessage(agent.id, {
        text: "Hello.",
        mode: {
            effort: "medium",
            modelId: gym.selection.modelId,
            permissionMode: "auto",
            providerId: gym.selection.providerId,
            serviceTier: null,
        },
    });
    return agent.id;
}

// The fixtures describe a Linux host; other platforms are told about their own sandbox and paths.
it.runIf(process.platform === "linux")(
    "exports the prompts and tools every agent kind receives",
    async () => {
        const model = scriptedModel();
        const gym = await createAgentGym({
            timeoutMs: 30_000,
            providerIds: Object.keys(PROVIDER_TYPES),
            providerTypes: PROVIDER_TYPES,
            models: MAIN.map(([, entry]) => entry),
            files: INSTRUCTION_FILES,
            inference: model.handler,
        });
        let captures: Capture[];
        let compaction: GymCompactionRequest;
        let protocol: number;
        let standalone: Substitutions;
        try {
            await writeHomeInstructions(gym);
            const driven = await driveAgentKinds(gym, model, "", MAIN);
            const pending = [
                ...driven.captures,
                ...(await driveConversation(gym, model)),
                ...(await driveWorkflow(gym, model)),
            ];
            const conversation = pending.find(
                (capture) => capture.context === "conversation.multi_turn",
            )!;
            // The richest history the run built: a tool result, an image, and a follow-up.
            await gym.compact(conversation.request.sessionId);
            compaction = await gym.waitUntil(
                async () => gym.inference.compactions[0],
                "the compaction request",
            );
            for (const capture of pending)
                driven.ids[capture.request.sessionId] ??=
                    `${capture.context.replace(/\W/g, "_")}_agentId`;
            const workflowRun = /workflow \((\w+)\) is running/.exec(
                JSON.stringify(gym.inference.toolResults()),
            )?.[1];
            expect(workflowRun).toBeDefined();
            driven.ids[workflowRun!] = "workflowRunId";
            standalone = { ids: driven.ids, paths: gymPaths(gym) };
            captures = pending.map((capture) => ({ ...capture, substitutions: standalone }));
            protocol = (await gym.client.getHealth()).version.protocol;
        } finally {
            await gym.dispose();
        }
        captures.push(...(await driveMcp()), ...(await driveTeam()));
        for (const capture of captures) {
            const ids = { ...capture.substitutions.ids };
            for (const other of captures)
                ids[other.request.sessionId] ??= `${other.context.replace(/\W/g, "_")}_agentId`;
            Object.assign(capture, { substitutions: { ...capture.substitutions, ids } });
        }

        const surface = exportSurface(captures, compaction, standalone);
        for (const [path, content] of await driveProviderSignIns()) surface.set(path, content);
        const wire = await driveWire();
        for (const [path, content] of wire) surface.set(path, content);
        const manifest = {
            contexts: captures.map((capture) => capture.context),
            flows: [...surface.keys()].filter((path) => path.startsWith("flows/")).sort(),
            generatedBy: SCRIPT,
            happyAgentCommit: UPDATE ? headCommit() : "",
            protocol,
            wire: wireHashes(wire),
        };
        if (UPDATE) {
            await rm(FIXTURES, { recursive: true, force: true });
            for (const [path, content] of surface) {
                await mkdir(join(FIXTURES, path, ".."), { recursive: true });
                await writeFile(join(FIXTURES, path), content);
            }
            await writeFile(join(FIXTURES, "manifest.json"), stableJson(manifest));
        }
        const written = await readTree(FIXTURES);
        const committed = JSON.parse(written.get("manifest.json") ?? "{}") as typeof manifest;
        written.delete("manifest.json");
        expect({ ...committed, happyAgentCommit: "" }).toEqual({
            ...manifest,
            happyAgentCommit: "",
        });
        expect(committed.happyAgentCommit).toMatch(/^[0-9a-f]{40}$/);
        expect([...written.keys()].sort()).toEqual([...surface.keys()].sort());
        for (const [path, content] of surface) expect(written.get(path), path).toBe(content);
    },
    600_000,
);

/** Each provider family as the daemon configures it, pointed at the capturing vendor. */
const WIRE_FAMILIES = [
    { family: "claude", providerId: "wire_claude", modelId: "anthropic/opus-5-5" },
    { family: "codex", providerId: "wire_codex", modelId: "openai/gpt-6.1-sol" },
    { family: "grok", providerId: "wire_grok", modelId: "xai/grok-4.5" },
    { family: "openai_compatible", providerId: "wire_compatible", modelId: "zai/glm-5.3" },
    { family: "bedrock", providerId: "wire_bedrock", modelId: "anthropic/opus-5-5" },
    {
        family: "bedrock_anthropic_mantle",
        providerId: "wire_bedrock_mantle",
        modelId: "anthropic/opus-5-5",
    },
    {
        family: "bedrock_responses_mantle",
        providerId: "wire_bedrock_families",
        modelId: "openai/gpt-5.4",
    },
    {
        family: "bedrock_responses_runtime",
        providerId: "wire_bedrock_families",
        modelId: "openai/gpt-6-astra",
    },
    {
        family: "bedrock_kimi_runtime",
        providerId: "wire_bedrock_families",
        modelId: "moonshotai/kimi-k3",
        effort: "high",
    },
    {
        family: "bedrock_glm_runtime",
        providerId: "wire_bedrock_families",
        modelId: "zai/glm-5.3",
        effort: "high",
    },
] as const;

/** Bedrock endpoints for the families above; each carries a query, which must survive. */
function bedrockFamilyConfig(base: string): string[] {
    const route = (family: string, transport?: string) => [
        `endpoint = "${base}/${family}?route=fixture"`,
        ...(transport === undefined ? [] : [`transport = "${transport}"`]),
    ];
    return [
        "[providers.wire_bedrock_mantle]",
        'type = "bedrock"',
        "enabled = true",
        'bearer_token = "wire-key"',
        'region = "us-east-1"',
        '[providers.wire_bedrock_mantle.model_overrides."anthropic/opus-5-5"]',
        ...route("bedrock_anthropic_mantle", "mantle"),
        "[providers.wire_bedrock_families]",
        'type = "bedrock"',
        "enabled = true",
        'bearer_token = "wire-key"',
        'region = "us-east-1"',
        '[providers.wire_bedrock_families.model_overrides."openai/gpt-5.4"]',
        ...route("bedrock_responses_mantle", "mantle"),
        '[providers.wire_bedrock_families.model_overrides."openai/gpt-6-astra"]',
        ...route("bedrock_responses_runtime", "runtime"),
        '[providers.wire_bedrock_families.model_overrides."moonshotai/kimi-k3"]',
        ...route("bedrock_kimi_runtime"),
        '[providers.wire_bedrock_families.model_overrides."zai/glm-5.3"]',
        ...route("bedrock_glm_runtime"),
    ];
}

/**
 * Runs each real provider against a local vendor that records the first request body and refuses
 * it, then keeps every tool exactly as it appeared on the wire. Claude Code is the SDK's bundled
 * binary, so its serialization is pinned with the dependency.
 */
async function driveWire(): Promise<Map<string, string>> {
    const bodies = new Map<string, { body: string; target: string }>();
    const http = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            // Claude Code checks that its API answers before it sends anything.
            if (request.method !== "POST") {
                response.writeHead(200, { "content-type": "application/json" });
                response.end("{}");
                return;
            }
            const target = request.url ?? "";
            const family = new URL(target, "http://wire").pathname.split("/")[1]!;
            if (!bodies.has(family))
                bodies.set(family, { body: Buffer.concat(chunks).toString("utf8"), target });
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    type: "error",
                    error: { type: "invalid_request_error", message: "Captured." },
                }),
            );
        });
    });
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${String((http.address() as AddressInfo).port)}`;
    vi.stubEnv("ANTHROPIC_BASE_URL", `${base}/claude`);
    const gym = await createAgentGym({
        timeoutMs: 60_000,
        files: INSTRUCTION_FILES,
        config: [
            "[providers.wire_claude]",
            "enabled = true",
            'type = "claude"',
            'api_key = "wire-key"',
            "[providers.wire_codex]",
            "enabled = true",
            'type = "codex"',
            'api_key = "wire-key"',
            `base_url = "${base}/codex"`,
            'transport = "sse"',
            "[providers.wire_grok]",
            "enabled = true",
            'type = "grok"',
            'api_key = "wire-key"',
            `base_url = "${base}/grok"`,
            "[providers.wire_compatible]",
            "enabled = true",
            'type = "openai_compatible"',
            'name = "Wire"',
            `base_url = "${base}/openai_compatible/v1/"`,
            'api_key = "wire-key"',
            'models = ["zai/glm-5.3"]',
            "[providers.wire_bedrock]",
            "enabled = true",
            'type = "bedrock"',
            'bearer_token = "wire-key"',
            'region = "us-east-1"',
            '[providers.wire_bedrock.model_overrides."anthropic/opus-5-5"]',
            `endpoint = "${base}/bedrock"`,
            'transport = "runtime"',
            ...bedrockFamilyConfig(base),
            "",
        ].join("\n"),
        liveProviders: [...new Set(WIRE_FAMILIES.map(({ providerId }) => providerId))],
    });
    const files = new Map<string, string>();
    try {
        await writeHomeInstructions(gym);
        const ids: Record<string, string> = { [gym.defaultSessionId]: "mainAgentId" };
        for (const wire of WIRE_FAMILIES) {
            const { family, providerId, modelId } = wire;
            const agent = await gym.createSession({ title: family });
            ids[agent.id] = "agentId";
            await gym.send("Hello.", {
                sessionId: agent.id,
                providerId,
                modelId,
                // Kimi and GLM offer no medium effort.
                effort: "effort" in wire ? wire.effort : "medium",
                permissionMode: "auto",
                wait: false,
            });
            const { body, target } = await gym.waitUntil(
                async () => bodies.get(family),
                `the ${family} request`,
            );
            files.set(`wire/${family}/request.json`, stableJson({ method: "POST", target }));
            await gym.abort(agent.id);
            // Every body is compact JSON whose parse and stringify reproduce it byte for byte, so
            // each tool's stringified element is exactly its slice of the request.
            const parsed = JSON.parse(body) as { tools?: Record<string, unknown>[] };
            expect(JSON.stringify(parsed), `${family} request is canonical JSON`).toBe(body);
            const keys: string[] = [];
            for (const tool of parsed.tools ?? []) {
                const fn = tool["function"] as { name?: string } | undefined;
                const name = String(tool["name"] ?? fn?.name ?? tool["type"]);
                const key = keys.includes(name) ? `${name}.${String(keys.length)}` : name;
                keys.push(key);
                files.set(
                    `wire/${family}/${key}.json`,
                    templated(JSON.stringify(tool), ids, gymPaths(gym), `wire.${family}`),
                );
            }
            files.set(`wire/${family}/order.json`, stableJson(keys));
        }
    } finally {
        await gym.dispose();
        vi.unstubAllEnvs();
        await new Promise<void>((done) => http.close(() => done()));
    }
    return files;
}

/** The SHA-256 of every wire tool file, by family and tool key. */
function wireHashes(files: ReadonlyMap<string, string>): Record<string, Record<string, string>> {
    const hashes: Record<string, Record<string, string>> = {};
    for (const [path, content] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const [, family, file] = path.split("/") as [string, string, string];
        if (file === "order.json" || file === "request.json") continue;
        (hashes[family] ??= {})[file.slice(0, -".json".length)] = createHash("sha256")
            .update(content)
            .digest("hex");
    }
    return hashes;
}

/** A stand-in Claude Code that signs in only with the code `good-code`. */
const CLAUDE_CLI = `#!/bin/sh
state="$HOME/.stub-claude-signed-in"
case "$*" in
  "--version") echo "2.1.312 (Claude Code)" ;;
  "auth status --json")
    if [ -f "$state" ]; then
      echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com","subscriptionType":"max"}'
    else
      echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
    fi ;;
  "auth login --claudeai")
    echo "Opening browser to sign in…"
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=stub"
    printf "Paste code here if prompted > "
    read code
    if [ "$code" = "good-code" ]; then touch "$state"; echo "Login successful."; else echo "Login failed." >&2; exit 1; fi ;;
  *) exit 2 ;;
esac
`;

/** A stand-in Codex whose device sign-in finishes once the test approves it. */
const CODEX_CLI = `#!/bin/sh
case "$*" in
  "--version") echo "codex-cli 0.164.0" ;;
  "login status")
    if [ -f "$CODEX_HOME/auth.json" ]; then echo "Logged in using ChatGPT"; else echo "Not logged in"; exit 1; fi ;;
  "login --device-auth")
    echo "Follow these steps to sign in with ChatGPT using device code authorization:"
    echo "1. Open this link in your browser and sign in to your account"
    echo "   https://auth.openai.com/codex/device"
    echo "2. Enter this one-time code (expires in 15 minutes)"
    echo "   ABCD-EFGH"
    while [ ! -f "$HOME/.approve-codex" ]; do sleep 0.1; done
    echo "Successfully logged in" ;;
  *) exit 2 ;;
esac
`;

async function executable(path: string, content: string): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    await chmod(path, 0o755);
}

/**
 * Every request and event of a Claude browser sign-in with a pasted code and a Codex device
 * sign-in, against stand-ins for the vendors' programs, so a client can match the shapes.
 */
async function driveProviderSignIns(): Promise<Map<string, string>> {
    const root = await mkdtemp(join(tmpdir(), "surface-clis-"));
    const home = join(root, "home");
    await executable(join(home, ".local", "bin", "claude"), CLAUDE_CLI);
    await executable(join(home, ".local", "bin", "codex"), CODEX_CLI);
    const gym = await createAgentGym({
        timeoutMs: 20_000,
        environment: {
            CODEX_HOME: join(home, ".codex"),
            GROK_HOME: join(home, ".grok"),
            HAPPY_AGENT_APPLICATIONS_DIRECTORY: join(root, "Applications"),
            HAPPY_AGENT_PROGRAM_DIRECTORIES: "",
            HOME: home,
            PATH: `${join(home, ".local", "bin")}:/usr/bin:/bin`,
        },
    });
    const files = new Map<string, string>();
    try {
        type Step = { request?: unknown; status?: number; response?: unknown; event?: unknown };
        const record = async (steps: Step[], method: string, path: string, body?: unknown) => {
            const response = await gym.http.request(method, path, body);
            steps.push({
                request: { method, path, ...(body === undefined ? {} : { body }) },
                status: response.status,
                response: JSON.parse(response.text) as unknown,
            });
        };
        const until = async (steps: Step[], cli: string, status: string) => {
            const event = (await gym.waitForEvent((candidate) => {
                const untyped = candidate as { type: string; payload: unknown };
                if (untyped.type !== "provider_cli.updated") return false;
                const object = (
                    untyped.payload as {
                        providerCli: {
                            id: string;
                            operation: {
                                kind: string;
                                status: string;
                                authorization: { method: string; userCode: string | null } | null;
                            } | null;
                        };
                    }
                ).providerCli;
                return (
                    object.id === cli &&
                    object.operation?.kind === "sign_in" &&
                    object.operation.status === status &&
                    // A device code may reach the page in a later update than its URL.
                    (object.operation.authorization?.method !== "device" ||
                        object.operation.authorization.userCode !== null)
                );
            }, `${cli} ${status}`)) as { type: string; payload: unknown };
            steps.push({ event: { type: event.type, payload: event.payload } });
        };

        const claude: Step[] = [];
        await record(claude, "GET", "/v0/provider-clis/claude");
        await record(claude, "POST", "/v0/provider-clis/claude/sign-in", {
            mutationId: "sign-in",
        });
        await until(claude, "claude", "waiting");
        await record(claude, "POST", "/v0/provider-clis/claude/sign-in/code", {
            code: "good-code",
        });
        await until(claude, "claude", "succeeded");
        files.set(
            "flows/provider-cli-sign-in.claude.json",
            stableJson(normalizeFlow(claude, home)),
        );

        const codex: Step[] = [];
        await record(codex, "GET", "/v0/provider-clis/codex");
        await record(codex, "POST", "/v0/provider-clis/codex/sign-in", {
            method: "device",
        });
        await until(codex, "codex", "waiting");
        await mkdir(join(home, ".codex"), { recursive: true });
        const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
        await writeFile(
            join(home, ".codex", "auth.json"),
            JSON.stringify({
                tokens: {
                    id_token: `${part({ alg: "none" })}.${part({ email: "ada@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })}.signature`,
                },
            }),
        );
        await writeFile(join(home, ".approve-codex"), "");
        await until(codex, "codex", "succeeded");
        await record(codex, "POST", "/v0/provider-clis/codex/cancel", {});
        files.set("flows/provider-cli-sign-in.codex.json", stableJson(normalizeFlow(codex, home)));
    } finally {
        await gym.dispose();
        await rm(root, { recursive: true, force: true });
    }
    return files;
}

/** Replaces the values each run mints, by field name, so the flow compares across runs. */
function normalizeFlow(steps: unknown, home: string): unknown {
    const ids = new Map<string, string>();
    const visit = (value: unknown, key: string): unknown => {
        // How many lines the vendor's program had printed by each event is a race.
        if (Array.isArray(value))
            return key === "output" ? "{{programOutput}}" : value.map((item) => visit(item, key));
        if (value !== null && typeof value === "object")
            return Object.fromEntries(
                Object.entries(value).map(([field, item]) => [field, visit(item, field)]),
            );
        if (typeof value === "number" && key.endsWith("At")) return `{{${key}}}`;
        if (typeof value === "string") {
            if (key === "version" && /^[0-9a-f-]{36}$/.test(value)) return "{{version}}";
            if (key === "id" && /^[a-z][a-z0-9]{23}$/.test(value)) {
                if (!ids.has(value)) ids.set(value, `{{operationId${String(ids.size + 1)}}}`);
                return ids.get(value);
            }
            return value.split(home).join("{{home}}");
        }
        return value;
    };
    return visit(steps, "");
}

async function firstRequestWithText(gym: AgentGym, text: string): Promise<GymInferenceRequest> {
    return await gym.waitUntil(
        async () =>
            gym.inference.requests.find((request) =>
                request.messages.some(
                    (message) =>
                        (message.role === "user" || message.role === "agent") &&
                        message.content.some(
                            (block) => block.type === "text" && block.text.includes(text),
                        ),
                ),
            ),
        `a request carrying ${text}`,
    );
}

/** Every fixture file, by path relative to the fixture root. */
function exportSurface(
    captures: readonly Capture[],
    compaction: GymCompactionRequest,
    standalone: Substitutions,
): Map<string, string> {
    const files = new Map<string, string>();
    const promptIndex: Record<string, unknown>[] = [];
    const toolContexts = new Map<string, string[]>();
    const definitions = new Map<string, Map<string, string>>();
    const toolLists = new Map<string, { readonly hash: string; readonly name: string }[]>();
    for (const capture of captures) {
        const { request, context } = capture;
        const { ids, paths } = capture.substitutions;
        const template = (text: string) =>
            templated(text, { ...ids, [request.sessionId]: "agentId" }, paths, context);
        const instructions = template(request.instructions);
        const tools = request.tools.map(({ parameters, ...tool }) => ({
            ...(JSON.parse(template(JSON.stringify(tool))) as typeof tool),
            inputSchema:
                parameters === undefined
                    ? undefined
                    : (JSON.parse(template(JSON.stringify(parameters))) as unknown),
        }));
        const messages = JSON.parse(template(JSON.stringify(request.messages))) as unknown;
        files.set(`prompts/${context}.md`, instructions);
        const keys = tools.map((tool) => {
            const definition = stableJson(tool);
            const variants = definitions.get(tool.name) ?? new Map<string, string>();
            definitions.set(tool.name, variants);
            const hash = createHash("sha256").update(definition).digest("hex").slice(0, 12);
            variants.set(hash, definition);
            return { hash, name: tool.name };
        });
        toolLists.set(context, keys);
        files.set(`messages/${context}.json`, stableJson(messages));
        for (const tool of tools) {
            const seen = toolContexts.get(tool.name) ?? [];
            seen.push(context);
            toolContexts.set(tool.name, seen);
        }
        promptIndex.push({
            builtBy: capture.builtBy,
            id: context,
            model: request.model,
            placeholders: [
                ...new Set(
                    [instructions, JSON.stringify(tools), JSON.stringify(messages)].flatMap(
                        (text) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]!),
                    ),
                ),
            ].sort(),
            providerKind: providerKind(request.providerId),
            toolCount: tools.length,
        });
    }
    const keyOf = (name: string, hash: string) =>
        definitions.get(name)!.size === 1 ? name : `${name}.${hash}`;
    for (const [name, variants] of definitions)
        for (const [hash, definition] of variants)
            files.set(`tools/definitions/${keyOf(name, hash)}.json`, definition);
    for (const [context, keys] of toolLists)
        files.set(
            `tools/${context}.json`,
            stableJson(keys.map(({ name, hash }) => keyOf(name, hash))),
        );
    files.set("prompts/index.json", stableJson(promptIndex));
    const baseline = toolLists.get(BASELINE)!.map(({ name, hash }) => keyOf(name, hash));
    files.set(
        "variants.json",
        stableJson({
            baseline: BASELINE,
            contexts: Object.fromEntries(
                [...toolLists].map(([context, keys]) => {
                    const list = keys.map(({ name, hash }) => keyOf(name, hash));
                    const names = new Set(keys.map(({ name }) => name));
                    const baseNames = new Set(baseline.map((key) => key.split(".")[0]!));
                    return [
                        context,
                        {
                            added: [...names].filter((name) => !baseNames.has(name)),
                            changed: list.filter(
                                (key) =>
                                    !baseline.includes(key) && baseNames.has(key.split(".")[0]!),
                            ),
                            removed: [...baseNames].filter((name) => !names.has(name)),
                        },
                    ];
                }),
            ),
        }),
    );
    files.set(
        "tools/index.json",
        stableJson(
            Object.fromEntries(
                [...toolContexts]
                    .sort(([a], [b]) => (a < b ? -1 : 1))
                    .map(([name, contexts]) => [name, contexts]),
            ),
        ),
    );
    const main = captures.find((capture) => capture.context === "conversation.multi_turn")!;
    const conversation = (text: string) =>
        templated(
            text,
            { ...standalone.ids, [compaction.sessionId]: "agentId" },
            standalone.paths,
            "compaction",
        );
    files.set(
        "compaction.json",
        stableJson({
            contextInstructionsEqualPrompt:
                compaction.context.instructions === main.request.instructions
                    ? main.context
                    : conversation(compaction.context.instructions ?? ""),
            messages: JSON.parse(conversation(JSON.stringify(compaction.messages))) as unknown,
            model: compaction.model,
            note: "The daemon hands the provider the agent's own instructions and history; the summarizing prompt is the vendor's native compaction inside happy-providers.",
        }),
    );
    return files;
}

function templated(
    text: string,
    ids: Readonly<Record<string, string>>,
    paths: readonly (readonly [string, string])[],
    context: string,
): string {
    // Collaborators are listed by agent ID, so two random IDs come out in either order.
    let result = text.replace(
        /^Collaborators you created: ([a-z0-9]{24}(?:, [a-z0-9]{24})+)\./gm,
        "Collaborators you created: {{collaboratorAgentIdsSortedById}}.",
    );
    for (const [path, name] of paths) result = result.split(path).join(`{{${name}}}`);
    for (const [id, name] of Object.entries(ids)) result = result.split(id).join(`{{${name}}}`);
    result = result
        .replace(/^- Platform: .*$/gm, "- Platform: {{platform}}")
        .replace(/^- Shell: .*$/gm, "- Shell: {{shell}}")
        .replace(/^- OS version: .*$/gm, "- OS version: {{osVersion}}")
        .replace(/^- Current model: .*$/gm, "- Current model: {{modelName}} (`{{modelId}}`)")
        .replace(/^- Current provider: .*$/gm, "- Current provider: `{{providerId}}`");
    const stray = /\b[a-z][a-z0-9]{23}\b/.exec(result);
    if (stray !== null)
        throw new Error(
            `${context} carries an unnamed ID ${stray[0]} near: ${result.slice(Math.max(0, stray.index - 160), stray.index + 40)}`,
        );
    return result;
}

function providerKind(providerId: string): string {
    return Object.hasOwn(PROVIDER_TYPES, providerId)
        ? PROVIDER_TYPES[providerId as keyof typeof PROVIDER_TYPES]
        : providerId;
}

/** JSON with object keys sorted at every depth, so a fixture diff shows only real changes. */
function stableJson(value: unknown): string {
    const sorted = (item: unknown): unknown =>
        Array.isArray(item)
            ? item.map(sorted)
            : item !== null && typeof item === "object"
              ? Object.fromEntries(
                    Object.entries(item)
                        .filter(([, field]) => field !== undefined)
                        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                        .map(([key, field]) => [key, sorted(field)]),
                )
              : item;
    return `${JSON.stringify(sorted(value), null, 2)}\n`;
}

async function readTree(root: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true }).catch(
        () => [],
    )) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        files.set(path.slice(root.length + 1), await readFile(path, "utf8"));
    }
    return files;
}

function headCommit(): string {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
