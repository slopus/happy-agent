import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
    createAgentGym,
    type AgentGym,
    type GymCompactionRequest,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

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

interface Capture {
    readonly context: string;
    readonly builtBy: string;
    readonly request: GymInferenceRequest;
}

// The fixtures describe a Linux host; other platforms are told about their own sandbox and paths.
it.runIf(process.platform === "linux")(
    "exports the prompts and tools every agent kind receives",
    async () => {
        const scripted = new Map<string, GymTurn>();
        const gym = await createAgentGym({
            timeoutMs: 30_000,
            providerIds: Object.keys(PROVIDER_TYPES),
            providerTypes: PROVIDER_TYPES,
            models: MAIN.map(([, entry]) => entry),
            files: {
                "AGENTS.md": "{{projectAgentsMd}}\n",
                "AGENTS_SECURITY.md": "{{projectSecurityMd}}\n",
                ".agents/skills/example/SKILL.md":
                    "---\nname: example\ndescription: '{{skillDescription}}'\n---\n\n{{skillBody}}\n",
            },
            inference: (request) => {
                const last = request.messages.at(-1);
                const text =
                    last?.role === "user"
                        ? last.content
                              .map((block) => (block.type === "text" ? block.text : ""))
                              .join("")
                        : "";
                const turn = scripted.get(text.trim());
                if (turn !== undefined) {
                    scripted.delete(text.trim());
                    return turn;
                }
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "<title>Surface export</title>" }] };
                return { content: [{ type: "text", text: "Done." }] };
            },
        });
        try {
            await writeFile(
                join(gym.publicHomePath, "config", "AGENTS.md"),
                "{{globalAgentsMd}}\n",
            );
            await writeFile(
                join(gym.publicHomePath, "config", "SECURITY.md"),
                "{{globalSecurityMd}}\n",
            );
            await writeFile(join(gym.publicHomePath, "AGENTS_SECURITY.md"), "{{homeSecurityMd}}\n");
            const captures: Capture[] = [];
            const firstRequest = (sessionId: string) =>
                gym.waitUntil(
                    async () =>
                        gym.inference.requests.find((request) => request.sessionId === sessionId),
                    `the first request of ${sessionId}`,
                );

            for (const [label, entry] of MAIN) {
                const agent = await gym.createSession({ title: label });
                await gym.send("Hello.", {
                    sessionId: agent.id,
                    providerId: entry.providerId,
                    modelId: entry.id,
                    permissionMode: "auto",
                });
                captures.push({
                    context: `main.${label}`,
                    builtBy: "systemPrompt/SystemPromptModule.ts:SystemPromptModule.instructions",
                    request: await firstRequest(agent.id),
                });
            }

            for (const mode of PERMISSION_MODES) {
                const agent = await gym.createSession({ title: mode });
                await gym.send("Hello.", { sessionId: agent.id, permissionMode: mode });
                captures.push({
                    context: `permission.${mode}`,
                    builtBy: "permissions/PermissionsModule.ts:PermissionsModule",
                    request: await firstRequest(agent.id),
                });
            }

            const chief = (await gym.client.listBots()).bots.find((bot) => bot.isAdmin)!;
            await gym.send("Hello.", { sessionId: chief.agent.id, permissionMode: "auto" });
            captures.push({
                context: "chief_of_staff",
                builtBy:
                    "bots/impl/formatChiefOfStaffInstructions.ts:formatChiefOfStaffInstructions",
                request: await firstRequest(chief.agent.id),
            });

            const bot = (await gym.client.createBot({ name: "Research Bot" })).bot;
            await gym.send("Hello.", { sessionId: bot.agent.id, permissionMode: "auto" });
            captures.push({
                context: "bot",
                builtBy: "bots/BotsModule.ts:BotsModule",
                request: await firstRequest(bot.agent.id),
            });

            const { task } = await gym.client.createTask({ name: "Quarterly review" });
            await gym.send("Hello.", { sessionId: task.agent.id, permissionMode: "auto" });
            captures.push({
                context: "task",
                builtBy: "tasks/TasksModule.ts:TasksModule",
                request: await firstRequest(task.agent.id),
            });

            const selection = gym.selection;
            scripted.set("Start a subtask.", {
                content: [
                    {
                        type: "tool_call",
                        name: "create_subtask",
                        callId: "surface_subtask",
                        arguments: {
                            title: "Subtask",
                            text: "Subtask hello.",
                            model: selection.modelId,
                            provider: selection.providerId,
                            effort: "medium",
                        },
                    },
                ],
            });
            await gym.send("Start a subtask.", {
                sessionId: task.agent.id,
                permissionMode: "auto",
            });
            captures.push({
                context: "subtask",
                builtBy: "subtasks/SubtasksModule.ts:SubtasksModule",
                request: await firstRequestWithText(gym, "Subtask hello."),
            });

            scripted.set("Start a collaborator.", {
                content: [
                    {
                        type: "tool_call",
                        name: "create_agent",
                        callId: "surface_collaborator",
                        arguments: {
                            title: "Collaborator",
                            text: "Collaborator hello.",
                            model: selection.modelId,
                            provider: selection.providerId,
                            effort: "medium",
                        },
                    },
                ],
            });
            await gym.send("Start a collaborator.", { permissionMode: "auto" });
            captures.push({
                context: "collaborator",
                builtBy: "collaboration/CollaborationModule.ts:CollaborationModule",
                request: await firstRequestWithText(gym, "Collaborator hello."),
            });

            scripted.set("Run outside the sandbox.", {
                content: [
                    {
                        type: "tool_call",
                        name: "Bash",
                        callId: "surface_review",
                        arguments: {
                            command: "ls /",
                            description: "List the root folder",
                            dangerouslyDisableSandbox: true,
                        },
                    },
                ],
            });
            const before = gym.inference.requests.length;
            await gym.send("Run outside the sandbox.", { permissionMode: "auto" });
            const sessions = new Set(captures.map((capture) => capture.request.sessionId));
            const reviews = gym.inference.requests
                .slice(before)
                .filter(
                    (request) =>
                        !sessions.has(request.sessionId) &&
                        request.sessionId !== gym.defaultSessionId &&
                        !request.sessionId.startsWith("naming:"),
                );
            expect(reviews).toHaveLength(1);
            captures.push({
                context: "auto_review",
                builtBy: "auto/prompts/guardian-policy-template.md",
                request: reviews[0]!,
            });

            const naming = gym.inference.requests.find((request) =>
                request.sessionId.startsWith("naming:"),
            );
            expect(naming).toBeDefined();
            captures.push({
                context: "naming",
                builtBy: "titles/impl/runNamingInference.ts:runNamingInference",
                request: naming!,
            });

            await gym.compact();
            const compaction = await gym.waitUntil(
                async () => gym.inference.compactions[0],
                "the compaction request",
            );

            const ids: Record<string, string> = {
                [gym.defaultSessionId]: "mainAgentId",
                [chief.agent.id]: "chiefOfStaffAgentId",
                [chief.id]: "chiefOfStaffBotId",
                [bot.agent.id]: "botAgentId",
                [bot.id]: "botId",
                [task.agent.id]: "taskAgentId",
                [task.id]: "taskId",
            };
            for (const capture of captures)
                ids[capture.request.sessionId] ??= `${capture.context.replace(/\W/g, "_")}_agentId`;
            for (const workspace of [chief.workspaceId, bot.workspaceId, task.agent.workspaceId])
                ids[workspace] ??= `workspaceId`;
            const paths: [string, string][] = [
                [gym.workspacePath, "workspacePath"],
                [gym.happyHome, "happyHome"],
                [gym.publicHomePath, "happyPublicHome"],
                [join(gym.workspacePath, ".."), "installationRoot"],
            ];
            const surface = exportSurface(captures, compaction, ids, paths);
            const health = await gym.client.getHealth();
            const manifest = {
                contexts: captures.map((capture) => capture.context),
                generatedBy: SCRIPT,
                happyAgentCommit: UPDATE ? headCommit() : "",
                protocol: health.version.protocol,
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
        } finally {
            await gym.dispose();
        }
    },
    300_000,
);

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
    ids: Readonly<Record<string, string>>,
    paths: readonly (readonly [string, string])[],
): Map<string, string> {
    const files = new Map<string, string>();
    const promptIndex: Record<string, unknown>[] = [];
    const toolContexts = new Map<string, string[]>();
    const definitions = new Map<string, Map<string, string>>();
    const toolLists = new Map<string, { readonly hash: string; readonly name: string }[]>();
    for (const capture of captures) {
        const { request, context } = capture;
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
    const main = captures.find((capture) => capture.context === "main.claude-opus-5-5")!;
    const conversation = (text: string) =>
        templated(text, { ...ids, [compaction.sessionId]: "agentId" }, paths, "compaction");
    files.set(
        "compaction.json",
        stableJson({
            contextInstructionsEqualPrompt:
                compaction.context.instructions === main.request.instructions
                    ? "main.claude-opus-5-5"
                    : conversation(compaction.context.instructions ?? ""),
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
    let result = text;
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
