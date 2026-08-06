import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("session archiving is durable listing state", () => {
    it("hides, restores, and reloads sessions without removing their history", async () => {
        const gym = await createGym({
            entrypoint: ["bash", "/workspace/exercise-session-archive.sh"],
            files: {
                "exercise-session-archive.sh": exerciseSessionArchiveScript,
                "session-archive-client.mjs": sessionArchiveClientScript,
            },
            inference: [],
            mode: "docker",
            startupText: "SESSION_ARCHIVING_VERIFIED",
        });
        running.add(gym);

        await gym.terminal.waitForText("SESSION_ARCHIVING_VERIFIED", 30_000);

        const before = JSON.parse(await gym.readFile("archive-before-restart.json")) as {
            allIds: string[];
            archiveEvents: number;
            archivedId: string;
            archived: boolean;
            archivedIds: string[];
            defaultIds: string[];
            readableId: string;
            visibleId: string;
        };
        expect(before.defaultIds).toEqual([before.visibleId]);
        expect(before.allIds.sort()).toEqual([before.archivedId, before.visibleId].sort());
        expect(before.archivedIds).toEqual([before.archivedId]);
        expect(before).toMatchObject({
            archiveEvents: 1,
            archived: true,
            readableId: before.archivedId,
        });

        const after = JSON.parse(await gym.readFile("archive-after-restart.json")) as {
            allIds: string[];
            archivedAfterRestart: boolean;
            defaultIdsAfterRestart: string[];
            defaultIdsAfterUnarchive: string[];
            unarchiveEvents: number;
        };
        expect(after.defaultIdsAfterRestart).toEqual([before.visibleId]);
        expect(after.allIds.sort()).toEqual([before.archivedId, before.visibleId].sort());
        expect(after.archivedAfterRestart).toBe(true);
        expect(after.defaultIdsAfterUnarchive.sort()).toEqual(
            [before.archivedId, before.visibleId].sort(),
        );
        expect(after.unarchiveEvents).toBe(1);
    }, 60_000);
});

const exerciseSessionArchiveScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

rig="node /app/packages/rig/dist/main.js"

$rig daemon start
node /workspace/session-archive-client.mjs before
$rig daemon stop
while $rig daemon status | grep -q "Daemon is running"; do
    sleep 0.05
done
$rig daemon start
node /workspace/session-archive-client.mjs after
echo SESSION_ARCHIVING_VERIFIED
read -r _
`;

const sessionArchiveClientScript = String.raw`
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";

const directory = "/tmp/rig-" + process.getuid();
const socketPath = directory + "/server.sock";
const token = (await readFile(directory + "/token", "utf8")).trim();

function requestJson(method, path, body) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                headers: {
                    accept: "application/json",
                    authorization: "Bearer " + token,
                    ...(payload === undefined
                        ? {}
                        : {
                              "content-length": Buffer.byteLength(payload),
                              "content-type": "application/json",
                          }),
                },
                method,
                path,
                socketPath,
            },
            (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    if ((response.statusCode ?? 500) >= 400) {
                        reject(new Error(text));
                        return;
                    }
                    resolve(text.length === 0 ? {} : JSON.parse(text));
                });
            },
        );
        outgoing.on("error", reject);
        if (payload !== undefined) outgoing.write(payload);
        outgoing.end();
    });
}

const phase = process.argv[2];
if (phase === "before") {
    await requestJson("PATCH", "/config", {
        settings: { inferenceMaxRetries: 10, durableGlobalEventQueue: true },
    });
    const visible = await requestJson("POST", "/sessions", { cwd: "/workspace" });
    const hidden = await requestJson("POST", "/sessions", { cwd: "/workspace" });
    const visibleId = visible.session.id;
    const archivedId = hidden.session.id;
    await writeFile(
        "/workspace/archive-session-ids.json",
        JSON.stringify({ archivedId, visibleId }),
    );

    const firstArchive = await requestJson("POST", "/sessions/" + archivedId + "/archive");
    const secondArchive = await requestJson("POST", "/sessions/" + archivedId + "/archive");
    if (JSON.stringify(firstArchive) !== JSON.stringify(secondArchive)) {
        throw new Error("Archive retries must return the same session.");
    }
    const defaultList = await requestJson("GET", "/sessions");
    const all = await requestJson("GET", "/sessions?archived=all");
    const archived = await requestJson("GET", "/sessions?archived=true");
    const readable = await requestJson("GET", "/sessions/" + archivedId);
    const events = await requestJson("GET", "/events?limit=100");
    await writeFile(
        "/workspace/archive-before-restart.json",
        JSON.stringify({
            allIds: all.sessions.map((session) => session.id),
            archivedId,
            archiveEvents: events.events.filter(
                (entry) =>
                    entry.event.sessionId === archivedId &&
                    entry.event.type === "session_archived" &&
                    entry.event.data.archived === true,
            ).length,
            archived: firstArchive.session.archived,
            archivedIds: archived.sessions.map((session) => session.id),
            defaultIds: defaultList.sessions.map((session) => session.id),
            readableId: readable.session.id,
            visibleId,
        }),
    );
} else if (phase === "after") {
    const { archivedId } = JSON.parse(
        await readFile("/workspace/archive-session-ids.json", "utf8"),
    );
    const defaultList = await requestJson("GET", "/sessions");
    const all = await requestJson("GET", "/sessions?archived=all");
    const readable = await requestJson("GET", "/sessions/" + archivedId);
    const firstUnarchive = await requestJson("POST", "/sessions/" + archivedId + "/unarchive");
    const secondUnarchive = await requestJson("POST", "/sessions/" + archivedId + "/unarchive");
    if (JSON.stringify(firstUnarchive) !== JSON.stringify(secondUnarchive)) {
        throw new Error("Unarchive retries must return the same session.");
    }
    const restored = await requestJson("GET", "/sessions");
    const events = await requestJson("GET", "/events?limit=100");
    await writeFile(
        "/workspace/archive-after-restart.json",
        JSON.stringify({
            allIds: all.sessions.map((session) => session.id),
            archivedAfterRestart: readable.session.archived,
            defaultIdsAfterRestart: defaultList.sessions.map((session) => session.id),
            defaultIdsAfterUnarchive: restored.sessions.map((session) => session.id),
            unarchiveEvents: events.events.filter(
                (entry) =>
                    entry.event.sessionId === archivedId &&
                    entry.event.type === "session_archived" &&
                    entry.event.data.archived === false,
            ).length,
        }),
    );
} else {
    throw new Error("Unknown archive test phase.");
}
`;
