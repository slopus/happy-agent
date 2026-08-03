import type { ConnectionState, MutationRejectedDelta } from "./ChatElement.js";
import type {
    GitChangeSnapshot,
    DaemonIdentity,
    PresenceSnapshot,
    ModelCatalog,
    RemoteTerminalSummary,
    SessionStatus,
    SessionSharedMetadata,
    SessionTokenCount,
    SessionUnreadReason,
    SessionUnreadState,
} from "./protocol.js";

export interface GroupUsage {
    readonly totalTokens: number;
}

/**
 * How much of a project or worktree is waiting for the human.
 *
 * Unlike `usage`, this does not roll up: a project counts the chats sitting
 * directly in it and never those in its worktrees. A worktree is somewhere the
 * person goes, not a detail of the project, so folding its unread chats into
 * the project's badge would send them to the wrong place.
 */
export interface GroupUnread {
    /** Chats in this group alone that the person has not caught up on. */
    readonly count: number;
    /** Chats asking the person something, a subset of `count`. */
    readonly attentionCount: number;
    /** The strongest reason among them, absent when nothing is unread. */
    readonly reason?: SessionUnreadReason;
    /** When the longest-waiting of them started waiting. */
    readonly since?: number;
}

/** One application-shaped session row in the catalog. */
export interface GroupSession {
    readonly archived: boolean;
    readonly createdAt: number;
    readonly cwd: string;
    readonly draft?: string;
    readonly draftUpdatedAt?: number;
    readonly effort?: string;
    readonly id: string;
    readonly lastMessageAt?: number;
    readonly modelId: string;
    readonly orderKey: string;
    readonly permissionMode: string;
    readonly hostedCapabilities: readonly string[];
    readonly projectId: string;
    readonly providerId: string;
    readonly recap?: string;
    readonly serviceTier?: string;
    /** Owner-side sharing state for this chat. */
    readonly shared?: SessionSharedMetadata;
    readonly sessionTokenCount?: SessionTokenCount;
    readonly status: SessionStatus;
    readonly title?: string;
    /** Whether Rig keeps unread state for this chat at all. */
    readonly trackUnread: boolean;
    /** Present while this chat is waiting for the person to catch up. */
    readonly unread?: SessionUnreadState;
    readonly updatedAt: number;
    /** Present while the agent is inside a scheduled `wait` or `wait_until`. */
    readonly wait?: { readonly startedAt: number; readonly dueAt: number };
    readonly workspaceId?: string;
}

/**
 * A project with everything it contains.
 *
 * The daemon reports projects, workspaces, and sessions as three flat lists that
 * every client then has to join. Doing it once here is the point of the library.
 */
export interface ProjectGroup {
    readonly id: string;
    readonly kind: "regular" | "home";
    readonly name: string;
    readonly branch?: string;
    readonly orderKey: string;
    readonly path: string;
    readonly presence: "present" | "missing";
    readonly avatar?: {
        readonly height: number;
        readonly url: string;
        readonly width: number;
    };
    readonly usage: GroupUsage;
    /** Chats in the project itself that are waiting; worktrees keep their own. */
    readonly unread: GroupUnread;
    /** Live Git state, present once the daemon is watching this project. */
    readonly git?: GitChangeSnapshot;
    /** Interactive terminals currently open for this project directory. */
    readonly terminals: readonly RemoteTerminalSummary[];
    /** Worktrees of this project, ordered. */
    readonly workspaces: readonly WorkspaceGroup[];
    /** Sessions belonging to the project itself rather than to a worktree. */
    readonly sessions: readonly GroupSession[];
}

export interface WorkspaceGroup {
    readonly id: string;
    readonly name: string;
    readonly branch?: string;
    /** Human-readable failure reason while workspace initialization has failed. */
    readonly error?: string;
    readonly orderKey: string;
    readonly path: string;
    readonly presence: "present" | "missing";
    readonly projectId: string;
    readonly status: "initializing" | "ready" | "failed";
    readonly title?: string;
    readonly usage: GroupUsage;
    /** Chats in this worktree that are waiting. */
    readonly unread: GroupUnread;
    readonly git?: GitChangeSnapshot;
    /** Interactive terminals currently open for this workspace directory. */
    readonly terminals: readonly RemoteTerminalSummary[];
    readonly sessions: readonly GroupSession[];
}

/** Live facts about the group catalog as a whole. */
export interface GroupsState {
    readonly connection: ConnectionState;
    readonly catalog?: ModelCatalog;
    readonly identity?: DaemonIdentity;
    /** Where the user is right now, and every presence they can switch to. */
    readonly presence?: PresenceSnapshot;
    /** True because the opening frame carries the complete active session catalog. */
    readonly sessionsComplete: boolean;
}

/** What changed, for a consumer that reacts rather than re-rendering. */
export type GroupDelta =
    | { type: "projects_changed"; projects: readonly ProjectGroup[] }
    | { type: "groups_state_changed"; state: GroupsState }
    | { type: "project_added"; projectId: string }
    | { type: "workspace_added"; projectId: string; workspaceId: string }
    | { type: "session_added"; sessionId: string }
    | { type: "session_removed"; sessionId: string }
    | MutationRejectedDelta;
