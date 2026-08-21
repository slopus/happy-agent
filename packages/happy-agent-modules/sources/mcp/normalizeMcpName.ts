/** Converts an MCP display name into the stable identifier form used by Happy Agent tools. */
export function normalizeMcpName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}
