import type { Message, SystemMessage } from "../../agent/types.js";
import type {
    EventId,
    SessionTranscriptGroup,
    SessionTranscriptNotice,
    SessionTranscriptTurn,
    SessionTranscriptWindow,
} from "../index.js";
import type { SessionEvent } from "../index.js";

/** When a run began, ended, and how, gathered from the durable event log. */
export interface TranscriptRunFacts {
    startedAt: number;
    kind?: "compaction";
    endedAt?: number;
    outcome?: "success" | "error" | "stopped";
    errorMessage?: string;
    groups?: readonly SessionTranscriptGroup[];
    /** The group each boundary message closed, keyed by message ID. */
    boundaryGroupIds?: Readonly<Record<string, string>>;
    /** The inference group each durable error occurred in, keyed by message ID. */
    messageGroupIds?: Readonly<Record<string, string>>;
}

export interface TranscriptEntry {
    createdAt?: number;
    eventId?: EventId;
    message: Message;
    runId?: string;
    steeredAt?: number;
}

export function isTranscriptNoticeEntry<TEntry extends { message: Message; runId?: string }>(
    entry: TEntry,
): entry is TEntry & { message: SystemMessage; runId?: undefined } {
    return (
        entry.runId === undefined &&
        entry.message.role === "system" &&
        entry.message.context === "excluded"
    );
}

export function transcriptRunFacts(
    events: readonly SessionEvent[],
): ReadonlyMap<string, TranscriptRunFacts> {
    const facts = new Map<string, TranscriptRunFacts>();
    const closeGroup = (
        runId: string,
        endedAt: number,
        reason: NonNullable<SessionTranscriptGroup["reason"]>,
        outcome: NonNullable<SessionTranscriptGroup["outcome"]>,
        errorMessage?: string,
    ) => {
        const known = facts.get(runId);
        if (known === undefined) return;
        const openIndex = known.groups?.findLastIndex((group) => group.endedAt === undefined) ?? -1;
        if (openIndex < 0) return;
        facts.set(runId, {
            ...known,
            groups: (known.groups ?? []).map((group, index) =>
                index === openIndex
                    ? {
                          ...group,
                          endedAt,
                          outcome,
                          reason,
                          ...(errorMessage === undefined ? {} : { errorMessage }),
                      }
                    : group,
            ),
        });
    };
    /** Ties the messages that made a boundary to the group they closed. */
    const rememberBoundary = (
        runId: string,
        closedGroupId: string | undefined,
        messageIds: readonly string[],
    ) => {
        const known = facts.get(runId);
        if (closedGroupId === undefined || known === undefined) return;
        facts.set(runId, {
            ...known,
            boundaryGroupIds: {
                ...known.boundaryGroupIds,
                ...Object.fromEntries(messageIds.map((messageId) => [messageId, closedGroupId])),
            },
        });
    };
    /** The group open for a run, which is what an error or compaction sits in. */
    const openGroupId = (runId: string): string | undefined =>
        facts.get(runId)?.groups?.findLast((group) => group.endedAt === undefined)?.id;
    for (const event of events) {
        if (event.type === "message_submitted" && event.data.delivery === "run") {
            if (!facts.has(event.data.runId)) {
                facts.set(event.data.runId, { startedAt: event.createdAt });
            }
        } else if (event.type === "run_started") {
            const known = facts.get(event.data.runId);
            facts.set(event.data.runId, {
                ...(known ?? { startedAt: event.createdAt }),
                ...(event.data.kind === undefined ? {} : { kind: event.data.kind }),
            });
        } else if (
            event.type === "agent_event" &&
            event.data.event.type === "inference_iteration_start"
        ) {
            const known = facts.get(event.data.runId) ?? { startedAt: event.createdAt };
            // A run reaches the model once per tool-call iteration, and all of
            // that is one thing the user asked for. The group already open keeps
            // going; only steering, an abort, or the end of the run closes it.
            if ((known.groups ?? []).some((group) => group.endedAt === undefined)) {
                facts.set(event.data.runId, known);
            } else {
                facts.set(event.data.runId, {
                    ...known,
                    groups: [
                        ...(known.groups ?? []),
                        { id: event.data.event.messageId, startedAt: event.createdAt },
                    ],
                });
            }
        } else if (event.type === "steering_applied") {
            // Which group a steering message heads cannot be read from the
            // clock, so the group it closed is recorded against it.
            const closedGroupId = openGroupId(event.data.runId);
            closeGroup(event.data.runId, event.createdAt, "steering", "success");
            rememberBoundary(event.data.runId, closedGroupId, event.data.messageIds);
        } else if (
            event.type === "agent_event" &&
            event.data.event.type === "context_compaction_started"
        ) {
            // Compaction is a boundary like steering: what came before it is
            // finished work, and what follows it is a new stretch. The
            // compaction itself is durable history as a message, so only the
            // boundary is recorded here.
            const closedGroupId = openGroupId(event.data.runId);
            closeGroup(event.data.runId, event.createdAt, "compaction", "success");
            rememberBoundary(event.data.runId, closedGroupId, [event.data.event.compactionId]);
        } else if (event.type === "agent_message" && event.data.message.role === "error") {
            const groupId = openGroupId(event.data.runId);
            const known = facts.get(event.data.runId);
            if (groupId !== undefined && known !== undefined) {
                facts.set(event.data.runId, {
                    ...known,
                    messageGroupIds: {
                        ...known.messageGroupIds,
                        [event.data.message.id]: groupId,
                    },
                });
            }
        } else if (event.type === "run_finished") {
            const known = facts.get(event.data.runId);
            facts.set(event.data.runId, {
                ...(known ?? { startedAt: event.createdAt }),
                endedAt: event.createdAt,
                outcome:
                    event.data.stopReason === "error"
                        ? "error"
                        : event.data.stopReason === "aborted"
                          ? "stopped"
                          : "success",
                ...(event.data.errorMessage === undefined
                    ? {}
                    : { errorMessage: event.data.errorMessage }),
            });
            closeGroup(
                event.data.runId,
                event.createdAt,
                event.data.stopReason === "error"
                    ? "error"
                    : event.data.stopReason === "aborted"
                      ? "abort"
                      : "completed",
                event.data.stopReason === "error"
                    ? "error"
                    : event.data.stopReason === "aborted"
                      ? "stopped"
                      : "success",
                event.data.errorMessage,
            );
        } else if (event.type === "run_error") {
            const known = facts.get(event.data.runId);
            facts.set(event.data.runId, {
                ...(known ?? { startedAt: event.createdAt }),
                endedAt: event.createdAt,
                errorMessage: event.data.errorMessage,
                outcome: "error",
            });
            closeGroup(
                event.data.runId,
                event.createdAt,
                "error",
                "error",
                event.data.errorMessage,
            );
        }
    }
    return facts;
}

/**
 * Builds the transcript window carried by a stream's opening frame.
 *
 * The window is cut on turn boundaries rather than after a fixed number of
 * messages. A turn is how a conversation is read, and half of one is not a
 * shorter answer but a broken one: cutting mid-turn can strip the call a tool
 * result belongs to and leave the result with nothing to attach to.
 *
 * Because turns vary in length the message count varies with them. A window of
 * short replies is small; one long run of tool calls can fill it alone. That is
 * the intended trade: the bound tracks the conversation's own structure.
 */
export function sessionTranscriptWindow(
    entries: readonly TranscriptEntry[],
    runFacts: ReadonlyMap<string, TranscriptRunFacts>,
    turnLimit: number,
    /**
     * Return the turns that come immediately before this run, rather than the
     * newest ones. This is how a reader pages back through a long conversation.
     */
    before?: string,
): SessionTranscriptWindow | undefined {
    const groups: { runId: string; entries: TranscriptEntry[] }[] = [];
    const groupByRunId = new Map<string, (typeof groups)[number]>();
    // A queued prompt can be stored before the active run finishes producing its
    // agent messages, so messages of two runs may interleave. The first occurrence
    // fixes each turn's order; later messages return to that turn rather than
    // creating a second fragment whose completion would render before its reply.
    for (const entry of entries) {
        if (entry.message.internal === true) continue;
        if (isTranscriptNoticeEntry(entry)) continue;
        const runId = entry.runId ?? `orphan:${entry.message.id}`;
        const group = groupByRunId.get(runId);
        if (group !== undefined) {
            group.entries.push(entry);
            continue;
        }
        const created = { entries: [entry], runId };
        groupByRunId.set(runId, created);
        groups.push(created);
    }

    // Everything from the requested run onwards is already held by whoever asked
    // for it, so paging looks at the conversation that precedes it.
    let earlier = groups;
    if (before !== undefined) {
        const index = indexOfRun(groups, before);
        // A run the transcript no longer has cannot anchor a page. Answering
        // with the newest turns instead would look like a successful page and
        // silently duplicate the conversation.
        if (index === undefined) return undefined;
        earlier = groups.slice(0, index);
    }
    const kept = turnLimit >= earlier.length ? earlier : earlier.slice(-turnLimit);
    const keptRunIds = new Set(kept.map((group) => group.runId));
    const keptEntries = entries.filter((entry) => {
        if (entry.message.internal === true) return false;
        if (isTranscriptNoticeEntry(entry)) return false;
        return keptRunIds.has(entry.runId ?? `orphan:${entry.message.id}`);
    });
    const notices = entries
        .filter(isTranscriptNoticeEntry)
        .flatMap((entry): SessionTranscriptNotice[] =>
            entry.createdAt !== undefined && entry.eventId !== undefined
                ? [{ createdAt: entry.createdAt, eventId: entry.eventId, message: entry.message }]
                : [],
        );
    const turns: SessionTranscriptTurn[] = kept.map((group) => {
        const facts = runFacts.get(group.runId);
        return {
            messageIds: group.entries.map((entry) => entry.message.id),
            runId: group.runId,
            ...(facts?.kind === undefined ? {} : { kind: facts.kind }),
            // Messages carry no time of their own, so a turn whose run predates
            // the retained event log reports 0 rather than inventing one. A
            // client renders that as an unknown duration, not as the epoch.
            startedAt: facts?.startedAt ?? 0,
            ...(facts?.endedAt === undefined ? {} : { endedAt: facts.endedAt }),
            ...(facts?.outcome === undefined ? {} : { outcome: facts.outcome }),
            ...(facts?.errorMessage === undefined ? {} : { errorMessage: facts.errorMessage }),
            ...(facts?.groups === undefined ? {} : { groups: facts.groups }),
        };
    });

    const messageCreatedAt = Object.fromEntries(
        keptEntries.flatMap((entry) =>
            entry.createdAt === undefined ? [] : [[entry.message.id, entry.createdAt]],
        ),
    );
    const messageEventId = Object.fromEntries(
        keptEntries.flatMap((entry) =>
            entry.eventId === undefined ? [] : [[entry.message.id, entry.eventId]],
        ),
    );
    const messageSteeredAt = Object.fromEntries(
        keptEntries.flatMap((entry) =>
            entry.steeredAt === undefined ? [] : [[entry.message.id, entry.steeredAt]],
        ),
    );
    const messageBoundaryGroupId = Object.fromEntries(
        keptEntries.flatMap((entry) => {
            const groupId =
                entry.runId === undefined
                    ? undefined
                    : runFacts.get(entry.runId)?.boundaryGroupIds?.[entry.message.id];
            return groupId === undefined ? [] : [[entry.message.id, groupId]];
        }),
    );
    const messageGroupId = Object.fromEntries(
        keptEntries.flatMap((entry) => {
            const groupId =
                entry.runId === undefined
                    ? undefined
                    : runFacts.get(entry.runId)?.messageGroupIds?.[entry.message.id];
            return groupId === undefined ? [] : [[entry.message.id, groupId]];
        }),
    );
    return {
        complete: kept.length === earlier.length,
        ...(Object.keys(messageCreatedAt).length === 0 ? {} : { messageCreatedAt }),
        ...(Object.keys(messageEventId).length === 0 ? {} : { messageEventId }),
        ...(Object.keys(messageSteeredAt).length === 0 ? {} : { messageSteeredAt }),
        ...(Object.keys(messageBoundaryGroupId).length === 0 ? {} : { messageBoundaryGroupId }),
        ...(Object.keys(messageGroupId).length === 0 ? {} : { messageGroupId }),
        messages: keptEntries.map((entry) => entry.message),
        ...(notices.length === 0 ? {} : { notices }),
        turns,
    };
}

/** Where a run sits among the turns, or undefined when it is not among them. */
function indexOfRun(groups: readonly { runId: string }[], runId: string): number | undefined {
    const index = groups.findIndex((group) => group.runId === runId);
    return index === -1 ? undefined : index;
}
