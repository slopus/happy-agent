/**
 * The person's conversations in sidebar order: bots, their tasks, project and workspace
 * conversations, and the subtasks under any of them. IDs travel beside the names only for
 * targeting and are never spoken.
 */
export interface VoiceDirectory {
    readonly rows: readonly VoiceDirectoryRow[];
}

export interface VoiceDirectoryRow {
    readonly agentId: string;
    /** The sidebar's own label, "Untitled" or "New Task" included. */
    readonly title: string;
    readonly kind: "bot" | "task" | "subtask" | "conversation";
    /** The titles it sits under, outermost first, headings included; empty at the top level. */
    readonly parents: readonly string[];
    /** The conversation a subtask sits under. */
    readonly parentAgentId?: string;
    /** The project and workspace headings it sits under, outermost first, when it has any. */
    readonly headings?: readonly VoiceDirectoryHeading[];
}

/** A project or workspace line: a heading without a reference of its own. */
export interface VoiceDirectoryHeading {
    readonly title: string;
    readonly kind: "project" | "workspace";
}
