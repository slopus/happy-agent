import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import { Value } from "@sinclair/typebox/value";
import {
    mediaItemSourceSchema,
    type MediaItemSource,
    type MediaLayout,
} from "@slopus/happy-agent-client";
import type { AgentModule, AgentModuleHooks } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { ConfigModule } from "../config/index.js";
import type { HistoryModule } from "../history/index.js";
import { quoteVisibleExact } from "../impl/quoteVisibleExact.js";
import {
    chatMediaPresentationSchema,
    MAX_CHAT_MEDIA_CALL_BYTES,
    MAX_CHAT_MEDIA_ITEMS,
    type ChatMediaItem,
    type ChatMediaPresentation,
    type ChatMediaStoredItem,
} from "./ChatMedia.js";
import {
    chatMediaCandidate,
    chatMediaName,
    type ChatMediaCandidate,
} from "./impl/chatMediaKind.js";
import { measureChatImage, type MeasuredChatImage } from "./impl/measureChatImage.js";
import { parseMediaLayout, type ParsedMediaLayout } from "./impl/parseMediaLayout.js";
import { writeChatMediaContent } from "./impl/writeChatMediaContent.js";

/** What every agent is told about media it shows in a chat. */
export const CHAT_MEDIA_INSTRUCTIONS =
    'Images you generate or read, artifacts you create or update, and files you show with present_files appear inline in this chat for the user automatically. An image you have read with a file-reading tool is already shown, so do not present it again. To arrange images already shown in this chat, write plain HTML in your reply with each src the path you read, presented, or generated it at, such as <div style="display:grid;grid-template-columns:1fr 1fr"><img src="a.png"><img src="b.png"></div>. A reply may also carry charts, diagrams, code quotes, and changed-files lists as native <happy-chart>, <happy-diagram>, <happy-code>, and <happy-files> blocks; read the rich-replies skill before writing them. Do not paste their paths or links, and do not describe them as if the user cannot see them. They appear only in this chat\'s history, not in any parent or child chat: when you work for another agent, its user does not see what you showed here, so give that agent the file paths or artifact IDs it needs; the parent should link text files and present only media, and mention artifacts by their reference tags. Someone following this chat from a phone sees only their titles, so when what you showed answers the request, also give its main point in a sentence of your reply. Use present_files for images, videos, PDFs, and files the user should receive or download, including when the reader is not on this machine. Link text, code, and Markdown files instead, so the link opens the live file in the viewer. For a running web page such as your dev server, use create_artifact with type "html" and url.';

/**
 * Media shown inline in a chat: generated images, images an agent reads, and files it presents.
 *
 * History never holds the bytes. Each item is snapshotted once into the daemon's private,
 * content-addressed media folder, so later edits to or removal of its source change nothing the
 * chat shows, and History records only the item's measurements and digest with the call that
 * showed it. A route then serves an item by that call's identity and the item's position. The
 * tools that read files from an agent's machine belong to compute, which asks this module to
 * snapshot what they show.
 */
export class ChatMediaModule implements AgentModule {
    readonly name = "chat-media";

    /** The shape of a tool result's `presentation`, for tools of other modules to declare. */
    static readonly presentationSchema = chatMediaPresentationSchema;
    /** How many items one call may show. */
    static readonly maxItems = MAX_CHAT_MEDIA_ITEMS;
    /** The most one call may show in all, in bytes. */
    static readonly maxCallBytes = MAX_CHAT_MEDIA_CALL_BYTES;

    readonly #config: ConfigModule;
    readonly #history: HistoryModule;

    constructor(config: ConfigModule, history: HistoryModule) {
        this.#config = config;
        this.#history = history;
    }

    readonly #hooks: AgentModuleHooks = {
        instructions: () => CHAT_MEDIA_INSTRUCTIONS,
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    /**
     * Snapshot bytes already in hand, such as a generated image, and measure them. A picture
     * that does not decode becomes a plain file rather than a failure. `source` is the file the
     * bytes came from, as the agent named it and resolved, so a layout block in the agent's text
     * can name the item by it.
     */
    async snapshot(
        bytes: Uint8Array,
        name: string,
        source?: MediaItemSource,
    ): Promise<ChatMediaItem> {
        const displayName = chatMediaName(name);
        const candidate = chatMediaCandidate(displayName);
        if (bytes.byteLength > candidate.maxBytes) {
            throw new Error(
                `${quoteVisibleExact(displayName)} is larger than the ${formatMiB(candidate.maxBytes)} a presented ${candidate.kind} may be.`,
            );
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const base = {
            name: displayName,
            size: bytes.byteLength,
            sha256,
            // A path too long to record only means a layout block cannot name the item.
            ...(source === undefined || !Value.Check(mediaItemSourceSchema, source)
                ? {}
                : { source }),
        };
        let item: ChatMediaItem;
        if (candidate.kind === "image") {
            const image = await measureChatImage(bytes, candidate.mimeType);
            item =
                image === undefined
                    ? { kind: "file", mimeType: candidate.mimeType, ...base }
                    : { kind: "image", ...base, ...image };
        } else {
            item = { kind: candidate.kind, mimeType: candidate.mimeType, ...base };
        }
        await writeChatMediaContent(this.#config.chatMediaContentPath(sha256), bytes);
        return item;
    }

    /**
     * Measure an image the way a chat measures what it shows: its served media type, size after
     * EXIF orientation, density, and ThumbHash. Undefined when the bytes are not a picture a
     * client can show.
     */
    async measureImage(
        bytes: Uint8Array,
        declaredMimeType: string,
    ): Promise<MeasuredChatImage | undefined> {
        return await measureChatImage(bytes, declaredMimeType);
    }

    /**
     * What a file of this name would be shown as, and the most it may be, before any byte of it
     * is read. Its bytes decide the rest when it is snapshotted.
     */
    limit(name: string): ChatMediaCandidate {
        return chatMediaCandidate(chatMediaName(name));
    }

    /**
     * Turn layout HTML an agent wrote for files it presents into the typed tree clients render.
     * This never fails: what the layout subset lacks is left out and reported, files the layout
     * does not place are added after it, and a layout that places none of them is not used.
     * `filepaths` are the call's paths exactly as written; an `<img src>` naming one of them
     * becomes that item's index.
     */
    parseLayout(html: string, filepaths: readonly string[]): ParsedMediaLayout {
        return parseMediaLayout(html, filepaths);
    }

    /**
     * Wrap snapshotted items as the presentation a tool result carries. Without a layout, a
     * client arranges them automatically.
     */
    presentation(items: readonly ChatMediaItem[], layout?: MediaLayout): ChatMediaPresentation {
        if (items.length === 0 || items.length > MAX_CHAT_MEDIA_ITEMS) {
            throw new Error(`A call presents one to ${String(MAX_CHAT_MEDIA_ITEMS)} items.`);
        }
        return { type: "media", items: [...items], ...(layout === undefined ? {} : { layout }) };
    }

    /**
     * Where one item of a call's recorded presentation is kept. Undefined when the call, its
     * media, the item, or its snapshot does not exist.
     */
    async storedItem(
        ctx: Context,
        agentId: string,
        callId: string,
        index: number,
    ): Promise<ChatMediaStoredItem | undefined> {
        if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_CHAT_MEDIA_ITEMS) {
            return undefined;
        }
        const presentation = await this.#history.toolResultPresentation(ctx, agentId, callId);
        if (presentation?.type !== "media") return undefined;
        const item = presentation.items[index];
        if (item === undefined) return undefined;
        const contentPath = this.#config.chatMediaContentPath(item.sha256);
        const facts = await stat(contentPath).catch(() => undefined);
        if (facts?.isFile() !== true || facts.size !== item.size) return undefined;
        return { item, contentPath };
    }

    /**
     * Every item one call presented whose snapshot is still kept, in order. Empty when the call
     * presented nothing or failed.
     */
    async storedItems(
        ctx: Context,
        agentId: string,
        callId: string,
    ): Promise<readonly ChatMediaStoredItem[]> {
        const presentation = await this.#history.toolResultPresentation(ctx, agentId, callId);
        if (presentation?.type !== "media") return [];
        const stored: ChatMediaStoredItem[] = [];
        for (const item of presentation.items) {
            const contentPath = this.#config.chatMediaContentPath(item.sha256);
            const facts = await stat(contentPath).catch(() => undefined);
            if (facts?.isFile() === true && facts.size === item.size) {
                stored.push({ item, contentPath });
            }
        }
        return stored;
    }
}

function formatMiB(bytes: number): string {
    return `${String(bytes / (1024 * 1024))} MiB`;
}
