import type {
    AvailableSubagentModel,
    DisabledSubagentProvider,
} from "../context/SubagentContext.js";
import type { PermissionMode } from "../../permissions/index.js";
import type { AnyDefinedTool } from "../types.js";
import type { HostedCapability } from "@slopus/rig-execution";

/** Marks the role section so a child can strip its parent's copy before appending its own. */
const SUBAGENT_INSTRUCTIONS_MARKER =
    "You are a child subagent working for a parent agent on one delegated task.";

export const RIG_AGENT_TOOL_INSTRUCTIONS = `## Agent tool portability

- \`collaboration\` is Codex Cloud's encrypted v2 protocol. \`multi_agent_v1\` is the plaintext protocol used by Codex models on Amazon Bedrock.
- \`rig\` is provider-neutral. Use it when selecting or crossing models, providers, or regions, when native collaboration is unavailable, and when setting effort.
- If a native collaboration call rejects the target, retry with the matching \`rig\` tool and provide the normal task text. Never copy or reinterpret encrypted content.`;

export const STEERABLE_TOOL_INSTRUCTIONS = `## Steerable tools

Tools described as steerable are interrupted when new steering arrives, including new user messages, messages from other agents, and background completion notifications. Rig closes the interrupted tool call, adds the new information to the conversation, and continues the same turn so you can respond immediately.`;

/**
 * Describes what a sandboxed command cannot do, so the model recognizes a boundary instead of
 * rediscovering it as a mysterious failure.
 *
 * Each line is something that has surprised an agent in practice: a write that lands outside the
 * workspace, a socket that exists but cannot be reached, a credential store that answers as if the
 * secret were simply missing. Knowing the shape of the wall is what turns a retry loop into either
 * a reviewed escalation or an honest report.
 */
function sandboxLimitsInstructions(mode: PermissionMode): string {
    return [
        "Shell commands run in a sandbox with these limits:",
        mode === "read_only"
            ? "- Nothing on the host is writable except temporary directories, and on macOS no local socket may be created."
            : "- Writes are confined to the working directory, its Git control directory, and temporary directories. Everything else on the host is readable but not writable.",
        "- Put any local unix socket inside the working directory. On macOS a socket anywhere else is refused, including one in a temporary directory. Never rely on reaching the host's own sockets, such as the Docker daemon or the SSH agent.",
        "- On macOS, binding a local TCP or UDP port is refused unless the user has enabled local binding in configuration. On Linux and in Docker, a listener is reachable only from inside that command.",
        "- Outbound network access is blocked except for domains and ports the user has allowed, which are reached through a managed proxy.",
        "- On macOS, the keychain is unavailable: `security`, and anything backed by the keychain, fails or reports nothing rather than returning a secret. Treat other system credential stores the same way.",
        mode === "auto"
            ? "- When one of these limits blocks necessary work, request reviewed full-access execution for that one command and explain why. Never route around a limit by another means."
            : "- When one of these limits blocks necessary work, stop and tell the user which limit it was. A sandbox refusal is not a bug in your command, and it is not something to route around.",
    ].join("\n");
}

export function createPermissionInstructions(
    mode: PermissionMode,
    tools: readonly AnyDefinedTool[] = [],
): string {
    if (mode === "auto") {
        const toolInstructions = [
            ...new Set(
                tools.flatMap((tool) =>
                    tool.autoPermissionInstructions === undefined
                        ? []
                        : [tool.autoPermissionInstructions],
                ),
            ),
        ];
        return [
            "You are in Auto mode. Routine reads and workspace edits run automatically. Permission-sensitive actions are reviewed automatically; low-risk actions proceed, while potentially unsafe actions require one-time user approval. Every shell tool uses the same workspace sandbox by default. Request reviewed full-access execution only when that sandbox blocks necessary work, and give a clear reason. Do not work around a denied permission or retry the same action unchanged.",
            sandboxLimitsInstructions(mode),
            ...toolInstructions,
        ].join("\n\n");
    }
    if (mode === "read_only") {
        return [
            "You are in Read only mode. You may inspect files and run non-mutating shell commands. File tools cannot make changes; shell commands may only write temporary files, and shell network access is blocked.",
            sandboxLimitsInstructions(mode),
        ].join("\n\n");
    }
    if (mode === "workspace_write") {
        return [
            "You are in Workspace write mode. You may modify files inside the working directory. Shell writes outside it and shell network access are blocked.",
            sandboxLimitsInstructions(mode),
        ].join("\n\n");
    }
    return "You are in Full access mode. Filesystem, shell, and network access are unrestricted.";
}

export function createAvailableModelsInstructions(
    models: readonly AvailableSubagentModel[],
    disabledProviders: readonly DisabledSubagentProvider[] = [],
): string | undefined {
    if (models.length === 0 && disabledProviders.length === 0) return undefined;

    const sections: string[] = [];
    if (models.length > 0) {
        sections.push(
            [
                "# Available models",
                "You can run subagents with any of these models by passing the provider and model ID exactly as shown. The effort value must be one of that model's listed levels:",
                ...models.map((model) => {
                    const efforts = model.effortLevels
                        .map((effort) =>
                            effort === model.defaultEffort ? `${effort} (default)` : effort,
                        )
                        .join(", ");
                    return `- ${model.providerId}: ${model.name} (\`${model.id}\`) — effort levels: ${efforts}`;
                }),
                "",
                "Every subagent you start needs an explicit model and effort; nothing is inherited. Pick both for the task: the model's default effort, or a lower one, is right for research, review, and other bounded work, and xhigh, max, or ultra is only for work the user asked to run at that effort.",
                "",
                "A background subagent notifies you when it finishes, even while you are idle, so never poll it. When there is nothing to do but wait, wait once for a long time — an hour is the normal wait — or simply end your turn. Every wait that times out costs another full model turn over your whole context and tells you nothing.",
            ].join("\n"),
        );
    }
    if (disabledProviders.length > 0) {
        sections.push(
            [
                "# Disabled providers",
                "These providers cannot be used in this daemon session. Do not try to use or suggest models from them:",
                ...disabledProviders.map((provider) => {
                    const explanation =
                        provider.reason === "not_enabled"
                            ? "disabled in configuration"
                            : provider.reason === "not_authenticated"
                              ? "no local authentication was found"
                              : "no models are available after applying configuration and regional availability";
                    return `- ${provider.id}: ${explanation}`;
                }),
            ].join("\n"),
        );
    }
    return sections.join("\n\n");
}

export function createBundledDocsInstructions(docsPath: string): string {
    return `# Rig and Happy documentation

Rig ships documentation about Rig and Happy as a read-only folder at \`${docsPath}\`. Read it only when the user asks about Rig or Happy themselves — their features, configuration, tools, or behavior — or when you need to explain or troubleshoot them. Resolve paths inside it against \`${docsPath}\`, not the current working directory. It is reference material, not project context, and never a place to write.

\`${docsPath}/DESIGN.md\` is the design specification for Happy plugin apps and webapps. Read it before designing or building a Happy webapp or plugin UI, and follow its host style variables, surfaces, layout grid, typography, control, and state rules so the result looks like part of Happy rather than a generic page.`;
}

export function createParentDelegationInstructions(): string {
    return `# Delegation role

You are the parent agent. You are explicitly allowed to spawn subagents for concrete, bounded work that is genuinely independent and benefits from parallel execution or separate context.

Do simple work directly. When you delegate, give each child one clear task, keep doing useful work yourself, and combine the results into the response to the user. A child may delegate further only when you explicitly allow nested delegation in its assigned task.`;
}

export function createCapabilityDelegationInstructions(
    grantable: readonly HostedCapability[],
): string {
    return `# Provider-executed search

You cannot search the web or X yourself. What you can do is grant that reach to one subagent, through the \`capabilities\` argument on the spawn call, choosing from: ${grantable.join(", ")}.

This split is deliberate. These searches run inside the provider's own response rather than as a tool Rig executes, so once an agent holds one, Rig cannot review an individual search, cannot show the user what was searched for, and cannot see what came back. The spawn call is the only moment anyone decides. Everything that protects the user has to happen in how you write it.

So carve out the research task before making the call. Work out what actually needs to be found, give the child that question plus the context it genuinely needs to answer it, and nothing more — a child handed the whole conversation is a child that can put any part of it into a search box. Then use what it reports back.

A subagent granted one of these cannot spawn subagents of its own, and only Grok models can run them.`;
}

export function createWorkspaceInstructions(): string {
    return `# Workspaces

This conversation already lives in its own workspace: the working directory. The work you were asked to do happens right here, and needs no workspace management at all. Subagents helping with this same task belong in this workspace too — one task, however many hands, is one workspace.

A separate workspace exists to isolate work, not to organize it. Create one with \`create_workspace\` when a piece of work will run alongside other work and their changes could overlap: parallel tasks each get their own fresh workspace so they can never collide. This is the only criterion — not the number of tasks, not their size. Do not create workspaces for subtasks of the work you are already doing, and do not put two parallel tasks into one workspace.

Work in a workspace runs from inside that workspace. Start its agents with \`spawn_workspace_agent\` or \`delegate_to_workspace\` so their working directory is the workspace itself. Never start an agent in your own directory and have it reach into another workspace's folder by path — an agent whose working directory is one workspace must not edit files in another.

A workspace is not free. Each one is a separate checkout that installs its own dependencies and builds up its own context from scratch, so creating one must be justified by the isolation it buys — a task that truly runs in parallel with other work — and never done casually.

An existing workspace belongs to the work already living in it. Reuse one only to continue that same work, or when the user explicitly points you at it. A workspace created by another session is not yours to move into: if coordinating work across tasks or projects seems to genuinely require it, ask the user first. When an owned workspace's work is finished or abandoned, archive it rather than keeping it around for later reuse.`;
}

export function createSubagentInstructions(
    parentInstructions: string | undefined,
    depth: number,
    maxDepth: number,
): string {
    const previousStart = parentInstructions?.indexOf(SUBAGENT_INSTRUCTIONS_MARKER) ?? -1;
    const baseInstructions =
        previousStart >= 0
            ? parentInstructions?.slice(0, previousStart).trimEnd()
            : parentInstructions;
    return [
        baseInstructions,
        `${SUBAGENT_INSTRUCTIONS_MARKER} You are not the parent agent. Complete the assigned task directly, stay within its scope, and return a concise result to the parent agent.\n\nThe parent agent may send follow-up work after this step. Continue from your existing context when it does.`,
        depth < maxDepth
            ? `You are at depth ${depth} of ${maxDepth}. Do not spawn another subagent unless the parent explicitly instructed you in the delegated task that nested delegation is allowed. The presence of collaboration tools does not grant that permission.`
            : "You are at the maximum subagent depth and must complete the task directly.",
    ]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join("\n\n");
}
