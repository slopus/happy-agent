/**
 * Tell a task's agent what the task is called, as a notice in the conversation.
 *
 * A name changes: a new task names itself seconds into its first turn, and people rename tasks.
 * The system prompt must not change with it, so the name travels as a message instead.
 */
export function formatTaskNameNotice(name: string): string {
    return [
        "# Task name",
        `This task is named ${JSON.stringify(name)}. Use this name when referring to the work; it replaces any earlier name.`,
    ].join("\n");
}
