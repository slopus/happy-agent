import type {
    GroupDelta,
    GroupSession,
    GroupsState,
    GroupUnread,
    ProjectGroup,
    WorkspaceGroup,
} from "./GroupElement.js";
import { sessionUnreadAfterEvent } from "./sessionUnread.js";
import type { ConnectionState } from "./ChatElement.js";
import type {
    GitChangeSnapshot,
    GlobalEvent,
    GlobalStreamHello,
    PresenceSnapshot,
    Project,
    ProjectWorkspace,
    RemoteTerminalGroupState,
    RemoteTerminalSummary,
    SessionActivity,
    SessionStatus,
    SessionEvent,
    SessionSummary,
    SessionTokenCount,
} from "./protocol.js";

/**
 * Keeps the group catalog current from the global event stream.
 *
 * The daemon reports projects, workspaces, and sessions separately; this joins
 * them into one ordered tree and keeps that tree referentially stable, so a
 * React consumer re-renders only the branch that actually changed.
 */
export class GroupStore {
    #projects = new Map<string, Project>();
    #workspaces = new Map<string, ProjectWorkspace>();
    #sessions = new Map<string, SessionSummary>();
    /** Newest event applied per session, so an out-of-order copy is ignored. */
    #sessionEventIds = new Map<string, string>();
    /**
     * Recent events per session, kept so a snapshot can be rebased onto them.
     *
     * A catalog is a snapshot taken at some position in the stream and delivered
     * asynchronously, so by the time it lands the client may already have seen
     * events after that position — or events for a session the snapshot is only
     * now introducing. Holding them means the snapshot becomes the base and
     * everything after it is replayed, instead of either side simply winning.
     */
    #recentSessionEvents = new Map<string, GlobalEvent[]>();
    #projectGit = new Map<string, GitChangeSnapshot>();
    #workspaceGit = new Map<string, GitChangeSnapshot>();
    #projectTerminals = new Map<string, GlobalStreamHello["terminalGroups"][number]["terminals"]>();
    #workspaceTerminals = new Map<
        string,
        GlobalStreamHello["terminalGroups"][number]["terminals"]
    >();
    /** Cached branch per project, reused whenever nothing under it changed. */
    #groups = new Map<string, ProjectGroup>();
    #workspaceGroups = new Map<string, WorkspaceGroup>();
    #workspaceGroupSources = new Map<string, ProjectWorkspace>();
    /** Irreversible local archive decisions that snapshots may never resurrect. */
    #archivedWorkspaceIds = new Set<string>();
    #groupSessions = new Map<string, { source: SessionSummary; value: GroupSession }>();
    #dirty = new Set<string>();
    #tree: readonly ProjectGroup[] = [];
    #treeStale = true;
    #state: GroupsState = { connection: "connecting", sessionsComplete: true };

    projects(): readonly ProjectGroup[] {
        if (this.#treeStale) this.#rebuild();
        return this.#tree;
    }

    remoteTerminals(): readonly RemoteTerminalGroupState[] {
        return [
            ...[...this.#projectTerminals].flatMap(([projectId, terminals]) => {
                const project = this.#projects.get(projectId);
                return project === undefined || project.archivedAt !== undefined
                    ? []
                    : [{ projectId, terminals }];
            }),
            ...[...this.#workspaceTerminals].flatMap(([workspaceId, terminals]) => {
                const workspace = this.#workspaces.get(workspaceId);
                const project =
                    workspace === undefined ? undefined : this.#projects.get(workspace.projectId);
                return workspace === undefined ||
                    this.#archivedWorkspaceIds.has(workspaceId) ||
                    isArchivedWorkspace(workspace) ||
                    project === undefined ||
                    project.archivedAt !== undefined
                    ? []
                    : [{ projectId: workspace.projectId, terminals, workspaceId }];
            }),
        ];
    }

    state(): GroupsState {
        return this.#state;
    }

    sessionSummary(sessionId: string): SessionSummary | undefined {
        return this.#sessions.get(sessionId);
    }

    groupVersion(
        target:
            | { kind: "project"; projectId: string }
            | { kind: "workspace"; projectId: string; workspaceId: string },
    ): number | undefined {
        return target.kind === "project"
            ? this.#projects.get(target.projectId)?.version
            : this.#workspaces.get(target.workspaceId)?.version;
    }

    /** Hides or restores one catalog row before the daemon round trip. */
    applyOptimisticSessionArchived(
        sessionId: string,
        archived: boolean,
    ): { deltas: readonly GroupDelta[]; undo: () => void } {
        const known = this.#sessions.get(sessionId);
        if (known === undefined || known.archived === archived) {
            return { deltas: [], undo: () => undefined };
        }
        const previousTree = this.projects();
        this.#sessions.set(sessionId, { ...known, archived });
        this.#markDirty(known.projectId);
        const projects = this.projects();
        return {
            deltas: [
                ...(projects === previousTree
                    ? []
                    : ([{ projects, type: "projects_changed" }] as const)),
                {
                    sessionId,
                    type: archived ? "session_removed" : "session_added",
                },
            ],
            undo: () => {
                this.#sessions.set(sessionId, known);
                this.#markDirty(known.projectId);
            },
        };
    }

    /** Predicts that a chat has been caught up on, clearing its unread state. */
    applyOptimisticSessionRead(sessionId: string): {
        deltas: readonly GroupDelta[];
        undo: () => void;
    } {
        const known = this.#sessions.get(sessionId);
        if (known === undefined || known.unread === undefined) {
            return { deltas: [], undo: () => undefined };
        }
        const previousTree = this.projects();
        const { unread: _, ...read } = known;
        this.#sessions.set(sessionId, read);
        this.#markDirty(known.projectId);
        const projects = this.projects();
        return {
            deltas: projects === previousTree ? [] : [{ projects, type: "projects_changed" }],
            undo: () => {
                this.#sessions.set(sessionId, known);
                this.#markDirty(known.projectId);
            },
        };
    }

    /** Applies a scalar session-row prediction while preserving its authoritative cursor. */
    applyOptimisticSessionPatch(
        sessionId: string,
        patch: Partial<SessionSummary>,
    ): { deltas: readonly GroupDelta[]; undo: () => void } {
        const known = this.#sessions.get(sessionId);
        if (known === undefined) return { deltas: [], undo: () => undefined };
        const updated = { ...known, ...patch };
        if (sameSessionSummary(known, updated)) {
            return { deltas: [], undo: () => undefined };
        }
        const previousTree = this.projects();
        this.#sessions.set(sessionId, updated);
        this.#markDirty(known.projectId);
        const projects = this.projects();
        return {
            deltas: projects === previousTree ? [] : [{ projects, type: "projects_changed" }],
            undo: () => {
                this.#sessions.set(sessionId, known);
                this.#markDirty(known.projectId);
            },
        };
    }

    /** Applies the owner share returned by a completed sharing mutation. */
    applySessionShare(sessionId: string, shared: SessionSummary["shared"]): readonly GroupDelta[] {
        const known = this.#sessions.get(sessionId);
        if (known === undefined || sameProtocolValue(known.shared, shared)) return [];
        const previousTree = this.projects();
        const { shared: _shared, ...withoutShared } = known;
        const updated = shared === undefined ? withoutShared : { ...known, shared };
        this.#sessions.set(sessionId, updated);
        this.#markDirty(known.projectId);
        const projects = this.projects();
        return projects === previousTree ? [] : [{ projects, type: "projects_changed" }];
    }

    /** Applies a project or workspace name prediction without advancing its version. */
    applyOptimisticGroupName(
        target:
            | { kind: "project"; projectId: string }
            | { kind: "workspace"; projectId: string; workspaceId: string },
        name: string,
    ): { deltas: readonly GroupDelta[]; undo: () => void } {
        const previousTree = this.projects();
        if (target.kind === "project") {
            const known = this.#projects.get(target.projectId);
            if (known === undefined || known.name === name) {
                return { deltas: [], undo: () => undefined };
            }
            this.#projects.set(target.projectId, { ...known, name, nameSource: "user" });
            this.#markDirty(target.projectId);
            const projects = this.projects();
            return {
                deltas: projects === previousTree ? [] : [{ projects, type: "projects_changed" }],
                undo: () => {
                    this.#projects.set(target.projectId, known);
                    this.#markDirty(target.projectId);
                },
            };
        }

        const known = this.#workspaces.get(target.workspaceId);
        if (known === undefined || known.name === name) {
            return { deltas: [], undo: () => undefined };
        }
        this.#workspaces.set(target.workspaceId, { ...known, name });
        this.#workspaceGroups.delete(target.workspaceId);
        this.#workspaceGroupSources.delete(target.workspaceId);
        this.#markDirty(target.projectId);
        const projects = this.projects();
        return {
            deltas: projects === previousTree ? [] : [{ projects, type: "projects_changed" }],
            undo: () => {
                this.#workspaces.set(target.workspaceId, known);
                this.#workspaceGroups.delete(target.workspaceId);
                this.#workspaceGroupSources.delete(target.workspaceId);
                this.#markDirty(target.projectId);
            },
        };
    }

    /** Adds the single local row that the response and stream echo later replace. */
    applyOptimisticWorkspaceCreate(workspace: ProjectWorkspace): {
        deltas: readonly GroupDelta[];
        undo: () => void;
    } {
        if (this.#workspaces.has(workspace.id)) return { deltas: [], undo: () => undefined };
        const previousTree = this.projects();
        this.#workspaces.set(workspace.id, workspace);
        this.#markDirty(workspace.projectId);
        const projects = this.projects();
        return {
            deltas: [
                ...(projects === previousTree
                    ? []
                    : ([{ projects, type: "projects_changed" }] as const)),
                {
                    projectId: workspace.projectId,
                    type: "workspace_added",
                    workspaceId: workspace.id,
                },
            ],
            undo: () => {
                if (this.#workspaces.get(workspace.id) !== workspace) return;
                this.#workspaces.delete(workspace.id);
                this.#workspaceGroups.delete(workspace.id);
                this.#workspaceGroupSources.delete(workspace.id);
                this.#markDirty(workspace.projectId);
            },
        };
    }

    /**
     * Commits a local workspace archive.
     *
     * There is intentionally no inverse. Archival is a user decision, while
     * daemon cleanup is only a best-effort consequence of that decision.
     */
    applyOptimisticWorkspaceArchived(
        projectId: string,
        workspaceId: string,
    ): { deltas: readonly GroupDelta[]; undo: () => void } {
        if (this.#archivedWorkspaceIds.has(workspaceId)) {
            return { deltas: [], undo: () => undefined };
        }
        const previousTree = this.projects();
        this.#archivedWorkspaceIds.add(workspaceId);
        this.#workspaceTerminals.delete(workspaceId);
        this.#workspaceGroups.delete(workspaceId);
        this.#workspaceGroupSources.delete(workspaceId);
        this.#markDirty(projectId);
        const projects = this.projects();
        return {
            deltas: projects === previousTree ? [] : [{ projects, type: "projects_changed" }],
            undo: () => undefined,
        };
    }

    setConnection(connection: ConnectionState): readonly GroupDelta[] {
        if (this.#state.connection === connection) return [];
        this.#state = { ...this.#state, connection };
        return [{ state: this.#state, type: "groups_state_changed" }];
    }

    /**
     * Takes a catalog snapshot as the new base for everything it names.
     *
     * `hello.cursor` is the stream position the snapshot was taken at, which is
     * what lets each session be rebased onto the events that outran it.
     */
    applyHello(hello: GlobalStreamHello): readonly GroupDelta[] {
        const previousTree = this.projects();
        const nextProjects = new Map<string, Project>();
        const nextWorkspaces = new Map<string, ProjectWorkspace>();
        const nextSessions = new Map<string, SessionSummary>();
        const changedProjectIds = new Set<string>();

        for (const project of hello.projects) {
            const known = this.#projects.get(project.id);
            if (known !== undefined && known.version >= project.version) {
                nextProjects.set(project.id, known);
            } else {
                nextProjects.set(project.id, project);
                changedProjectIds.add(project.id);
            }
        }
        for (const project of this.#projects.values()) {
            if (nextProjects.has(project.id)) continue;
            changedProjectIds.add(project.id);
            this.#groups.delete(project.id);
        }

        for (const workspace of hello.workspaces) {
            const known = this.#workspaces.get(workspace.id);
            if (known !== undefined && known.version >= workspace.version) {
                nextWorkspaces.set(workspace.id, known);
            } else {
                nextWorkspaces.set(workspace.id, workspace);
                changedProjectIds.add(workspace.projectId);
                if (known !== undefined) changedProjectIds.add(known.projectId);
            }
        }
        for (const workspace of this.#workspaces.values()) {
            if (nextWorkspaces.has(workspace.id)) continue;
            changedProjectIds.add(workspace.projectId);
            this.#workspaceGroups.delete(workspace.id);
            this.#workspaceGroupSources.delete(workspace.id);
        }

        for (const session of hello.sessions) {
            // Same rule as the stream: no position, no place in the list.
            if (session.orderKey === undefined) continue;
            const known = this.#sessions.get(session.id);
            // The snapshot is the base, and anything that outran it is replayed on
            // top. A catalog arrives asynchronously, so by now the client may hold
            // events the snapshot predates — including events for a session this
            // snapshot is only now introducing.
            const rebased = this.#rebaseSession(session, hello.cursor);
            if (known !== undefined && sameSessionSummary(known, rebased)) {
                nextSessions.set(session.id, known);
            } else {
                nextSessions.set(session.id, rebased);
                changedProjectIds.add(rebased.projectId);
                if (known !== undefined) changedProjectIds.add(known.projectId);
            }
        }
        for (const session of this.#sessions.values()) {
            if (nextSessions.has(session.id)) continue;
            changedProjectIds.add(session.projectId);
            this.#sessionEventIds.delete(session.id);
            this.#groupSessions.delete(session.id);
        }

        const nextProjectTerminals = new Map<
            string,
            GlobalStreamHello["terminalGroups"][number]["terminals"]
        >();
        const nextWorkspaceTerminals = new Map<
            string,
            GlobalStreamHello["terminalGroups"][number]["terminals"]
        >();
        for (const group of hello.terminalGroups) {
            const project = nextProjects.get(group.projectId);
            const workspace =
                group.workspaceId === undefined ? undefined : nextWorkspaces.get(group.workspaceId);
            if (
                project === undefined ||
                project.archivedAt !== undefined ||
                (group.workspaceId !== undefined &&
                    (workspace === undefined || isArchivedWorkspace(workspace)))
            ) {
                continue;
            }
            const known =
                group.workspaceId === undefined
                    ? this.#projectTerminals.get(group.projectId)
                    : this.#workspaceTerminals.get(group.workspaceId);
            const terminals =
                known !== undefined && sameProtocolValue(known, group.terminals)
                    ? known
                    : group.terminals;
            if (terminals !== known) changedProjectIds.add(group.projectId);
            if (group.workspaceId === undefined) {
                nextProjectTerminals.set(group.projectId, terminals);
            } else {
                nextWorkspaceTerminals.set(group.workspaceId, terminals);
            }
        }
        for (const projectId of this.#projectTerminals.keys()) {
            if (!nextProjectTerminals.has(projectId)) changedProjectIds.add(projectId);
        }
        for (const [workspaceId, terminals] of this.#workspaceTerminals) {
            if (nextWorkspaceTerminals.has(workspaceId) || terminals.length === 0) continue;
            const workspace = this.#workspaces.get(workspaceId);
            if (workspace !== undefined) changedProjectIds.add(workspace.projectId);
        }

        this.#projects = nextProjects;
        this.#workspaces = nextWorkspaces;
        this.#sessions = nextSessions;
        this.#projectTerminals = nextProjectTerminals;
        this.#workspaceTerminals = nextWorkspaceTerminals;
        for (const projectId of changedProjectIds) this.#markDirty(projectId);
        // Git snapshots survive: they are live-only, so the stream replays them
        // after this frame and dropping them here would blank a branch a client
        // is already showing.

        const deltas: GroupDelta[] = [];
        const catalog = hello.catalog;
        const identity = hello.identity;
        const presence = hello.presence;
        if (
            this.#state.sessionsComplete !== hello.sessionsComplete ||
            !sameProtocolValue(this.#state.catalog, catalog) ||
            !sameProtocolValue(this.#state.presence, presence) ||
            !sameProtocolValue(this.#state.identity, identity)
        ) {
            this.#state = {
                ...this.#state,
                sessionsComplete: hello.sessionsComplete,
                catalog,
                identity,
                presence,
            };
            deltas.push({ state: this.#state, type: "groups_state_changed" });
        }
        const projects = this.projects();
        if (projects !== previousTree) deltas.push({ projects, type: "projects_changed" });
        return deltas;
    }

    apply(event: GlobalEvent): readonly GroupDelta[] {
        const deltas: GroupDelta[] = [];
        switch (event.type) {
            case "presence_changed": {
                const { presence } = event.data as { presence: PresenceSnapshot };
                if (sameProtocolValue(this.#state.presence, presence)) break;
                this.#state = { ...this.#state, presence };
                deltas.push({ state: this.#state, type: "groups_state_changed" });
                break;
            }
            case "project_created":
            case "project_updated": {
                const { project } = event.data as { project: Project };
                const known = this.#projects.get(project.id);
                // Streams and snapshots race, so an older copy of an entity must
                // never overwrite a newer one already applied.
                if (known !== undefined && known.version >= project.version) return [];
                this.#projects.set(project.id, project);
                if (project.archivedAt !== undefined) {
                    this.#projectTerminals.delete(project.id);
                    for (const workspace of this.#workspaces.values()) {
                        if (workspace.projectId === project.id) {
                            this.#workspaceTerminals.delete(workspace.id);
                        }
                    }
                }
                this.#markDirty(project.id);
                if (known === undefined)
                    deltas.push({ projectId: project.id, type: "project_added" });
                break;
            }
            case "workspace_created":
            case "workspace_updated": {
                const { workspace } = event.data as { workspace: ProjectWorkspace };
                const known = this.#workspaces.get(workspace.id);
                if (known !== undefined && known.version >= workspace.version) return [];
                this.#workspaces.set(workspace.id, workspace);
                if (isArchivedWorkspace(workspace)) {
                    this.#workspaceTerminals.delete(workspace.id);
                }
                this.#markDirty(workspace.projectId);
                if (known === undefined) {
                    deltas.push({
                        projectId: workspace.projectId,
                        type: "workspace_added",
                        workspaceId: workspace.id,
                    });
                }
                break;
            }
            case "project_git_changed": {
                const scope = event as { projectId: string; data: { git: GitChangeSnapshot } };
                if (!this.#acceptGit(this.#projectGit, scope.projectId, scope.data.git)) return [];
                this.#markDirty(scope.projectId);
                break;
            }
            case "workspace_git_changed": {
                const scope = event as {
                    projectId: string;
                    workspaceId?: string;
                    data: { git: GitChangeSnapshot };
                };
                const workspaceId = scope.workspaceId;
                if (workspaceId === undefined) return [];
                if (!this.#acceptGit(this.#workspaceGit, workspaceId, scope.data.git)) return [];
                this.#workspaceGroups.delete(workspaceId);
                this.#markDirty(scope.projectId);
                break;
            }
            case "remote_terminals_changed": {
                const scope = event as {
                    projectId: string;
                    workspaceId?: string;
                    data: {
                        terminals: GlobalStreamHello["terminalGroups"][number]["terminals"];
                    };
                };
                const into =
                    scope.workspaceId === undefined
                        ? this.#projectTerminals
                        : this.#workspaceTerminals;
                const key = scope.workspaceId ?? scope.projectId;
                const project = this.#projects.get(scope.projectId);
                const workspace =
                    scope.workspaceId === undefined
                        ? undefined
                        : this.#workspaces.get(scope.workspaceId);
                if (
                    project === undefined ||
                    project.archivedAt !== undefined ||
                    (scope.workspaceId !== undefined &&
                        (workspace === undefined || isArchivedWorkspace(workspace)))
                ) {
                    into.delete(key);
                    return [];
                }
                const known = into.get(key);
                if (known !== undefined && sameProtocolValue(known, scope.data.terminals)) {
                    return [];
                }
                into.set(key, scope.data.terminals);
                if (scope.workspaceId !== undefined) {
                    this.#workspaceGroups.delete(scope.workspaceId);
                }
                this.#markDirty(scope.projectId);
                break;
            }
            default: {
                const applied = this.#applySessionEvent(event, deltas);
                if (!applied) return [];
                break;
            }
        }
        if (deltas.length === 0 && !this.#treeStale) return [];
        deltas.unshift({ projects: this.projects(), type: "projects_changed" });
        return deltas;
    }

    /**
     * Tracks the session catalog from the events that carry a whole session.
     *
     * Live events describe a session with `ProtocolSession` while the opening
     * frame uses `SessionSummary`. The two overlap but are not the same shape,
     * so each update is merged onto what is already known rather than replacing
     * it, and a field only the summary carries survives a live update.
     */
    #applySessionEvent(event: GlobalEvent, deltas: GroupDelta[]): boolean {
        const sessionId = (event as { sessionId?: string }).sessionId;
        if (sessionId === undefined) return false;
        // Events are ordered UUIDv7, so this is what decides which of two views
        // of the same session is newer. Sessions carry no version of their own.
        const seen = this.#sessionEventIds.get(sessionId);
        if (seen !== undefined && seen >= event.id) return false;
        // Held before it is applied, so an event for a session the client has not
        // loaded yet survives to be replayed once a snapshot introduces it. Such
        // an event used to be dropped, which lost the change outright.
        this.#rememberSessionEvent(sessionId, event);

        if (event.type === "session_current") {
            const incoming = (event.data as { session: SessionSummary }).session;
            const known = this.#sessions.get(sessionId);
            if (incoming.lastEventId !== undefined) {
                this.#sessionEventIds.set(sessionId, incoming.lastEventId);
            }
            this.#sessions.set(
                sessionId,
                known === undefined
                    ? incoming
                    : withAuthoritativeUnread({ ...known, ...incoming }, incoming),
            );
            this.#markDirty(incoming.projectId);
            if (known !== undefined && known.projectId !== incoming.projectId) {
                this.#markDirty(known.projectId);
            }
            return true;
        }

        if (event.type === "session_archived") {
            const { archived } = event.data as { archived: boolean };
            this.#sessionEventIds.set(sessionId, event.id);
            const known = this.#sessions.get(sessionId);
            if (known === undefined) return false;
            this.#sessions.set(sessionId, { ...known, archived, lastEventId: event.id });
            this.#markDirty(known.projectId);
            deltas.push({
                sessionId,
                type: archived ? "session_removed" : "session_added",
            });
            return true;
        }

        // Nothing announces that a chat started waiting for the person: the
        // transition rides on the events that cause it, so it is derived from
        // the same rule the daemon applies to its own copy.
        const waiting = this.#sessions.get(sessionId);
        if (waiting?.trackUnread === true) {
            const unread = sessionUnreadAfterEvent(waiting.unread, event as SessionEvent);
            if (unread !== undefined && unread !== waiting.unread) {
                this.#sessionEventIds.set(sessionId, event.id);
                this.#sessions.set(sessionId, { ...waiting, lastEventId: event.id, unread });
                this.#markDirty(waiting.projectId);
                return true;
            }
        }

        // A sidebar shows a session's name and whether it is working, and both
        // change through events that carry only the change rather than a whole
        // session. Applying them here is what keeps a list live without asking
        // the daemon to restate the session every time something moves.
        const patch = sessionPatch(event, this.#sessions.get(sessionId));
        if (patch !== undefined) {
            const known = this.#sessions.get(sessionId);
            if (known === undefined) return false;
            this.#sessionEventIds.set(sessionId, event.id);
            const updated = { ...known, ...patch.set, lastEventId: event.id };
            for (const key of patch.clear ?? []) delete updated[key];
            this.#sessions.set(sessionId, updated);
            this.#markDirty(known.projectId);
            return true;
        }

        if (event.type !== "session_created" && event.type !== "session_updated") return false;
        const incoming = (event.data as { session?: Partial<SessionSummary> }).session;
        if (incoming === undefined || typeof incoming.id !== "string") return false;
        this.#sessionEventIds.set(sessionId, event.id);

        const known = this.#sessions.get(incoming.id);
        const merged = withAuthoritativeUnread(
            { ...known, ...incoming, lastEventId: event.id } as SessionSummary,
            incoming,
        );
        // A session with no position is not in this list. A subagent is the case
        // that matters: it syncs and can be opened by id, but it belongs to the
        // session that started it, so the stream must not put it in the sidebar.
        if (merged.projectId === undefined || merged.orderKey === undefined) return false;
        this.#sessions.set(merged.id, merged);
        this.#markDirty(merged.projectId);
        if (known !== undefined && known.projectId !== merged.projectId) {
            this.#markDirty(known.projectId);
        }
        if (known === undefined) deltas.push({ sessionId: merged.id, type: "session_added" });
        return true;
    }

    /**
     * Holds one event against its session, newest last.
     *
     * The queue is bounded on both axes: a long-lived client would otherwise
     * accumulate every event it ever saw, for every session it ever heard of.
     * Dropping the oldest is safe because a snapshot older than everything still
     * held is a snapshot the client has already moved far past.
     */
    #rememberSessionEvent(sessionId: string, event: GlobalEvent): void {
        const held = this.#recentSessionEvents.get(sessionId);
        if (held === undefined) {
            if (this.#recentSessionEvents.size >= PENDING_SESSION_LIMIT) {
                const oldest = this.#recentSessionEvents.keys().next();
                if (!oldest.done) this.#recentSessionEvents.delete(oldest.value);
            }
            this.#recentSessionEvents.set(sessionId, [event]);
            return;
        }
        held.push(event);
        while (held.length > PENDING_EVENTS_PER_SESSION) held.shift();
    }

    /**
     * Replays everything that happened after a snapshot onto that snapshot.
     *
     * `observedAt` is the stream position that was current when the snapshot was
     * taken, so the snapshot already reflects every event up to it. Events at or
     * before that position are dropped; everything after is applied in order.
     * That is what makes the decision unambiguous rather than a comparison of
     * which copy looks newer — events enter the stream strictly in sequence, so
     * one position separates what a snapshot contains from what it does not.
     *
     * The result carries both the fields only a snapshot has and the changes only
     * the stream has.
     */
    #rebaseSession(snapshot: SessionSummary, observedAt: string): SessionSummary {
        const held = this.#recentSessionEvents.get(snapshot.id);
        const later = (held ?? []).filter((event) => event.id > observedAt);
        if (later.length === 0) {
            this.#recentSessionEvents.delete(snapshot.id);
            // Nothing outran the snapshot, so its position is what the client has
            // seen of this session.
            this.#sessionEventIds.set(snapshot.id, snapshot.lastEventId ?? observedAt);
            return snapshot;
        }
        this.#recentSessionEvents.set(snapshot.id, later);

        let rebased = snapshot;
        for (const event of later) {
            const updated = sessionSummaryAfterEvent(rebased, event);
            if (updated !== undefined) rebased = updated;
        }
        this.#sessionEventIds.set(snapshot.id, later[later.length - 1]!.id);
        return rebased;
    }

    /**
     * Accepts a Git snapshot unless it is older than the one already held.
     *
     * Versions are monotonic within a daemon run, so a restart is the one case
     * where a lower version is newer and must be taken.
     */
    #acceptGit(into: Map<string, GitChangeSnapshot>, key: string, git: GitChangeSnapshot): boolean {
        const known = into.get(key);
        if (
            known !== undefined &&
            known.generation === git.generation &&
            known.version >= git.version
        ) {
            return false;
        }
        into.set(key, applicationGit(git));
        return true;
    }

    #markDirty(projectId: string): void {
        this.#dirty.add(projectId);
        this.#groups.delete(projectId);
        this.#treeStale = true;
    }

    #rebuild(): void {
        this.#treeStale = false;
        const sessionsByProject = new Map<string, GroupSession[]>();
        const sessionsByWorkspace = new Map<string, GroupSession[]>();
        for (const session of this.#sessions.values()) {
            if (session.archived) continue;
            const projected = this.#groupSession(session);
            const into =
                session.workspaceId === undefined
                    ? mapList(sessionsByProject, session.projectId)
                    : mapList(sessionsByWorkspace, session.workspaceId);
            into.push(projected);
        }
        const workspacesByProject = new Map<string, ProjectWorkspace[]>();
        for (const workspace of this.#workspaces.values()) {
            if (this.#archivedWorkspaceIds.has(workspace.id) || isArchivedWorkspace(workspace)) {
                continue;
            }
            mapList(workspacesByProject, workspace.projectId).push(workspace);
        }

        const next: ProjectGroup[] = [];
        for (const project of [...this.#projects.values()].sort(byOrderKey)) {
            // An archived project is out of the catalog a client renders, along
            // with everything inside it.
            if (project.archivedAt !== undefined) continue;
            const cached = this.#groups.get(project.id);
            if (cached !== undefined) {
                next.push(cached);
                continue;
            }
            const workspaces = (workspacesByProject.get(project.id) ?? [])
                .sort(byOrderKey)
                .map((workspace) => this.#workspaceGroup(workspace, sessionsByWorkspace));
            const branch = this.#projectGit.get(project.id)?.branch ?? project.git?.branch;
            const group: ProjectGroup = {
                ...(project.avatar === undefined
                    ? {}
                    : {
                          avatar: {
                              height: project.avatar.height,
                              url: project.avatar.url,
                              width: project.avatar.width,
                          },
                      }),
                id: project.id,
                kind: project.kind,
                name: project.name,
                ...(branch === undefined ? {} : { branch }),
                orderKey: project.orderKey,
                path: project.path,
                presence: project.presence,
                sessions: (sessionsByProject.get(project.id) ?? []).sort(byOrderKey),
                terminals: this.#projectTerminals.get(project.id) ?? EMPTY_TERMINALS,
                unread: unreadOf(sessionsByProject.get(project.id) ?? []),
                usage: usageOf([
                    ...(sessionsByProject.get(project.id) ?? []),
                    ...workspaces.flatMap((workspace) => workspace.sessions),
                ]),
                workspaces,
                ...(this.#projectGit.has(project.id)
                    ? { git: this.#projectGit.get(project.id) as GitChangeSnapshot }
                    : {}),
            };
            this.#groups.set(project.id, group);
            next.push(group);
        }
        this.#dirty.clear();
        this.#tree = next;
    }

    #workspaceGroup(
        workspace: ProjectWorkspace,
        sessionsByWorkspace: Map<string, GroupSession[]>,
    ): WorkspaceGroup {
        const cached = this.#workspaceGroups.get(workspace.id);
        const sessions = (sessionsByWorkspace.get(workspace.id) ?? []).sort(byOrderKey);
        const terminals = this.#workspaceTerminals.get(workspace.id) ?? EMPTY_TERMINALS;
        const branch = this.#workspaceGit.get(workspace.id)?.branch ?? workspace.git?.branch;
        if (
            cached !== undefined &&
            this.#workspaceGroupSources.get(workspace.id) === workspace &&
            sameSessions(cached.sessions, sessions) &&
            cached.terminals === terminals
        ) {
            return cached;
        }
        const group: WorkspaceGroup = {
            id: workspace.id,
            name: workspace.name,
            ...(branch === undefined ? {} : { branch }),
            ...(workspace.error === undefined ? {} : { error: workspace.error }),
            orderKey: workspace.orderKey,
            path: workspace.path,
            presence: workspace.presence,
            projectId: workspace.projectId,
            sessions,
            terminals,
            status: workspace.status as WorkspaceGroup["status"],
            ...(workspace.title === undefined ? {} : { title: workspace.title }),
            unread: unreadOf(sessions),
            usage: usageOf(sessions),
            ...(this.#workspaceGit.has(workspace.id)
                ? { git: this.#workspaceGit.get(workspace.id) as GitChangeSnapshot }
                : {}),
        };
        this.#workspaceGroups.set(workspace.id, group);
        this.#workspaceGroupSources.set(workspace.id, workspace);
        return group;
    }

    #groupSession(session: SessionSummary): GroupSession {
        const cached = this.#groupSessions.get(session.id);
        if (cached?.source === session) return cached.value;
        const value: GroupSession = {
            archived: session.archived,
            createdAt: session.createdAt,
            cwd: session.cwd,
            id: session.id,
            modelId: session.modelId,
            orderKey: session.orderKey ?? "",
            permissionMode: session.permissionMode,
            hostedCapabilities: session.hostedCapabilities ?? [],
            projectId: session.projectId,
            providerId: session.providerId,
            status: session.status,
            trackUnread: session.trackUnread === true,
            updatedAt: session.updatedAt,
            ...(session.unread === undefined ? {} : { unread: session.unread }),
            ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
            ...(session.draft === undefined ? {} : { draft: session.draft }),
            ...(session.draftUpdatedAt === undefined
                ? {}
                : { draftUpdatedAt: session.draftUpdatedAt }),
            ...(session.effort === undefined ? {} : { effort: session.effort }),
            ...(session.lastMessageAt === undefined
                ? {}
                : { lastMessageAt: session.lastMessageAt }),
            ...(session.recap === undefined ? {} : { recap: session.recap }),
            ...(session.serviceTier === undefined ? {} : { serviceTier: session.serviceTier }),
            ...(session.shared === undefined ? {} : { shared: session.shared }),
            ...(session.sessionTokenCount === undefined
                ? {}
                : { sessionTokenCount: session.sessionTokenCount }),
            ...(session.title === undefined ? {} : { title: session.title }),
            ...(session.wait === undefined
                ? {}
                : { wait: { dueAt: session.wait.dueAt, startedAt: session.wait.startedAt } }),
        };
        this.#groupSessions.set(session.id, { source: session, value });
        return value;
    }
}

function mapList<T>(into: Map<string, T[]>, key: string): T[] {
    const existing = into.get(key);
    if (existing !== undefined) return existing;
    const created: T[] = [];
    into.set(key, created);
    return created;
}

/**
 * Orders siblings by their position, and by identity when two share one.
 *
 * Without the second comparison, equal keys leave the order to whatever the
 * sort happened to do, and the list reshuffles under the reader.
 */
function byOrderKey(
    left: { id: string; orderKey: string },
    right: { id: string; orderKey: string },
): number {
    if (left.orderKey !== right.orderKey) return left.orderKey < right.orderKey ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Whether two session lists hold the very same objects in the same order.
 *
 * Comparing ids alone would reuse a cached workspace after one of its sessions
 * was renamed or changed status, because the list looks unchanged by id while
 * the session it points at is a different object.
 */
function sameSessions(left: readonly GroupSession[], right: readonly GroupSession[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((item, index) => item === right[index]);
}

/**
 * Sums the unread chats of one group, and only its own.
 *
 * A project is not given its worktrees' unread chats: the person opens the
 * worktree to answer them, so counting them on the project would point at the
 * wrong place. That is why this is called once per group rather than rolled up
 * the way `usageOf` is.
 */
function unreadOf(sessions: readonly GroupSession[]): GroupUnread {
    let count = 0;
    let attentionCount = 0;
    let friendMessageCount = 0;
    let since: number | undefined;
    for (const session of sessions) {
        if (session.archived || session.unread === undefined) continue;
        count += 1;
        if (session.unread.reason === "attention_needed") attentionCount += 1;
        if (session.unread.reason === "friend_message") friendMessageCount += 1;
        if (since === undefined || session.unread.since < since) since = session.unread.since;
    }
    if (count === 0) return EMPTY_UNREAD;
    return {
        attentionCount,
        count,
        reason:
            attentionCount > 0
                ? "attention_needed"
                : friendMessageCount > 0
                  ? "friend_message"
                  : "turn_finished",
        ...(since === undefined ? {} : { since }),
    };
}

/** Shared so a group with nothing waiting keeps the same object across rebuilds. */
const EMPTY_UNREAD: GroupUnread = { attentionCount: 0, count: 0 };
const EMPTY_TERMINALS: readonly RemoteTerminalSummary[] = [];

function usageOf(sessions: readonly GroupSession[]): { totalTokens: number } {
    return {
        totalTokens: sessions.reduce(
            (total, session) => total + (session.sessionTokenCount?.totalTokens ?? 0),
            0,
        ),
    };
}

function sameSessionSummary(left: SessionSummary, right: SessionSummary): boolean {
    if (left === right) return true;
    const leftRecord = left as unknown as Record<string, unknown>;
    const rightRecord = right as unknown as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return (
        leftKeys.length === rightKeys.length &&
        leftKeys.every(
            (key) =>
                Object.hasOwn(rightRecord, key) &&
                sameProtocolValue(leftRecord[key], rightRecord[key]),
        )
    );
}

/** Equality for the bounded JSON values carried by one protocol entity. */
function sameProtocolValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return (
            Array.isArray(left) &&
            Array.isArray(right) &&
            left.length === right.length &&
            left.every((item, index) => sameProtocolValue(item, right[index]))
        );
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return (
        leftKeys.length === rightKeys.length &&
        leftKeys.every(
            (key) =>
                Object.hasOwn(rightRecord, key) &&
                sameProtocolValue(leftRecord[key], rightRecord[key]),
        )
    );
}

function isArchivedWorkspace(workspace: ProjectWorkspace): boolean {
    return (
        workspace.archivedAt !== undefined ||
        workspace.status === "archiving" ||
        workspace.status === "archived"
    );
}

function applicationGit(git: GitChangeSnapshot): GitChangeSnapshot {
    const { facts, ...snapshot } = git;
    const branch = facts?.branch ?? snapshot.branch;
    return {
        ...snapshot,
        ...(branch === undefined ? {} : { branch }),
        revision: `${git.generation}:${String(git.version)}:${String(git.scannedAt)}`,
    };
}

/**
 * The catalog-visible change an event describes, or `undefined` for one that
 * says nothing a session list renders.
 *
 * A run's status is derived rather than read: the events that start and end a
 * run say what happened, and a list only needs to know whether the session is
 * busy.
 */
/**
 * The session as it stands after one event, or nothing if the event says nothing
 * about it.
 *
 * This is the replay half of snapshot-plus-events. It is deliberately pure and
 * deliberately shares `sessionPatch` with the live path, so a field the stream
 * knows how to update cannot quietly stop being updated on a rebase.
 */
/**
 * Bounds on the per-session event queues.
 *
 * A catalog load settles in well under a second, so these only have to cover the
 * events that can outrun one request. They exist to stop a long-lived client
 * from accumulating every event it ever saw, for every session it ever heard of.
 */
const PENDING_SESSION_LIMIT = 512;
const PENDING_EVENTS_PER_SESSION = 64;

function sessionSummaryAfterEvent(
    session: SessionSummary,
    event: GlobalEvent,
): SessionSummary | undefined {
    if (event.type === "session_current") {
        const incoming = (event.data as { session: SessionSummary }).session;
        return withAuthoritativeUnread({ ...session, ...incoming }, incoming);
    }
    if (event.type === "session_archived") {
        const { archived } = event.data as { archived: boolean };
        return { ...session, archived, lastEventId: event.id };
    }
    if (event.type === "session_created" || event.type === "session_updated") {
        const incoming = (event.data as { session?: Partial<SessionSummary> }).session;
        if (incoming === undefined) return undefined;
        return withAuthoritativeUnread(
            { ...session, ...incoming, lastEventId: event.id },
            incoming,
        );
    }
    // The daemon publishes no event for a chat becoming unread; the transition
    // rides on the events that cause it, so it is derived from the same rule.
    const unread =
        session.trackUnread === true
            ? sessionUnreadAfterEvent(session.unread, event as SessionEvent)
            : session.unread;
    if (unread !== undefined && unread !== session.unread) {
        return { ...session, lastEventId: event.id, unread };
    }
    const patch = sessionPatch(event, session);
    if (patch === undefined) return undefined;
    const updated = { ...session, ...patch.set, lastEventId: event.id };
    for (const key of patch.clear ?? []) delete updated[key];
    return updated;
}

/**
 * A full summary decides unread by itself, including by leaving it out.
 *
 * The daemon omits `unread` from a chat the person has caught up on, so merging
 * a fresh summary over a stale one would otherwise keep a badge that was just
 * cleared.
 */
function withAuthoritativeUnread(
    merged: SessionSummary,
    incoming: Partial<SessionSummary>,
): SessionSummary {
    if (Object.hasOwn(incoming, "unread")) return merged;
    const { unread: _, ...read } = merged;
    return read;
}

function sessionPatch(
    event: GlobalEvent,
    session: SessionSummary | undefined,
): SessionPatch | undefined {
    switch (event.type) {
        case "session_activity_changed": {
            // Activity changes on every step of a working agent, but the only
            // part of it a catalog renders is the scheduled wait. Anything that
            // leaves the wait as it stands must say nothing, or every thinking
            // and tool transition would rebuild the tree.
            const wait = (event.data as { activity: SessionActivity }).activity.wait;
            if (wait === undefined) {
                return session?.wait === undefined ? undefined : { clear: ["wait"] };
            }
            const known = session?.wait;
            if (
                known !== undefined &&
                known.dueAt === wait.dueAt &&
                known.startedAt === wait.startedAt &&
                known.toolCallId === wait.toolCallId
            ) {
                return undefined;
            }
            return { set: { wait } };
        }
        case "session_title_changed": {
            const { recap, status, title } = event.data as {
                recap?: string;
                status: string;
                title?: string;
            };
            // Generating and error events omit the title and recap even though
            // the daemon retains them. Once metadata is idle or ready, omission
            // is authoritative and clears the corresponding value.
            const settled = status === "idle" || status === "ready";
            const set: Partial<SessionSummary> = { titleStatus: status };
            const clear: (keyof SessionSummary)[] = [];
            if (title !== undefined) set.title = title;
            else if (settled) clear.push("title");
            if (recap !== undefined) set.recap = recap;
            else if (settled) clear.push("recap");
            return { clear, set };
        }
        case "session_configuration_changed": {
            const { effort, modelId, serviceTier } = event.data as {
                effort?: string;
                modelId: string;
                serviceTier: string | null;
            };
            return {
                clear: [
                    ...(effort === undefined ? (["effort"] as const) : []),
                    ...(serviceTier === null ? (["serviceTier"] as const) : []),
                ],
                set: {
                    modelId,
                    ...(effort === undefined ? {} : { effort }),
                    ...(serviceTier === null ? {} : { serviceTier }),
                },
            };
        }
        case "session_draft_changed": {
            const { draft, updatedAt } = event.data as { draft?: string; updatedAt: number };
            return {
                ...(draft === undefined ? { clear: ["draft"] } : {}),
                set: {
                    draftUpdatedAt: updatedAt,
                    ...(draft === undefined ? {} : { draft }),
                },
            };
        }
        case "session_context_changed":
            return {
                set: {
                    sessionTokenCount: (event.data as { sessionTokenCount: SessionTokenCount })
                        .sessionTokenCount,
                },
            };
        case "permission_mode_changed": {
            const { permissionMode } = event.data as { permissionMode: string };
            return { set: { permissionMode } };
        }
        case "session_status_changed":
            // The daemon decides the lifecycle status and announces it. Deriving
            // one from run boundaries instead would disagree with the session
            // itself, which settles at "completed" rather than "idle", and would
            // say nothing about a suspended or interrupted session.
            return { set: { status: (event.data as { status: SessionStatus }).status } };
        default:
            return undefined;
    }
}

interface SessionPatch {
    set?: Partial<SessionSummary>;
    clear?: readonly (keyof SessionSummary)[];
}
