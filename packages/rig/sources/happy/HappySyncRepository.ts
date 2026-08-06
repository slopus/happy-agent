import { happyOutboxAcknowledge } from "../persistence/happy/happyOutboxAcknowledge.js";
import {
    happyOutboxEnqueue,
    HappySyncOutboxFullError,
} from "../persistence/happy/happyOutboxEnqueue.js";
import { happySessionAdvanceRemoteSequence } from "../persistence/happy/happySessionAdvanceRemoteSequence.js";
import {
    happySessionEnsure,
    type HappySessionState,
} from "../persistence/happy/happySessionEnsure.js";
import { happySessionSetRemote } from "../persistence/happy/happySessionSetRemote.js";
import { queryHappyOutbox } from "../persistence/happy/queryHappyOutbox.js";
import { queryHappySession } from "../persistence/happy/queryHappySession.js";
import { queryHappySessionIds } from "../persistence/happy/queryHappySessionIds.js";
import {
    openSessionDatabase,
    type SessionDatabase,
} from "../persistence/database/openSessionDatabase.js";
import type { HappyEncryptionVariant, HappySessionProtocolMessage } from "./types.js";

const MAX_PENDING_MESSAGES_PER_SESSION = 10_000;
const MAX_RESTORED_SESSIONS = 64;
const RESTORED_SESSION_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export { HappySyncOutboxFullError };
export type { HappySessionState };

export class HappySyncRepository {
    readonly #client: ReturnType<typeof openSessionDatabase>["client"];
    readonly #database: SessionDatabase;
    readonly #maxPendingMessagesPerSession: number;
    readonly #now: () => number;

    constructor(
        databasePath: string,
        now: () => number = Date.now,
        maxPendingMessagesPerSession = MAX_PENDING_MESSAGES_PER_SESSION,
    ) {
        const opened = openSessionDatabase(databasePath);
        this.#client = opened.client;
        this.#database = opened.database;
        this.#maxPendingMessagesPerSession = maxPendingMessagesPerSession;
        this.#now = now;
    }

    acknowledge(sessionId: string, localIds: readonly string[]): void {
        happyOutboxAcknowledge(this.#database, sessionId, localIds);
    }

    close(): void {
        this.#client.close();
    }

    enqueue(sessionId: string, messages: readonly HappySessionProtocolMessage[]): void {
        happyOutboxEnqueue(this.#database, {
            maxPendingMessages: this.#maxPendingMessagesPerSession,
            messages,
            now: this.#now,
            sessionId,
        });
    }

    ensureSession(options: {
        credentialFingerprint: string;
        encryptionKey?: Uint8Array;
        encryptionVariant: HappyEncryptionVariant;
        sessionId: string;
    }): HappySessionState {
        return happySessionEnsure(this.#database, {
            ...options,
            now: this.#now(),
        });
    }

    getSession(sessionId: string): HappySessionState | undefined {
        return queryHappySession(this.#database, sessionId);
    }

    /** Sessions worth reconnecting after a restart, most recently active first. */
    sessionIds(
        credentialFingerprint: string,
        options: { activeSinceMs?: number; limit?: number } = {},
    ): readonly string[] {
        return queryHappySessionIds(this.#database, {
            activeSinceMs:
                options.activeSinceMs ?? this.#now() - RESTORED_SESSION_ACTIVITY_WINDOW_MS,
            credentialFingerprint,
            limit: options.limit ?? MAX_RESTORED_SESSIONS,
        });
    }

    pending(sessionId: string, limit = 50): readonly HappySessionProtocolMessage[] {
        return queryHappyOutbox(this.#database, sessionId, limit);
    }

    setRemoteSession(sessionId: string, remoteSessionId: string): void {
        happySessionSetRemote(this.#database, {
            now: this.#now(),
            remoteSessionId,
            sessionId,
        });
    }

    updateLastRemoteSeq(sessionId: string, sequence: number): void {
        happySessionAdvanceRemoteSequence(this.#database, {
            now: this.#now(),
            sequence,
            sessionId,
        });
    }
}
