import { MAX_MCP_PAGE_SIZE, MAX_MCP_TOTAL_TOOLS } from "../Mcp.js";

export async function collectMcpPages<
    Page extends { readonly nextCursor?: string | undefined },
    Item,
>(
    fetchPage: (cursor: string | undefined) => Promise<Page>,
    items: (page: Page) => readonly Item[],
): Promise<Item[]> {
    const collected: Item[] = [];
    let cursor: string | undefined;
    for (let count = 0; count < MAX_MCP_PAGE_SIZE; count += 1) {
        const page = await fetchPage(cursor);
        collected.push(...items(page));
        if (collected.length > MAX_MCP_TOTAL_TOOLS) {
            throw new Error("MCP catalog exceeded its configured bound.");
        }
        if (page.nextCursor === undefined) return collected;
        if (page.nextCursor === cursor) throw new Error("MCP cursor did not advance.");
        cursor = page.nextCursor;
    }
    throw new Error("MCP pagination exceeded its configured bound.");
}
