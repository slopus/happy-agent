import type { AgentPermissionMode } from "@slopus/happy-agent-base";

/** How Happy classifies a mode, so its own UI can colour and order the choices. */
export type HappyPermissionModeKind = "default" | "read-only" | "safe-yolo" | "yolo";

/**
 * Happy Agent's permission modes as the phone offers them.
 *
 * The words are the ones a person reads on the mode picker, so they say what
 * the mode actually does rather than repeating its identifier.
 */
export const HAPPY_PERMISSION_MODES = [
    {
        code: "auto",
        description: "Uses the workspace sandbox and reviews actions that need full access.",
        kind: "safe-yolo",
        value: "Auto",
    },
    {
        code: "workspace_write",
        description: "Allows workspace changes while blocking shell network and outside writes.",
        kind: "default",
        value: "Workspace write",
    },
    {
        code: "read_only",
        description: "Allows inspection without workspace changes or shell network access.",
        kind: "read-only",
        value: "Read only",
    },
    {
        code: "full_access",
        description: "Removes Happy Agent's filesystem, shell, and network restrictions.",
        kind: "yolo",
        value: "Full access",
    },
] as const satisfies readonly {
    code: AgentPermissionMode;
    description: string;
    kind: HappyPermissionModeKind;
    value: string;
}[];
