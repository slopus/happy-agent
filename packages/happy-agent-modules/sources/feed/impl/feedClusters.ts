import type { FeedAudience, FeedSubscriptionState } from "../FeedRecords.js";

/** The cluster that means everything. */
export const EVERYTHING = "*";
/** What happens across the team: new tasks, bots, and Surfaces. */
export const TEAM = "team";

const TARGET_KINDS = ["task", "bot", "surface", "project", "workspace"] as const;
export type FeedTargetKind = (typeof TARGET_KINDS)[number];

const CLUSTER = /^(task|bot|surface|project|workspace):([a-z][a-z0-9]{1,95})$/;

/** A cluster name taken apart, or undefined when it is not one. */
export type ParsedFeedCluster =
    | { readonly kind: "everything" }
    | { readonly kind: "team" }
    | { readonly kind: FeedTargetKind; readonly id: string };

export function parseFeedCluster(cluster: string): ParsedFeedCluster | undefined {
    if (cluster === EVERYTHING) return { kind: "everything" };
    if (cluster === TEAM) return { kind: "team" };
    const match = CLUSTER.exec(cluster);
    if (match === null) return undefined;
    return { kind: match[1] as FeedTargetKind, id: match[2]! };
}

/** The clusters of an artifact change, from where its version was made. */
export function artifactClusters(
    source:
        | {
              kind: string;
              taskId?: string;
              botId?: string;
              projectId?: string;
              workspaceId?: string;
          }
        | undefined,
): string[] {
    if (source?.kind === "task" && source.taskId) return [`task:${source.taskId}`];
    if (source?.kind === "bot" && source.botId) return [`bot:${source.botId}`];
    if (source?.kind === "project" && source.projectId) return [`project:${source.projectId}`];
    if (source?.kind === "workspace" && source.projectId && source.workspaceId)
        return [`project:${source.projectId}`, `workspace:${source.workspaceId}`];
    return [TEAM];
}

/** Whether a change for this audience may reach this reader; standalone sees everything. */
export function audienceIncludes(
    audience: FeedAudience,
    userId: string | null,
    standalone: boolean,
): boolean {
    if (audience.kind === "everyone" || standalone) return true;
    return userId !== null && audience.userIds.includes(userId);
}

/**
 * Whether a reader's choices let a change in these clusters reach them. A mute on any of its
 * clusters wins; otherwise `*`, subscribed unless muted, or a subscribed cluster admits it.
 */
export function subscriptionsAdmit(
    choices: ReadonlyMap<string, FeedSubscriptionState>,
    clusters: readonly string[],
): boolean {
    if (clusters.some((cluster) => choices.get(cluster) === "muted")) return false;
    if (choices.get(EVERYTHING) !== "muted") return true;
    return clusters.some((cluster) => choices.get(cluster) === "subscribed");
}
