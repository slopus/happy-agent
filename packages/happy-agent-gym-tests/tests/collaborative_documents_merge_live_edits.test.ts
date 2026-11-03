import type { HappyAgentClient } from "@slopus/happy-agent-client";
import {
    createAgentGym,
    HappyAgentEventStream,
    type AgentGym,
    type GymSseFrame,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running: AgentGym[] = [];
const streams: HappyAgentEventStream[] = [];
afterEach(async () => {
    for (const stream of streams.splice(0)) stream.close();
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

/** One editor window: a local Yjs replica of the document, loaded from the daemon. */
async function openReplica(client: HappyAgentClient, surfaceId: string): Promise<Y.Doc> {
    const doc = new Y.Doc();
    const state = await client.getSurfaceDocumentState(surfaceId);
    Y.applyUpdate(doc, Buffer.from(state.update, "base64"));
    return doc;
}

/** Type into the first paragraph the way an editor does, returning the change as base64. */
function type(doc: Y.Doc, index: number | "end", text: string): string {
    const before = Y.encodeStateVector(doc);
    const paragraph = firstText(doc);
    paragraph.insert(index === "end" ? paragraph.length : index, text);
    return Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64");
}

/** The text of the document's first paragraph. */
function firstText(doc: Y.Doc): Y.XmlText {
    const visit = (node: Y.XmlFragment | Y.XmlElement): Y.XmlText | undefined => {
        for (const child of node.toArray()) {
            if (child instanceof Y.XmlText) return child;
            const found = child instanceof Y.XmlElement ? visit(child) : undefined;
            if (found !== undefined) return found;
        }
        return undefined;
    };
    const text = visit(doc.getXmlFragment("document"));
    if (text === undefined) throw new Error("The document has no paragraph to type into.");
    return text;
}

async function openStream(client: HappyAgentClient): Promise<{
    stream: HappyAgentEventStream;
    streamId: string;
}> {
    const stream = new HappyAgentEventStream(client);
    streams.push(stream);
    await stream.opened();
    const hello = stream.frames[0]?.data as { streamId?: string } | undefined;
    if (hello?.streamId === undefined) throw new Error("The event stream hello has no streamId.");
    return { stream, streamId: hello.streamId };
}

function documentUpdates(stream: HappyAgentEventStream): { seq: number; update: string }[] {
    return stream.frames
        .filter((frame) => frame.event === "document.update")
        .map((frame) => frame.data as { seq: number; update: string });
}

function presenceFrames(stream: HappyAgentEventStream): GymSseFrame["data"][] {
    return stream.frames
        .filter((frame) => frame.event === "document.presence")
        .map((frame) => frame.data);
}

describe("collaborative documents merge live edits", () => {
    it("merges concurrent changes, relays them live in seq order, and keeps the log across restart", async () => {
        const gym = await createAgentGym();
        running.push(gym);
        const client = gym.client;
        expect((await client.getHealth()).capabilities).toMatchObject({
            collaborativeDocuments: true,
        });
        const surface = (
            await client.createSurface({
                type: "document",
                name: "Notes",
                text: "Hello\n",
                mutationId: "created",
            })
        ).surface;
        const created = (await client.getSurfaceDocument(surface.id)).document;
        expect(created).toMatchObject({ text: "Hello\n", seq: 1, lastEditorUserId: null });

        const first = await openStream(client);
        const second = await openStream(client);
        expect(first.streamId).not.toBe(second.streamId);
        for (const { streamId } of [first, second])
            expect(await client.subscribeSurfaceDocument(surface.id, { streamId })).toEqual({
                seq: 1,
            });
        // Subscribing again changes nothing.
        expect(
            await client.subscribeSurfaceDocument(surface.id, { streamId: first.streamId }),
        ).toEqual({ seq: 1 });

        const left = await openReplica(client, surface.id);
        const right = await openReplica(client, surface.id);
        const typedLeft = type(left, "end", " world");
        const typedRight = type(right, 0, "Oh, ");
        const seqs = await Promise.all([
            client.sendSurfaceDocumentUpdate(surface.id, {
                update: typedLeft,
                mutationId: "left-1",
            }),
            client.sendSurfaceDocumentUpdate(surface.id, {
                update: typedRight,
                mutationId: "right-1",
            }),
        ]);
        expect(seqs.map((response) => response.seq).sort()).toEqual([2, 3]);
        for (const { stream } of [first, second]) {
            await stream.waitFor(
                (frame) =>
                    frame.event === "document.update" && (frame.data as { seq: number }).seq === 3,
                "both live changes",
            );
            expect(documentUpdates(stream).map((frame) => frame.seq)).toEqual([2, 3]);
            for (const frame of stream.frames.filter((entry) =>
                entry.event.startsWith("document."),
            ))
                expect(frame.id).toBeUndefined();
        }
        // Each window applies every live change, including its own, and converges.
        for (const frame of documentUpdates(first.stream)) {
            Y.applyUpdate(left, Buffer.from(frame.update, "base64"));
            Y.applyUpdate(right, Buffer.from(frame.update, "base64"));
        }
        expect(firstText(left).toString()).toBe("Oh, Hello world");
        expect(firstText(right).toString()).toBe("Oh, Hello world");
        const merged = (await client.getSurfaceDocument(surface.id)).document;
        expect(merged).toMatchObject({ text: "Oh, Hello world\n", seq: 3 });
        expect(merged.version).not.toBe(created.version);

        // A retried change returns its original seq; a change already contained appends nothing.
        const leftSeq = seqs[0]!.seq;
        expect(
            await client.sendSurfaceDocumentUpdate(surface.id, {
                update: typedLeft,
                mutationId: "left-1",
            }),
        ).toEqual({ seq: leftSeq });
        expect(
            await client.sendSurfaceDocumentUpdate(surface.id, {
                update: typedRight,
                mutationId: "right-again",
            }),
        ).toEqual({ seq: 3 });
        for (const update of ["/////w==", Buffer.alloc(64, 7).toString("base64")])
            await expect(
                client.sendSurfaceDocumentUpdate(surface.id, { update, mutationId: "broken" }),
            ).rejects.toMatchObject({ status: 400, code: "invalid_request" });

        // A replica of an earlier version catches up by its state vector.
        const behind = new Y.Doc();
        const atFirst = await client.getSurfaceDocumentState(surface.id, { seq: 1 });
        expect(atFirst.seq).toBe(1);
        Y.applyUpdate(behind, Buffer.from(atFirst.update, "base64"));
        expect(firstText(behind).toString()).toBe("Hello");
        const catchUp = await client.getSurfaceDocumentState(surface.id, {
            stateVector: Buffer.from(Y.encodeStateVector(behind)).toString("base64"),
        });
        expect(catchUp.update.length).toBeLessThan(
            (await client.getSurfaceDocumentState(surface.id)).update.length,
        );
        Y.applyUpdate(behind, Buffer.from(catchUp.update, "base64"));
        expect(firstText(behind).toString()).toBe("Oh, Hello world");
        expect((await client.getSurfaceDocument(surface.id, { seq: 1 })).document).toMatchObject({
            text: "Hello\n",
            seq: 1,
        });
        for (const seq of [0, 4])
            await expect(client.getSurfaceDocument(surface.id, { seq })).rejects.toMatchObject({
                status: 404,
            });
        await expect(
            client.getSurfaceDocumentState(surface.id, { seq: 1, stateVector: "AA==" }),
        ).rejects.toMatchObject({ status: 400 });

        // Older clients that save Markdown stop on 405 without changing anything.
        const put = await gym.raw.request("PUT", `/v0/surfaces/document/${surface.id}`, {
            text: "Overwritten",
        });
        expect(put.status).toBe(405);
        expect(put.headers.allow).toBe("GET");
        expect(put.body).toEqual({
            code: "method_not_allowed",
            error: "Editing this document needs a newer Happy.",
        });

        const list = (await client.createSurface({ type: "todo", name: "List" })).surface;
        for (const surfaceId of [list.id, "s00000000000000000000000"]) {
            await expect(client.getSurfaceDocumentState(surfaceId)).rejects.toMatchObject({
                status: 404,
            });
            await expect(
                client.subscribeSurfaceDocument(surfaceId, { streamId: first.streamId }),
            ).rejects.toMatchObject({ status: 404 });
        }
        await expect(
            client.subscribeSurfaceDocument(surface.id, { streamId: "unknownstream000000000000" }),
        ).rejects.toMatchObject({ status: 404 });

        const log = await client.listSurfaceDocumentUpdates(surface.id);
        expect(log.nextAfterSeq).toBeNull();
        expect(log.updates.map((entry) => [entry.seq, entry.source, entry.mutationId])).toEqual([
            [1, "api", "created"],
            [2, "api", seqs[0]!.seq === 2 ? "left-1" : "right-1"],
            [3, "api", seqs[0]!.seq === 2 ? "right-1" : "left-1"],
        ]);
        expect(
            await client.listSurfaceDocumentUpdates(surface.id, { afterSeq: 1, limit: 1 }),
        ).toMatchObject({ updates: [{ seq: 2 }], nextAfterSeq: 2 });
        expect((await client.listSurfaceDocumentVersions(surface.id)).versions).toEqual([]);

        const events = (await client.getEvents({ limit: 1000 })).events;
        expect(events.map((event) => event.type)).not.toContain("surface.document.updated");
        expect(JSON.stringify(events)).not.toContain("Oh, ");

        await gym.restart();
        expect((await gym.client.getSurfaceDocument(surface.id)).document).toEqual(merged);
        expect(await gym.client.listSurfaceDocumentUpdates(surface.id)).toEqual(log);
        expect(gym.errors).toEqual([]);
    });

    it("relays presence only between a person's own subscribed streams and records who edited", async () => {
        const { gym, alice, bob, aliceId, bobId } = await surfaceTeamClients();
        running.push(gym);
        const surface = (
            await alice.createSurface({ type: "document", name: "Shared", text: "Draft\n" })
        ).surface;
        const aliceStream = await openStream(alice);
        const bobStream = await openStream(bob);
        await expect(
            bob.subscribeSurfaceDocument(surface.id, { streamId: aliceStream.streamId }),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
            bob.sendSurfaceDocumentPresence(surface.id, {
                streamId: aliceStream.streamId,
                awarenessClientId: 1,
                update: "AQ==",
            }),
        ).rejects.toMatchObject({ status: 404 });
        await alice.subscribeSurfaceDocument(surface.id, { streamId: aliceStream.streamId });
        await bob.subscribeSurfaceDocument(surface.id, { streamId: bobStream.streamId });

        await alice.sendSurfaceDocumentPresence(surface.id, {
            streamId: aliceStream.streamId,
            awarenessClientId: 11,
            update: "AQID",
        });
        const shared = await bobStream.stream.waitFor(
            (frame) => frame.event === "document.presence",
            "Alice's presence",
        );
        expect(shared.data).toMatchObject({
            surfaceId: surface.id,
            active: true,
            revision: 1,
            awarenessClientId: 11,
            update: "AQID",
        });
        expect(shared.id).toBeUndefined();
        const clientKey = (shared.data as { clientKey: string }).clientKey;
        // A window that opens the document later sees who is already there.
        const late = await openStream(bob);
        await bob.subscribeSurfaceDocument(surface.id, { streamId: late.streamId });
        await late.stream.waitFor(
            (frame) => frame.event === "document.presence",
            "current presence",
        );
        expect(presenceFrames(late.stream)).toMatchObject([{ clientKey, active: true }]);

        const replica = await openReplica(bob, surface.id);
        await bob.sendSurfaceDocumentUpdate(surface.id, {
            update: type(replica, "end", " by Bob"),
            mutationId: "bob-edit",
        });
        await aliceStream.stream.waitFor(
            (frame) => frame.event === "document.update",
            "Bob's change on Alice's stream",
        );
        expect(documentUpdates(aliceStream.stream)).toMatchObject([
            { seq: 2, actor: { userId: bobId, agentId: null }, mutationId: "bob-edit" },
        ]);
        expect((await alice.getSurfaceDocument(surface.id)).document).toMatchObject({
            text: "Draft by Bob\n",
            authorUserId: aliceId,
            lastEditorUserId: bobId,
            seq: 2,
        });
        expect(presenceFrames(aliceStream.stream)).toEqual([]);

        // Closing Alice's window ends her presence for everyone still there.
        aliceStream.stream.close();
        await bobStream.stream.waitFor(
            (frame) =>
                frame.event === "document.presence" &&
                (frame.data as { active: boolean }).active === false,
            "Alice's presence ending",
        );
        expect(presenceFrames(bobStream.stream).at(-1)).toEqual({
            surfaceId: surface.id,
            clientKey,
            revision: 2,
            active: false,
            awarenessClientId: 11,
        });
        await expect(
            alice.subscribeSurfaceDocument(surface.id, { streamId: aliceStream.streamId }),
        ).rejects.toMatchObject({ status: 404 });
        expect(gym.errors).toEqual([]);
    });

    it.each(["allow", "deny"] as const)(
        "reviews an agent's Markdown edit (%s) and merges it with what people typed since it read",
        async (decision) => {
            let agentId = "";
            const reviews: string[] = [];
            const calls: { name: string; arguments: unknown }[] = [];
            const gym = await createAgentGym({
                permissionMode: "auto",
                inference(request) {
                    if (request.sessionId.startsWith("naming:"))
                        return { content: [{ type: "text", text: "<title>Document</title>" }] };
                    if (request.sessionId !== agentId) {
                        reviews.push(JSON.stringify(request.messages));
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `<review><outcome>${decision}</outcome><risk>low</risk><user_authorization>high</user_authorization><rationale>Scripted permission decision.</rationale></review>`,
                                },
                            ],
                        };
                    }
                    const call = calls.shift();
                    if (call === undefined)
                        return { content: [{ type: "text", text: "Finished." }] };
                    return { content: [{ type: "tool_call", ...call }] };
                },
            });
            running.push(gym);
            agentId = gym.defaultSessionId;
            const client = gym.client;
            const surface = (
                await client.createSurface({
                    type: "document",
                    name: "Plan",
                    text: "# Plan\n\nFirst step\n",
                })
            ).surface;
            calls.push({ name: "read_document", arguments: { tabId: surface.id } });
            await gym.send("Read the plan.", { permissionMode: "auto" });
            expect(reviews).toEqual([]);
            const reading = gym.inference.toolResults().at(-1)!.text;
            expect(reading).toContain('"seq":1');
            expect(reading).toContain("First step");

            // A person types into the heading after the agent read version 1.
            const replica = await openReplica(client, surface.id);
            await client.sendSurfaceDocumentUpdate(surface.id, {
                update: type(replica, "end", " (started)"),
                mutationId: "person",
            });
            const personal = (await client.getSurfaceDocument(surface.id)).document;
            expect(personal.seq).toBe(2);

            calls.push({
                name: "update_document",
                arguments: {
                    tabId: surface.id,
                    seq: 1,
                    text: "# Plan\n\nFirst step\n\nSecond step\n",
                },
            });
            await gym.send("Add a second step to the plan.", { permissionMode: "auto" });
            expect(reviews).toHaveLength(1);
            expect(reviews[0]).toContain("Add a second step to the plan.");
            expect(reviews[0]).toContain("update_document");
            expect(reviews[0]).toContain("shared data write");
            const current = (await client.getSurfaceDocument(surface.id)).document;
            const log = (await client.listSurfaceDocumentUpdates(surface.id)).updates;
            if (decision === "allow") {
                expect(current).toMatchObject({
                    text: "# Plan (started)\n\nFirst step\n\nSecond step\n",
                    seq: 3,
                });
                expect(log.at(-1)).toMatchObject({
                    seq: 3,
                    source: "tool",
                    actor: { userId: null, agentId },
                    mutationId: null,
                });
            } else {
                expect(current).toEqual(personal);
                expect(log).toHaveLength(2);
            }
            expect(gym.errors).toEqual([]);
            expect(gym.inference.unscripted).toEqual([]);
        },
    );

    it("refuses an agent's Markdown write when the document holds content Happy cannot represent", async () => {
        const calls: { name: string; arguments: unknown }[] = [];
        const gym = await createAgentGym({
            permissionMode: "full_access",
            inference(request) {
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "<title>Document</title>" }] };
                const call = calls.shift();
                if (call === undefined) return { content: [{ type: "text", text: "Finished." }] };
                return { content: [{ type: "tool_call", ...call }] };
            },
        });
        running.push(gym);
        const client = gym.client;
        const surface = (
            await client.createSurface({ type: "document", name: "Newer", text: "Kept\n" })
        ).surface;
        // A newer editor wrote a block this daemon's content model does not know.
        const replica = await openReplica(client, surface.id);
        const before = Y.encodeStateVector(replica);
        const group = replica.getXmlFragment("document").get(0) as Y.XmlElement;
        const container = new Y.XmlElement("blockContainer");
        container.setAttribute("id", "future-block");
        container.insert(0, [new Y.XmlElement("futureBlock")]);
        group.insert(group.length, [container]);
        await client.sendSurfaceDocumentUpdate(surface.id, {
            update: Buffer.from(Y.encodeStateAsUpdate(replica, before)).toString("base64"),
            mutationId: "future",
        });
        const stored = (await client.getSurfaceDocument(surface.id)).document;
        expect(stored).toMatchObject({ text: "Kept\n", seq: 2 });

        calls.push({
            name: "update_document",
            arguments: { tabId: surface.id, seq: 2, text: "Replaced\n" },
        });
        await gym.send("Replace the document.", { permissionMode: "full_access" });
        expect(gym.inference.toolResults().at(-1)!.text).toContain(
            "This document contains content this version of Happy cannot represent",
        );
        expect((await client.getSurfaceDocument(surface.id)).document).toEqual(stored);
        // The unknown block is stored and served unchanged.
        const state = new Y.Doc();
        Y.applyUpdate(
            state,
            Buffer.from((await client.getSurfaceDocumentState(surface.id)).update, "base64"),
        );
        expect(state.getXmlFragment("document").toString().toLowerCase()).toContain("<futureblock");
        expect(gym.inference.unscripted).toEqual([]);
    });
});
