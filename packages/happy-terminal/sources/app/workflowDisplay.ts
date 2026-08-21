const MAX_SERIALIZED_WORKFLOW_CHARS = 100_000;

export function humanizeWorkflowName(name: string): string {
    const words = name.replace(/[_-]+/g, " ").trim().toLowerCase();
    return words.length === 0
        ? "Workflow"
        : words.replace(/^./u, (character) => character.toUpperCase());
}

export function serializeWorkflowValue(value: unknown): string {
    const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (serialized === undefined) return "The workflow completed without returning a result.";
    return serialized.length <= MAX_SERIALIZED_WORKFLOW_CHARS
        ? serialized
        : `${serialized.slice(0, MAX_SERIALIZED_WORKFLOW_CHARS)}\n… output truncated`;
}
