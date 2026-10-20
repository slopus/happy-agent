import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { ComputeModule } from "../compute/index.js";
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
import { chatMediaCandidate, chatMediaName } from "./impl/chatMediaKind.js";
import { measureChatImage } from "./impl/measureChatImage.js";
import { writeChatMediaContent } from "./impl/writeChatMediaContent.js";
import { presentFilesTool } from "./tools/present_files.js";
import { showPageTool } from "./tools/show_page.js";

/** What every agent is told about media it shows in a chat. */
export const CHAT_MEDIA_INSTRUCTIONS =
    "Images you generate, artifacts you create or update, files you show with present_files, and web pages you show with show_page appear inline in this chat for the user automatically. Do not paste their paths or links, and do not describe them as if the user cannot see them. They appear only in this chat's history, not in any parent or child chat: when you work for another agent, its user does not see what you showed here, so give that agent the file paths or artifact IDs it needs to present them itself. Someone following this chat from a phone sees only their titles, so when what you showed answers the request, also give its main point in a sentence of your reply. Use present_files when the user should see a file, document, image, or video from your machine, and show_page for a running web page such as your dev server.";

/**
 * Media shown inline in a chat: generated images and files an agent presents.
 *
 * History never holds the bytes. Each item is snapshotted once into the daemon's private,
 * content-addressed media folder, so later edits to or removal of its source change nothing the
 * chat shows, and History records only the item's measurements and digest with the call that
 * showed it. A route then serves an item by that call's identity and the item's position.
 */
export class ChatMediaModule implements AgentModule {
    readonly name = "chat-media";

    /** The shape of a tool result's `presentation`, for tools of other modules to declare. */
    static readonly presentationSchema = chatMediaPresentationSchema;

    readonly #config: ConfigModule;
    readonly #compute: ComputeModule;
    readonly #history: HistoryModule;

    constructor(config: ConfigModule, compute: ComputeModule, history: HistoryModule) {
        this.#config = config;
        this.#compute = compute;
        this.#history = history;
    }

    readonly #hooks: AgentModuleHooks = {
        instructions: () => CHAT_MEDIA_INSTRUCTIONS,
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
            presentFilesTool(this, this.#compute, scope.agent.id),
            showPageTool(),
        ],
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    /**
     * Snapshot bytes already in hand, such as a generated image, and measure them. A picture
     * that does not decode becomes a plain file rather than a failure.
     */
    async snapshot(bytes: Uint8Array, name: string): Promise<ChatMediaItem> {
        const displayName = chatMediaName(name);
        const candidate = chatMediaCandidate(displayName);
        if (bytes.byteLength > candidate.maxBytes) {
            throw new Error(
                `${quoteVisibleExact(displayName)} is larger than the ${formatMiB(candidate.maxBytes)} a presented ${candidate.kind} may be.`,
            );
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const base = { name: displayName, size: bytes.byteLength, sha256 };
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

    /** Wrap snapshotted items as the presentation a tool result carries. */
    presentation(items: readonly ChatMediaItem[]): ChatMediaPresentation {
        if (items.length === 0 || items.length > MAX_CHAT_MEDIA_ITEMS) {
            throw new Error(`A call presents one to ${String(MAX_CHAT_MEDIA_ITEMS)} items.`);
        }
        return { type: "media", items: [...items] };
    }

    /**
     * Read files from the agent's machine under the call's permissions and snapshot each. Every
     * file is measured before it is read, so a directory, an empty file, or one over its limit is
     * refused without reading it.
     */
    async presentFiles(
        ctx: Context,
        agentId: string,
        filepaths: readonly string[],
    ): Promise<{ readonly items: readonly ChatMediaItem[] }> {
        if (filepaths.length === 0 || filepaths.length > MAX_CHAT_MEDIA_ITEMS) {
            throw new Error(`Present one to ${String(MAX_CHAT_MEDIA_ITEMS)} files at a time.`);
        }
        const compute = await this.#compute.resolve(ctx, agentId);
        if (compute === undefined) {
            throw new Error("This conversation has no machine to present files from.");
        }
        const permissions = this.#compute.permissionsForContext(ctx);
        const sources: { readonly path: string; readonly name: string; readonly size: number }[] =
            [];
        let total = 0;
        for (const filepath of filepaths) {
            const path = this.#compute.resolvePath(compute, filepath);
            const name = chatMediaName(this.#compute.pathName(path));
            const facts = await compute.fs.stat(permissions, path);
            if (!facts.isFile) throw new Error(`${quoteVisibleExact(filepath)} is not a file.`);
            if (facts.size === 0) throw new Error(`${quoteVisibleExact(filepath)} is empty.`);
            const candidate = chatMediaCandidate(name);
            if (facts.size > candidate.maxBytes) {
                throw new Error(
                    `${quoteVisibleExact(filepath)} is larger than the ${formatMiB(candidate.maxBytes)} a presented ${candidate.kind} may be.`,
                );
            }
            total += facts.size;
            if (total > MAX_CHAT_MEDIA_CALL_BYTES) {
                throw new Error(
                    `One call may present at most ${formatMiB(MAX_CHAT_MEDIA_CALL_BYTES)} in all.`,
                );
            }
            sources.push({ path, name, size: facts.size });
        }
        const items: ChatMediaItem[] = [];
        for (const source of sources) {
            const bytes = await compute.fs.readFileBuffer(permissions, source.path, {
                maxBytes: chatMediaCandidate(source.name).maxBytes,
            });
            if (bytes.byteLength === 0) {
                throw new Error(`${quoteVisibleExact(source.name)} is empty.`);
            }
            items.push(await this.snapshot(bytes, source.name));
        }
        return { items };
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
