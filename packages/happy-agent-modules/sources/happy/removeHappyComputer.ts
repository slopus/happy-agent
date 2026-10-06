import type { HappyConnectionConfiguration } from "./HappyCredentials.js";

const REQUEST_TIMEOUT_MS = 15_000;
/** Enough parallel deletes that a large history unlinks in seconds without flooding Happy. */
const SESSION_DELETE_CONCURRENCY = 8;

/** One session this daemon published, as its sync state recorded it. */
export interface HappyPublishedSession {
    readonly agentId: string;
    readonly remoteSessionId: string;
}

/**
 * What Happy said about removing this computer. `credentials_rejected` means the account no longer
 * accepts these credentials, so nothing more can ever be removed with them.
 */
export type HappyComputerRemoval = "removed" | "credentials_rejected";

/** Happy did not confirm a deletion; everything not yet confirmed is still on the account. */
export class HappyComputerRemovalError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "HappyComputerRemovalError";
    }
}

/**
 * Deletes this computer from the Happy account: its machine, then every session it published.
 *
 * Deleting the machine is what removes a computer. Happy deletes the sessions it knows the machine
 * published along with it, the same as when the phone deletes the computer, and remembers the
 * deletion, so a daemon that restarts before finishing learns the computer is gone. The sessions
 * this daemon recorded are then deleted one by one, which covers sessions published before Happy
 * knew their machine and Happy servers that do not delete them with it. A session or machine Happy
 * no longer has is already deleted, which is what makes a retry resume where the last one stopped.
 * `onSessionRemoved` runs as soon as each deletion is confirmed so the caller can forget it.
 */
export async function removeHappyComputer(options: {
    readonly configuration: HappyConnectionConfiguration;
    readonly sessions: readonly HappyPublishedSession[];
    readonly onSessionRemoved: (session: HappyPublishedSession) => Promise<void>;
    readonly version: string;
    readonly fetch?: typeof fetch;
}): Promise<HappyComputerRemoval> {
    const request = async (path: string): Promise<"deleted" | "rejected"> => {
        let response: Response;
        try {
            response = await (options.fetch ?? fetch)(`${options.configuration.serverUrl}${path}`, {
                headers: {
                    Authorization: `Bearer ${options.configuration.credentials.token}`,
                    "X-Happy-Client": `rig-daemon/${options.version}`,
                },
                method: "DELETE",
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (error: unknown) {
            throw new HappyComputerRemovalError("Happy could not be reached.", { cause: error });
        }
        await response.body?.cancel().catch(() => undefined);
        if (response.ok || response.status === 404) return "deleted";
        if (response.status === 401 || response.status === 403) return "rejected";
        throw new HappyComputerRemovalError(`Happy answered ${String(response.status)}.`);
    };

    const machineId = options.configuration.machineId;
    if (
        machineId !== undefined &&
        (await request(`/v1/machines/${encodeURIComponent(machineId)}`)) === "rejected"
    ) {
        return "credentials_rejected";
    }

    const pending = [...options.sessions];
    let rejected = false;
    let stopped = false;
    const worker = async (): Promise<void> => {
        for (let session = pending.shift(); session !== undefined; session = pending.shift()) {
            if (stopped) return;
            try {
                const outcome = await request(
                    `/v1/sessions/${encodeURIComponent(session.remoteSessionId)}`,
                );
                if (outcome === "rejected") {
                    rejected = true;
                    stopped = true;
                    return;
                }
                await options.onSessionRemoved(session);
            } catch (error: unknown) {
                stopped = true;
                throw error;
            }
        }
    };
    const workers = Array.from(
        { length: Math.min(SESSION_DELETE_CONCURRENCY, pending.length) },
        async () => await worker(),
    );
    // Every worker settles before the outcome is decided, so no deletion is still in flight when
    // the caller reports it.
    const settled = await Promise.allSettled(workers);
    const failure = settled.find((result) => result.status === "rejected");
    if (failure !== undefined) throw failure.reason;
    return rejected ? "credentials_rejected" : "removed";
}
