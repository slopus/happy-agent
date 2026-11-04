import { readFile } from "node:fs/promises";

import type { AgentBaseSystemNotificationBoundary } from "@slopus/happy-agent-base";
import type { SessionInputBlock, SessionSystemMessage } from "@slopus/happy-providers";

import type { ConfigModule } from "../config/index.js";
import { prepareImageForPrompt } from "../impl/images/prepareImageForPrompt.js";
import { storyQuoteOf } from "../impl/storyQuote.js";

/** A frame larger than this is described rather than read inside the acceptance transaction. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * What the agent is told just before a person's reply to its story: which story, and its first
 * frame as a picture. The reply itself stays exactly what the person wrote.
 */
export async function storyQuoteNotice(
    config: ConfigModule,
    boundary: AgentBaseSystemNotificationBoundary,
): Promise<readonly SessionSystemMessage[]> {
    const quote =
        boundary.type === "message" ? storyQuoteOf(boundary.accepted.metadata) : undefined;
    if (quote === undefined) return [];
    const frame = quote.frame && quote.frame.size <= MAX_FRAME_BYTES ? quote.frame : null;
    const image = await (async (): Promise<SessionInputBlock | undefined> => {
        if (frame === null) return undefined;
        const bytes = await readFile(config.chatMediaContentPath(frame.sha256));
        const limits = { maxDimension: 1024, maxPatches: Number.POSITIVE_INFINITY };
        const prepared = await prepareImageForPrompt(bytes, limits);
        return {
            type: "image",
            mimeType: prepared.mediaType,
            data: prepared.bytes.toString("base64"),
        };
    })().catch(() => undefined);
    const story = quote.userId === null ? "your story" : "a repost of your story";
    const caption = quote.caption === null ? "" : ` “${quote.caption.replace(/\s+/gu, " ")}”`;
    const shown = image === undefined ? "" : " Its first frame follows.";
    const text = `The person's next message replies to ${story}${caption} (story ${quote.storyId}).${shown}`;
    return [{ role: "system", content: [{ type: "text", text }, ...(image ? [image] : [])] }];
}
