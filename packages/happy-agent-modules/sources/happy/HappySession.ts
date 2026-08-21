import type { AgentPermissionMode } from "@slopus/happy-agent-base";

/**
 * The vocabulary Happy describes a session in.
 *
 * These are the shapes the module's own pieces hand each other: what a session looks like once it
 * is ready to publish, what arrived from the phone, and what a phone asked to start. The
 * conversation itself lives in the daemon's catalogs; this is only how it is spoken about here.
 */

/** One model, as the phone lists it. */
export interface HappyModel {
    readonly contextWindow?: number;
    readonly defaultEffort: string;
    readonly effortLevels: readonly string[];
    readonly id: string;
    readonly name: string;
    readonly providerId: string;
    readonly serviceTiers: readonly string[];
}

/** One session, in the terms Happy publishes it. */
export interface HappySessionSnapshot {
    readonly agentId: string;
    readonly archived: boolean;
    readonly cwd: string;
    readonly effort?: string;
    readonly modelId: string;
    readonly permissionMode: AgentPermissionMode;
    readonly projectName: string;
    readonly providerId: string;
    readonly serviceTier?: string;
    readonly sessionId: string;
    /** What the session is doing, in the words the daemon uses. */
    readonly status: string;
    readonly title: string;
    readonly tools: readonly string[];
    /** True while the agent owes work, which is what the phone shows as thinking. */
    readonly working: boolean;
}

/** One image a person attached on the phone. */
export interface HappyInboundImage {
    readonly data: string;
    readonly mimeType: string;
}

/** What arrived from the phone, ready for the conversation. */
export interface HappyInboundMessage {
    readonly images: readonly HappyInboundImage[];
    /** Namespaced identity of the remote message, so its echo can be recognized. */
    readonly remoteMessageId: string;
    readonly selection: {
        readonly effort?: string;
        readonly modelId?: string;
        readonly permissionMode?: AgentPermissionMode;
        readonly providerId?: string;
    };
    readonly text: string;
}

/** A session the phone asked for, once everything about it has been checked. */
export interface HappySpawnRequest {
    readonly cwd: string;
    readonly effort: string;
    readonly modelId: string;
    readonly permissionMode: AgentPermissionMode;
    readonly providerId: string;
    /** The session id Happy Agent reserved for this request, the same one on every retry. */
    readonly sessionId: string;
}
