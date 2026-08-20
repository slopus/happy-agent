import { agentPermissionModeLabel, type AgentPermissionMode } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";

import {
    permissionToolGuidancesSchema,
    type PermissionToolGuidance,
} from "../PermissionToolGuidance.js";

export const MAX_PERMISSION_GUIDANCE_CHARACTERS = 32_000;

/**
 * What the model is told about the mode it is working in. A model that knows what it may touch
 * spends its turn on work that can actually happen, instead of discovering the boundary one refused
 * tool call at a time.
 */
export function permissionModeGuidance(
    mode: AgentPermissionMode,
    tools: readonly PermissionToolGuidance[] = [],
): string {
    if (!Value.Check(permissionToolGuidancesSchema, tools)) {
        throw new Error("Permission tool guidance is invalid.");
    }
    const sections = [`You are working in ${agentPermissionModeLabel(mode)} mode. ${rules(mode)}`];
    if (mode !== "full_access") sections.push(sandboxLimitsInstructions(mode));
    if (mode === "auto") {
        for (const instruction of uniqueToolInstructions(tools)) sections.push(instruction);
    }
    return boundGuidance(sections.join("\n\n"));
}

/**
 * What the agent is sent when somebody changes its mode. The change travels with a message, so the
 * message may as well be the one that says what changed: the model reads it in the conversation at
 * exactly the point the new mode takes effect.
 */
export function permissionModeChangeNotice(
    mode: AgentPermissionMode,
    tools: readonly PermissionToolGuidance[] = [],
): string {
    return `The permission mode has been changed to ${agentPermissionModeLabel(mode)}. ${permissionModeGuidance(mode, tools)}`;
}

/** The one paragraph that says what this mode actually permits. */
function rules(mode: AgentPermissionMode): string {
    switch (mode) {
        case "read_only":
            return (
                "You may inspect files and run non-mutating shell commands. File tools cannot make " +
                "changes; shell commands may only write temporary files, and shell network access " +
                "is blocked."
            );
        case "workspace_write":
            return (
                "You may modify files inside the working directory. Shell writes outside it and " +
                "shell network access are blocked, and asking to escalate has no effect in this " +
                "mode."
            );
        case "auto":
            return (
                "Routine work runs inside the workspace sandbox. An action that would cross that " +
                "boundary is reviewed automatically before it runs; the person is never asked, " +
                "and a reviewer's explicit denial is final. A timeout or unavailable reviewer " +
                "leaves the action unproven, so you may try once more or ask the user how to " +
                "proceed. Do not work around a denial or retry the same denied action in another " +
                "form."
            );
        case "full_access":
            return (
                "No filesystem, shell, or network restriction of Rig's own applies, so nothing " +
                "will stop a destructive or outward-facing action on your behalf. Take the care " +
                "the absence of a boundary calls for: confirm anything hard to reverse before " +
                "doing it."
            );
    }
}

function sandboxLimitsInstructions(mode: Exclude<AgentPermissionMode, "full_access">): string {
    return [
        "Shell commands run in a sandbox with these limits:",
        mode === "read_only"
            ? "- Nothing on the host is writable except temporary directories, and on macOS no local socket may be created."
            : "- Writes are confined to the working directory and temporary directories; Git control paths are read-only. Everything else on the host is readable but not writable.",
        "- Put any local unix socket inside the working directory. On macOS a socket anywhere else is refused, including one in a temporary directory. Never rely on reaching the host's own sockets, such as the Docker daemon or the SSH agent.",
        "- On macOS, binding a local TCP or UDP port is refused unless the user has enabled local binding in configuration. On Linux and in Docker, a listener is reachable only from inside that command.",
        "- Outbound network access is blocked except for domains and ports the user has allowed, which are reached through a managed proxy.",
        "- On macOS, the keychain is unavailable: `security`, and anything backed by the keychain, fails or reports nothing rather than returning a secret. Treat other system credential stores the same way.",
        mode === "auto"
            ? "- When one of these limits blocks necessary work, request reviewed full-access execution for that one command and explain why. Never route around a limit by another means."
            : "- When one of these limits blocks necessary work, stop and tell the user which limit it was. A sandbox refusal is not a bug in your command, and it is not something to route around.",
    ].join("\n");
}

function uniqueToolInstructions(tools: readonly PermissionToolGuidance[]): readonly string[] {
    return [
        ...new Set(
            tools
                .map((tool) => tool.autoPermissionInstructions)
                .filter((instruction): instruction is string => instruction !== undefined)
                .map((instruction) => instruction.trim())
                .filter((instruction) => instruction.length > 0),
        ),
    ];
}

function boundGuidance(guidance: string): string {
    if (guidance.length <= MAX_PERMISSION_GUIDANCE_CHARACTERS) return guidance;
    const marker = "\n\n[Additional permission guidance omitted.]";
    return `${guidance.slice(0, MAX_PERMISSION_GUIDANCE_CHARACTERS - marker.length)}${marker}`;
}
