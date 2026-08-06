import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSessionDatabaseFixture } from "../../database/tests/createSessionDatabaseFixture.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { inTx } from "../../inTx.js";
import {
    querySessionShareMemberCapabilities,
    querySessionShareMemberCapability,
} from "../querySessionShareMemberCapabilities.js";
import { querySessionSharePeerActions } from "../querySessionSharePeerActions.js";
import { sessionShareCreate } from "../sessionShareCreate.js";
import { sessionShareGrant } from "../sessionShareGrant.js";
import { sessionSharePeerActionAppend } from "../sessionSharePeerActionAppend.js";
import {
    MAX_PEER_ACTION_AGE_MS,
    MAX_PEER_ACTION_ROWS,
    sessionSharePeerActionPrune,
} from "../sessionSharePeerActionPrune.js";
import { sessionShareRevoke } from "../sessionShareRevoke.js";
import { sessionShareSetMemberCapabilities } from "../sessionShareSetMemberCapabilities.js";
import { sessionShareStop } from "../sessionShareStop.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("session share peer capabilities persistence", () => {
    it("grants no capability to a freshly created member by default", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);

            expect(querySessionShareMemberCapabilities(opened.database, "share-1")).toEqual([]);
            expect(
                querySessionShareMemberCapability(opened.database, {
                    capability: "terminal_view",
                    shareId: "share-1",
                    shareMemberId: "member-1",
                }),
            ).toBeUndefined();
        } finally {
            opened.client.close();
        }
    });

    it("revokes dropped capabilities and keeps the ones that stayed on the next full set", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);

            const granted = sessionShareSetMemberCapabilities(opened.database, {
                capabilities: ["terminal_view"],
                now: 10,
                shareId: "share-1",
                shareMemberId: "member-1",
            });
            expect(granted).toEqual([
                {
                    capability: "terminal_view",
                    grantEpoch: 1,
                    grantedAt: 10,
                    shareMemberId: "member-1",
                    state: "active",
                },
            ]);

            // Setting the same set again keeps the capability active (nothing dropped).
            const again = sessionShareSetMemberCapabilities(opened.database, {
                capabilities: ["terminal_view"],
                now: 11,
                shareId: "share-1",
                shareMemberId: "member-1",
            });
            expect(again.map((row) => row.capability)).toEqual(["terminal_view"]);
            expect(
                querySessionShareMemberCapability(opened.database, {
                    capability: "terminal_view",
                    shareId: "share-1",
                    shareMemberId: "member-1",
                }),
            ).toBeDefined();

            // Setting the empty set drops the capability that is no longer present.
            const emptied = sessionShareSetMemberCapabilities(opened.database, {
                capabilities: [],
                now: 12,
                shareId: "share-1",
                shareMemberId: "member-1",
            });
            expect(emptied).toEqual([]);
            expect(
                querySessionShareMemberCapability(opened.database, {
                    capability: "terminal_view",
                    shareId: "share-1",
                    shareMemberId: "member-1",
                }),
            ).toBeUndefined();
        } finally {
            opened.client.close();
        }
    });

    it("resolves nothing for a capability that was never granted", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);

            expect(
                querySessionShareMemberCapability(opened.database, {
                    capability: "terminal_view",
                    shareId: "share-1",
                    shareMemberId: "member-1",
                }),
            ).toBeUndefined();
        } finally {
            opened.client.close();
        }
    });

    it("does not resolve a capability once its member is revoked", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);
            sessionShareSetMemberCapabilities(opened.database, {
                capabilities: ["terminal_view"],
                now: 10,
                shareId: "share-1",
                shareMemberId: "member-1",
            });

            expect(
                sessionShareRevoke(opened.database, {
                    now: 20,
                    shareId: "share-1",
                    shareMemberId: "member-1",
                }),
            ).toBe(true);

            expect(
                querySessionShareMemberCapability(opened.database, {
                    capability: "terminal_view",
                    shareId: "share-1",
                    shareMemberId: "member-1",
                }),
            ).toBeUndefined();
        } finally {
            opened.client.close();
        }
    });

    it("leaves no capability active after a revoke or a stop", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);
            sessionShareSetMemberCapabilities(opened.database, {
                capabilities: ["terminal_view"],
                now: 10,
                shareId: "share-1",
                shareMemberId: "member-1",
            });
            expect(querySessionShareMemberCapabilities(opened.database, "share-1")).toHaveLength(1);

            sessionShareRevoke(opened.database, {
                now: 20,
                shareId: "share-1",
                shareMemberId: "member-1",
            });
            // A capability must never survive the grant it rested on: after a revoke
            // no active capability row remains at the member's current epoch.
            expect(querySessionShareMemberCapabilities(opened.database, "share-1")).toEqual([]);

            // Re-grant so there is a live member and capability to stop.
            sessionShareGrant(opened.database, {
                displayName: "Peer one",
                murmurPeerId: "peer-1",
                now: 30,
                shareId: "share-1",
                shareMemberId: "member-1",
            });
            sessionShareSetMemberCapabilities(opened.database, {
                capabilities: ["terminal_view"],
                now: 31,
                shareId: "share-1",
                shareMemberId: "member-1",
            });
            expect(querySessionShareMemberCapabilities(opened.database, "share-1")).toHaveLength(1);

            expect(sessionShareStop(opened.database, "share-1", 40)).toBe(true);
            // The same invariant holds through a stop, which flips states rather
            // than deleting rows, so the FK cascade never fires.
            expect(querySessionShareMemberCapabilities(opened.database, "share-1")).toEqual([]);
        } finally {
            opened.client.close();
        }
    });

    it("cannot resolve a capability left behind at a stale grant epoch", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);
            sessionShareSetMemberCapabilities(opened.database, {
                capabilities: ["terminal_view"],
                now: 10,
                shareId: "share-1",
                shareMemberId: "member-1",
            });

            // Revoke, then re-grant the same peer. Re-granting bumps the member's
            // current grant epoch, so the capability row written at the old epoch is
            // structurally stranded.
            sessionShareRevoke(opened.database, {
                now: 20,
                shareId: "share-1",
                shareMemberId: "member-1",
            });
            const regranted = sessionShareGrant(opened.database, {
                displayName: "Peer one",
                murmurPeerId: "peer-1",
                now: 30,
                shareId: "share-1",
                shareMemberId: "member-1",
            });
            expect(regranted.currentGrantEpoch).toBe(2);

            // The old epoch's row does not resolve, and the member holds no
            // capability until it is granted again at the new epoch.
            expect(
                querySessionShareMemberCapability(opened.database, {
                    capability: "terminal_view",
                    shareId: "share-1",
                    shareMemberId: "member-1",
                }),
            ).toBeUndefined();
            expect(querySessionShareMemberCapabilities(opened.database, "share-1")).toEqual([]);

            sessionShareSetMemberCapabilities(opened.database, {
                capabilities: ["terminal_view"],
                now: 31,
                shareId: "share-1",
                shareMemberId: "member-1",
            });
            expect(
                querySessionShareMemberCapability(opened.database, {
                    capability: "terminal_view",
                    shareId: "share-1",
                    shareMemberId: "member-1",
                }),
            ).toEqual({
                capability: "terminal_view",
                grantEpoch: 2,
                grantedAt: 31,
                shareMemberId: "member-1",
                state: "active",
            });
        } finally {
            opened.client.close();
        }
    });

    it("assigns gapless per-share sequences and pages the audit log with completeness", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);

            const seqs = [1, 2, 3].map(
                (index) =>
                    sessionSharePeerActionAppend(opened.database, {
                        action: "view",
                        capability: "terminal_view",
                        detail: `terminal-${String(index)}`,
                        grantEpoch: 1,
                        now: 100 + index,
                        outcome: "allowed",
                        shareId: "share-1",
                        shareMemberId: "member-1",
                    }).seq,
            );
            expect(seqs).toEqual([1, 2, 3]);

            const firstPage = querySessionSharePeerActions(opened.database, {
                afterSeq: 0,
                limit: 2,
                shareId: "share-1",
            });
            expect(firstPage.complete).toBe(false);
            expect(firstPage.entries.map((entry) => entry.seq)).toEqual([1, 2]);
            expect(firstPage.entries[0]).toEqual({
                action: "view",
                capability: "terminal_view",
                createdAt: 101,
                detail: "terminal-1",
                grantEpoch: 1,
                outcome: "allowed",
                seq: 1,
                shareId: "share-1",
                shareMemberId: "member-1",
            });

            const secondPage = querySessionSharePeerActions(opened.database, {
                afterSeq: 2,
                shareId: "share-1",
            });
            expect(secondPage.complete).toBe(true);
            expect(secondPage.entries.map((entry) => entry.seq)).toEqual([3]);
        } finally {
            opened.client.close();
        }
    });

    it("prunes audit rows past the age cap", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);
            for (const index of [1, 2, 3]) {
                sessionSharePeerActionAppend(opened.database, {
                    action: "view",
                    capability: "terminal_view",
                    grantEpoch: 1,
                    now: 1_000 + index,
                    outcome: "allowed",
                    shareId: "share-1",
                    shareMemberId: "member-1",
                });
            }

            // Advance now well past the age window; the earlier rows fall out.
            const deleted = sessionSharePeerActionPrune(opened.database, {
                now: 1_003 + MAX_PEER_ACTION_AGE_MS + 1,
                shareId: "share-1",
            });
            expect(deleted).toBe(3);
            expect(
                querySessionSharePeerActions(opened.database, { shareId: "share-1" }).entries,
            ).toEqual([]);
        } finally {
            opened.client.close();
        }
    });

    it("prunes audit rows past the row cap on the write path", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);
            const overflow = 5;
            const total = MAX_PEER_ACTION_ROWS + overflow;
            inTx(opened.database, (tx) => {
                for (let index = 1; index <= total; index += 1) {
                    sessionSharePeerActionAppend(tx, {
                        action: "view",
                        capability: "terminal_view",
                        grantEpoch: 1,
                        now: index,
                        outcome: "allowed",
                        shareId: "share-1",
                        shareMemberId: "member-1",
                    });
                }
            });

            // The oldest `overflow` sequences were pruned; the newest cap remains.
            const firstPage = querySessionSharePeerActions(opened.database, {
                afterSeq: 0,
                shareId: "share-1",
            });
            expect(firstPage.entries[0]?.seq).toBe(overflow + 1);
            const tail = querySessionSharePeerActions(opened.database, {
                afterSeq: total,
                shareId: "share-1",
            });
            expect(tail.complete).toBe(true);
            expect(tail.entries).toEqual([]);
        } finally {
            opened.client.close();
        }
    }, 15_000);
});

function createShare(tx: Parameters<typeof sessionShareCreate>[0]): void {
    sessionShareCreate(tx, {
        includeFriendMessages: true,
        members: [
            {
                displayName: "Peer one",
                murmurPeerId: "peer-1",
                shareMemberId: "member-1",
            },
        ],
        now: 1,
        ownerPeerId: "peer-owner",
        ownerSessionId: "session-1",
        shareId: "share-1",
        toolOutput: "summaries",
    });
}

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "rig-session-share-peer-caps-"));
    directories.push(directory);
    const path = join(directory, "sessions.sqlite");
    createSessionDatabaseFixture(path);
    return { ...openSessionDatabase(path), databasePath: path };
}
