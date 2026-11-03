import type { FeedChange, FeedFold, FeedVerb } from "../FeedRecords.js";

/** The verbs that create their subject; every other verb is one update to it. */
const CREATIONS: ReadonlySet<FeedVerb> = new Set([
    "task.created",
    "bot.created",
    "surface.created",
    "artifact.created",
]);

/** Distinct actors kept per entry; enough to count any real team, and bounded. */
const MAX_ACTORS = 1_000;

/**
 * Fold one change into an entry for its subject, or start one. Changes arrive oldest first, so the
 * newest change's cursor, snapshot, and home cluster describe the entry.
 */
export function foldFeedChange(fold: FeedFold | undefined, change: FeedChange): FeedFold {
    const created = CREATIONS.has(change.verb);
    const cluster = change.clusters.at(-1)!;
    if (fold === undefined) {
        return {
            cursor: change.id,
            subject: change.subject,
            cluster,
            created,
            updates: created ? 0 : 1,
            actors: [change.actor],
            snapshot: change.snapshot,
            firstAt: change.occurredAt,
            lastAt: change.occurredAt,
        };
    }
    const known = fold.actors.some(
        (actor) => actor.userId === change.actor.userId && actor.agentId === change.actor.agentId,
    );
    const newer = change.id > fold.cursor;
    return {
        cursor: newer ? change.id : fold.cursor,
        subject: fold.subject,
        cluster: newer ? cluster : fold.cluster,
        created: fold.created || created,
        updates: fold.updates + (created ? 0 : 1),
        actors:
            known || fold.actors.length >= MAX_ACTORS
                ? fold.actors
                : [...fold.actors, change.actor],
        snapshot: newer ? change.snapshot : fold.snapshot,
        firstAt: Math.min(fold.firstAt, change.occurredAt),
        lastAt: Math.max(fold.lastAt, change.occurredAt),
    };
}

/**
 * Group changes, newest first, into at most `limit` subjects, the most recently changed first,
 * and fold each subject's changes oldest first.
 */
export function foldFeedHistory(changes: readonly FeedChange[], limit: number): FeedFold[] {
    const groups = new Map<string, FeedChange[]>();
    for (const change of changes) {
        const key = `${change.subject.type}:${change.subject.id}`;
        const group = groups.get(key);
        if (group !== undefined) group.push(change);
        else if (groups.size < limit) groups.set(key, [change]);
    }
    return [...groups.values()].map(
        (group) => group.reduceRight<FeedFold | undefined>(foldFeedChange, undefined)!,
    );
}
