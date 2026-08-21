/**
 * Reads one JSON value out of a model's final message.
 *
 * A fenced block wins when present; otherwise the whole message must be the JSON value. Scraping
 * the first brace through the last one is deliberately not supported, because it lets surrounding
 * prose smuggle a value the model never actually committed to.
 */
export function parseJsonFromModelOutput(text: string): unknown {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)?.[1];
    for (const candidate of [fenced, text]) {
        if (candidate === undefined) continue;
        try {
            return JSON.parse(candidate.trim());
        } catch {
            // Try the bare message before giving up on the fenced block.
        }
    }
    return undefined;
}
