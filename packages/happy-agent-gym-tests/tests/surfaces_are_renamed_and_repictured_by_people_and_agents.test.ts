import { join } from "node:path";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

// Real, tiny PNG fixtures; decoding and normalization run in the daemon.
const white =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const red =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

describe("Surface names and pictures change after creation", () => {
    it("renames and repictures through the API, announcing each change once", async () => {
        const gym = await createAgentGym({ permissionMode: "full_access", timeoutMs: 20000 });
        running.push(gym);
        const client = gym.client;
        expect((await client.getHealth()).capabilities?.surfaceEditing).toBe(true);
        const created = (await client.createSurface({ type: "todo", name: "Libraries" })).surface;
        const cursor = (await client.getEvents({ limit: 1 })).latestCursor;

        const renamed = (
            await client.updateSurface(created.id, {
                name: "Interesting Libraries",
                mutationId: "rename",
            })
        ).surface;
        expect(renamed).toEqual({
            ...created,
            name: "Interesting Libraries",
            updatedAt: expect.any(Number),
            version: expect.any(String),
        });
        expect(renamed.version).not.toBe(created.version);

        const pictured = (await client.updateSurface(created.id, { image: { data: white } }))
            .surface;
        expect(pictured.image?.thumbhash.length).toBeGreaterThan(0);
        const first = (await client.getSurfaceImage(created.id))!;
        expect(first.contentType).toBe("image/webp");
        expect(
            (await client.updateSurface(created.id, { name: renamed.name, image: { data: white } }))
                .surface,
        ).toEqual(pictured);
        const repictured = (await client.updateSurface(created.id, { image: { data: red } }))
            .surface;
        expect((await client.getSurfaceImage(created.id))!.etag).not.toBe(first.etag);

        const cleared = (await client.updateSurface(created.id, { image: null })).surface;
        expect(cleared.image).toBeNull();
        await expect(client.getSurfaceImage(created.id)).rejects.toMatchObject({ status: 404 });
        expect((await client.updateSurface(created.id, { image: null })).surface).toEqual(cleared);

        for (const body of [{}, { mutationId: "only" }, { name: "" }, { image: { data: "bm90" } }])
            expect(await gym.http.patch(`/v0/surfaces/${created.id}`, body)).toMatchObject({
                status: 400,
            });
        expect(
            await gym.http.patch("/v0/surfaces/s12345678901234567890123", { name: "Missing" }),
        ).toMatchObject({ status: 404 });
        expect(await gym.http.patch("/v0/surfaces/todo", { name: "Route" })).toMatchObject({
            status: 404,
        });

        const updates = await gym.waitUntil(async () => {
            const events = (await client.getEvents({ after: cursor, limit: 100 })).events.filter(
                (event) => event.type === "surface.updated",
            );
            return events.length === 4 ? events.map((event) => event.payload) : undefined;
        }, "the Surface edit events");
        expect(updates).toEqual([
            {
                surfaceId: created.id,
                previousVersion: created.version,
                version: renamed.version,
                changes: {
                    members: created.members,
                    updatedAt: renamed.updatedAt,
                    name: "Interesting Libraries",
                },
                mutationId: "rename",
            },
            expect.objectContaining({
                version: pictured.version,
                changes: expect.objectContaining({ image: pictured.image }),
            }),
            expect.objectContaining({
                version: repictured.version,
                changes: expect.objectContaining({ image: repictured.image }),
            }),
            expect.objectContaining({
                version: cleared.version,
                changes: expect.objectContaining({ image: null }),
            }),
        ]);
        expect(updates.slice(1).some((payload) => "name" in payload.changes)).toBe(false);

        await gym.restart();
        expect((await gym.client.listSurfaces()).surfaces).toEqual([cleared]);
        expect(gym.errors).toEqual([]);
    });

    it.each(["allow", "deny"] as const)(
        "lets an ordinary agent rename and repicture a Surface when Auto review says %s",
        async (outcome) => {
            let surfaceId = "";
            let path = "";
            let called = false;
            const reviews: string[] = [];
            const gym = await createAgentGym({
                permissionMode: "auto",
                files: { "icon.png": Buffer.from(white, "base64") },
                inference(request) {
                    if (request.sessionId.startsWith("naming:"))
                        return { content: [{ type: "text", text: "<title>Icon</title>" }] };
                    if (request.sessionId !== gym.defaultSessionId) {
                        reviews.push(JSON.stringify(request.messages));
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `<review><outcome>${outcome}</outcome><risk>low</risk><user_authorization>high</user_authorization><rationale>Scripted permission decision.</rationale></review>`,
                                },
                            ],
                        };
                    }
                    if (called) return { content: [{ type: "text", text: "Finished." }] };
                    called = true;
                    return {
                        content: [
                            {
                                type: "tool_call",
                                name: "update_tab",
                                arguments: {
                                    tabId: surfaceId,
                                    name: "Interesting Libraries",
                                    imagePath: path,
                                },
                            },
                        ],
                    };
                },
            });
            running.push(gym);
            path = join(gym.workspacePath, "icon.png");
            const created = (
                await gym.client.createSurface({ type: "document", name: "Libraries" })
            ).surface;
            surfaceId = created.id;
            await gym.send("Rename the Libraries document and use icon.png as its picture.");

            expect(reviews).toHaveLength(1);
            expect(reviews[0]).toContain("Rename the Libraries document");
            const [surface] = (await gym.client.listSurfaces()).surfaces;
            if (outcome === "deny") {
                expect(surface).toEqual(created);
            } else {
                expect(surface).toMatchObject({
                    name: "Interesting Libraries",
                    image: { thumbhash: expect.any(String) },
                    members: created.members,
                });
                expect((await gym.client.getSurfaceImage(created.id))!.contentType).toBe(
                    "image/webp",
                );
            }
            expect(gym.errors).toEqual([]);
        },
    );
});
