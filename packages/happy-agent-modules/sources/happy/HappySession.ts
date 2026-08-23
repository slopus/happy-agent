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

/** Rig's current branch/worktree delta against its comparison base. */
export interface HappyGitSummary {
    readonly changedFiles: number;
    readonly countsExact: boolean;
    readonly deletions: number;
    readonly insertions: number;
}

/** One session, in the terms Happy publishes it. */
export interface HappySessionSnapshot {
    readonly agentId: string;
    readonly archived: boolean;
    readonly cwd: string;
    readonly effort?: string;
    /** The project/worktree line delta Rig already computes for its native Git surface. */
    readonly git?: HappyGitSummary;
    readonly modelId: string;
    /** The newest visible human text, final model response, or question, in epoch milliseconds. */
    readonly lastMeaningfulMessageAt?: number;
    /** The branch the working directory is on, when it is a checkout of something. */
    readonly gitBranch?: string;
    readonly permissionMode: AgentPermissionMode;
    /**
     * The project this session belongs to, which is what the phone groups sessions by.
     *
     * Every workspace of one project reports the same project, so their sessions gather in a
     * single card. Absent when the session runs somewhere this daemon does not keep.
     */
    readonly project?: {
        readonly id: string;
        readonly kind: "home" | "regular";
        readonly name: string;
    };
    readonly projectName: string;
    readonly providerId: string;
    readonly serviceTier?: string;
    readonly sessionId: string;
    /** What the session is doing, in the words the daemon uses. */
    readonly status: string;
    /** What this chat is called, once anything has named it. */
    readonly title?: string;
    readonly tools: readonly string[];
    /** True while the agent owes work, which is what the phone shows as thinking. */
    readonly working: boolean;
    /**
     * The workspace this session runs in, absent in the project's own checkout.
     *
     * The name is the workspace's current title rather than its branch, so renaming a workspace
     * renames it everywhere the phone shows it.
     */
    readonly workspace?: { readonly id: string; readonly name: string };
}

/**
 * A message from the phone this daemon will never be able to take.
 *
 * Retrying cannot help, so the message is answered rather than left unacknowledged: the person is
 * told why in the conversation, and the inbox behind it keeps moving. The `message` is written to
 * be read on the phone.
 */
export class HappyMessageRefused extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "HappyMessageRefused";
    }
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

/** One place the phone may ask Happy Agent to start a session. */
export type HappySpawnTarget =
    | { readonly kind: "project"; readonly id: string }
    | { readonly kind: "workspace"; readonly id: string }
    | { readonly kind: "newWorkspace"; readonly projectId: string }
    | { readonly kind: "projectFolder"; readonly projectPath: string };

interface HappySpawnSelection {
    readonly effort: string;
    readonly modelId: string;
    readonly permissionMode: AgentPermissionMode;
    readonly providerId: string;
    /** The session id Happy Agent reserved for this request, the same one on every retry. */
    readonly sessionId: string;
}

/** A legacy directory spawn, kept wire-compatible with the Happy client that already uses it. */
export interface HappyDirectorySpawnRequest extends HappySpawnSelection {
    readonly cwd: string;
}

/** A Happy Agent catalog spawn, once its wire request and model choice have been checked. */
export interface HappyTargetSpawnRequest extends HappySpawnSelection {
    readonly target: HappySpawnTarget;
    /** The deterministic workspace identity used only by `newWorkspace`. */
    readonly workspaceId: string;
}

export type HappySpawnRequest = HappyDirectorySpawnRequest | HappyTargetSpawnRequest;
