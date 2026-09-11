import { join } from "node:path";
import {
    createAgentGym,
    createUnixSocketFetch,
    GymHttpClient,
    type AgentGym,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
const cacheControl = "private, max-age=3600, stale-while-revalidate=86400";
const images = [
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAACshmLzAAAARklEQVRIDe3SsQkAMAwDQQVcZP9ZMmDwBF+pe+NS2HDoJO8mvZ293RwfoK5EEqEABmyRRCiAAVskEQpgwBZJhAIYsEVI9AH7IAMiyextiAAAAABJRU5ErkJggg==",
].map((base64) => Uint8Array.from(Buffer.from(base64, "base64")));

afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

describe("project avatar HTTP caching", () => {
    it("allows private cached images and conditional refreshes across replacement and removal", async () => {
        const gym = await createAgentGym({
            files: { "avatar-project/README.md": "Avatar fixture" },
        });
        running.push(gym);
        const { project } = await gym.client.registerProject({
            path: join(gym.workspacePath, "avatar-project"),
        });
        const uploaded = await gym.client.setProjectAvatar(
            project.id,
            { contentType: "image/png", data: images[0]! },
            { ifMatch: project.version },
        );
        const fetch = createUnixSocketFetch(gym.socketPath);
        const url = `http://happy-agent.invalid/v0/projects/${project.id}/avatar`;
        const headers = { authorization: `Bearer ${gym.token}` };
        const image = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
        expect(image.status).toBe(200);
        expect(image.headers.get("cache-control")).toBe(cacheControl);
        expect(image.headers.get("vary")).toBe("Authorization");
        expect(image.headers.get("content-type")).toBe("image/webp");
        expect(image.headers.get("date")).not.toBeNull();
        const etag = image.headers.get("etag")!;
        expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
        const bytes = await image.arrayBuffer();
        expect(bytes.byteLength).toBeGreaterThan(0);
        expect(image.headers.get("content-length")).toBe(String(bytes.byteLength));

        const conditional = { ...headers, "if-none-match": etag };
        const unchanged = await fetch(url, {
            headers: conditional,
            signal: AbortSignal.timeout(10_000),
        });
        expect(unchanged.status).toBe(304);
        expect(unchanged.headers.get("cache-control")).toBe(cacheControl);
        expect(unchanged.headers.get("vary")).toBe("Authorization");
        expect(unchanged.headers.get("etag")).toBe(etag);
        expect(await unchanged.text()).toBe("");

        const replaced = await gym.client.setProjectAvatar(
            project.id,
            { contentType: "image/png", data: images[1]! },
            { ifMatch: uploaded.project.version },
        );
        const changed = await fetch(url, {
            headers: conditional,
            signal: AbortSignal.timeout(10_000),
        });
        expect(changed.status).toBe(200);
        expect(changed.headers.get("cache-control")).toBe(cacheControl);
        expect(changed.headers.get("vary")).toBe("Authorization");
        const newEtag = changed.headers.get("etag")!;
        expect(newEtag).not.toBe(etag);
        expect(await changed.arrayBuffer()).not.toEqual(bytes);

        await gym.client.deleteProjectAvatar(project.id, { ifMatch: replaced.project.version });
        const removed = await fetch(url, {
            headers: { ...headers, "if-none-match": newEtag },
            signal: AbortSignal.timeout(10_000),
        });
        expect(removed.status).toBe(404);
        expect(removed.headers.get("cache-control")).toBe("no-store");
        expect(await removed.json()).toMatchObject({ code: "not_found" });
        expect(gym.errors).toEqual([]);
    });

    it("keeps project JSON, missing avatars and authentication errors non-cacheable", async () => {
        const gym = await createAgentGym({
            files: { "avatar-project/README.md": "Avatar fixture" },
        });
        running.push(gym);
        const { project } = await gym.client.registerProject({
            path: join(gym.workspacePath, "avatar-project"),
        });
        const path = `/v0/projects/${project.id}/avatar`;
        const missing = await gym.raw.get(path);
        expect(missing.status).toBe(404);
        expect(missing.headers["cache-control"]).toBe("no-store");
        await gym.client.setProjectAvatar(
            project.id,
            { contentType: "image/png", data: images[0]! },
            { ifMatch: project.version },
        );
        const unauthorized = new GymHttpClient({ socketPath: gym.socketPath, token: "wrong" });
        const denied = await unauthorized.get(path);
        expect(denied.status).toBe(401);
        expect(denied.headers["cache-control"]).toBe("no-store");
        const json = await gym.raw.get(`/v0/projects/${project.id}`);
        expect(json.status).toBe(200);
        expect(json.headers["cache-control"]).toBe("no-store");
        expect(gym.errors).toEqual([]);
    });
});
