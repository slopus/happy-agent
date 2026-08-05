import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import { createSessionDatabaseFixture } from "../../persistence/database/tests/createSessionDatabaseFixture.js";
import { HappySyncRepository } from "../HappySyncRepository.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("HappySyncRepository", () => {
    it("rejects new messages without deleting pending delivery work when the outbox is full", async () => {
        const { databasePath, repository } = await createRepository();
        repository.close();
        const bounded = new HappySyncRepository(databasePath, Date.now, 2);
        const first = createMessage("message-1");
        const second = createMessage("message-2");
        bounded.enqueue("session-1", [first, second]);

        expect(() => bounded.enqueue("session-1", [createMessage("message-3")])).toThrow(
            "Happy sync outbox is full",
        );
        expect(bounded.pending("session-1")).toEqual([first, second]);
        bounded.close();
    });

    it("keeps a random session key and remote cursor across daemon restarts", async () => {
        const { databasePath, repository } = await createRepository();
        const first = repository.ensureSession({
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        repository.setRemoteSession("session-1", "remote-1");
        repository.updateLastRemoteSeq("session-1", 12);
        repository.close();

        const reopened = new HappySyncRepository(databasePath);
        const second = reopened.ensureSession({
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });

        expect(second.encryptionKey).toEqual(first.encryptionKey);
        expect(second).toMatchObject({ lastRemoteSeq: 12, remoteSessionId: "remote-1" });
        reopened.close();
    });

    it("never moves the remote sequence backwards", async () => {
        const { repository } = await createRepository();
        repository.ensureSession({
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });

        repository.updateLastRemoteSeq("session-1", 12);
        repository.updateLastRemoteSeq("session-1", 5);

        expect(repository.getSession("session-1")?.lastRemoteSeq).toBe(12);
        repository.close();
    });

    it("rotates remote state when the authenticated Happy account changes", async () => {
        const { repository } = await createRepository();
        const first = repository.ensureSession({
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        repository.setRemoteSession("session-1", "remote-1");
        repository.enqueue("session-1", [createMessage("encrypted-for-account-1")]);

        const rotated = repository.ensureSession({
            credentialFingerprint: "account-2",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });

        expect(rotated.remoteSessionId).toBeUndefined();
        expect(rotated.encryptionKey).not.toEqual(first.encryptionKey);
        expect(repository.pending("session-1")).toEqual([]);
        repository.close();
    });

    it("lists only sessions mapped for the active Happy credentials", async () => {
        const { repository } = await createRepository();
        repository.ensureSession({
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });

        expect(repository.sessionIds("account-1")).toEqual(["session-1"]);
        expect(repository.sessionIds("account-2")).toEqual([]);
        repository.close();
    });

    it("rolls back session rotation when clearing the stale outbox fails", async () => {
        const { databasePath, repository } = await createRepository();
        repository.ensureSession({
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        const pending = createMessage("encrypted-for-account-1");
        repository.enqueue("session-1", [pending]);
        repository.close();

        const opened = openSessionDatabase(databasePath);
        opened.database.run(
            sql.raw(`
            CREATE TRIGGER reject_happy_outbox_delete
            BEFORE DELETE ON happy_outbox
            BEGIN
                SELECT RAISE(ABORT, 'forced outbox delete failure');
            END
        `),
        );
        opened.client.close();

        const reopened = new HappySyncRepository(databasePath);
        expect(() =>
            reopened.ensureSession({
                credentialFingerprint: "account-2",
                encryptionKey: new Uint8Array(32).fill(2),
                encryptionVariant: "dataKey",
                sessionId: "session-1",
            }),
        ).toThrow("forced outbox delete failure");
        expect(reopened.getSession("session-1")?.credentialFingerprint).toBe("account-1");
        expect(reopened.pending("session-1")).toEqual([pending]);
        reopened.close();
    });
});

function createMessage(localId: string) {
    return {
        content: {
            ev: { t: "service" as const, text: localId },
            id: localId,
            role: "agent" as const,
            time: 1,
        },
        localId,
        meta: { sentFrom: "rig" as const },
        role: "session" as const,
    };
}

async function createRepository() {
    const directory = await mkdtemp(join(tmpdir(), "rig-happy-repository-"));
    directories.push(directory);
    const databasePath = join(directory, "sessions.sqlite");
    createSessionDatabaseFixture(databasePath);
    return { databasePath, repository: new HappySyncRepository(databasePath) };
}
