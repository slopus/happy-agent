import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startArtifactDevServer, type ArtifactDevServer } from "../sources/index.js";

/* The SDK is untyped browser code; the test reads it the way a page script would. */
type Happy = any;

const running = new Set<ArtifactDevServer>();
const directories = new Set<string>();
const pages = new Set<AbortController>();
afterEach(async () => {
    for (const page of pages) page.abort();
    pages.clear();
    await Promise.all([...running].map((server) => server.close()));
    running.clear();
    await Promise.all(
        [...directories].map((directory) => rm(directory, { force: true, recursive: true })),
    );
    directories.clear();
});

async function start(
    seed?: Parameters<typeof startArtifactDevServer>[0]["seed"],
    artifactId = "dev",
) {
    const root = await mkdtemp(join(tmpdir(), "happy-artifact-dev-test-"));
    directories.add(root);
    const folder = join(root, "app");
    await mkdir(join(folder, "images"), { recursive: true });
    await writeFile(
        join(folder, "index.html"),
        '<!doctype html><script src="/api/v1/client.js"></script><h1>Board</h1>',
    );
    await writeFile(join(folder, "images", "dot.svg"), "<svg></svg>");
    await writeFile(join(root, "secret.txt"), "not served");
    const server = await startArtifactDevServer({
        folder,
        scratch: join(root, "scratch"),
        host: "127.0.0.1",
        port: 0,
        artifactId,
        ...(seed === undefined ? {} : { seed }),
    });
    running.add(server);
    const as = (name?: string) => (name === undefined ? {} : { "x-happy-dev-user": name });
    const json = async (path: string, init: RequestInit & { as?: string } = {}) => {
        const response = await fetch(`${server.url}${path}`, {
            ...init,
            headers: {
                ...(init.body === undefined ? {} : { "content-type": "application/json" }),
                ...as(init.as),
                ...(init.headers as Record<string, string> | undefined),
            },
        });
        return { status: response.status, body: (await response.json()) as any };
    };
    const control = async (method: string, path: string, body?: unknown) =>
        (
            await json(`/__happy${path}`, {
                method,
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
        ).body;
    return { server, json, control };
}

/** One page of the app as `name`, running the served SDK against the server. */
async function openPage(server: ArtifactDevServer, name: string): Promise<Happy> {
    const controller = new AbortController();
    pages.add(controller);
    const listeners: (() => void)[] = [];
    const pageFetch = async (input: string, init: RequestInit = {}) => {
        if (controller.signal.aborted) throw new TypeError("Failed to fetch");
        const signal =
            init.signal === undefined || init.signal === null
                ? controller.signal
                : AbortSignal.any([init.signal, controller.signal]);
        return await fetch(`${server.url}${input}`, { ...init, signal });
    };
    const script = await (await pageFetch("/api/v1/client.js")).text();
    const window: Record<string, unknown> = {
        fetch: pageFetch,
        crypto: globalThis.crypto,
        navigator: { onLine: true },
        location: {
            search: `?as=${encodeURIComponent(name)}`,
            href: `${server.url}/?as=${encodeURIComponent(name)}`,
        },
        addEventListener: (type: string, listener: () => void) => {
            if (type === "online") listeners.push(listener);
        },
    };
    new Function("window", script)(window);
    const happy = window["happy"] as Happy;
    await happy.ready;
    return happy;
}

async function until<T>(read: () => Promise<T | undefined> | T | undefined, what: string) {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const value = await read();
        if (value !== undefined && value !== false) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

describe("artifact dev server", () => {
    it("serves the folder, and nothing outside it, beside the data API and its controls", async () => {
        const { server } = await start();
        const page = await fetch(`${server.url}/`);
        expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(await page.text()).toContain("<h1>Board</h1>");
        const image = await fetch(`${server.url}/images/dot.svg`);
        expect(image.headers.get("content-type")).toBe("image/svg+xml");
        expect((await fetch(`${server.url}/%2e%2e/secret.txt`)).status).toBe(404);
        expect((await fetch(`${server.url}/missing.html`)).status).toBe(404);
        const client = await fetch(`${server.url}/api/v1/client.js`);
        expect(client.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
        expect(await client.text()).toContain("Happy artifact data SDK");
        // The standard styles, components, and diagram renderer, each revalidated by its ETag.
        for (const [route, type, marker] of [
            ["style.css", "text/css; charset=utf-8", "--happy-chart-6"],
            ["components.js", "text/javascript; charset=utf-8", '"happy-code"'],
            ["diagrams.js", "text/javascript; charset=utf-8", "happyDiagrams"],
        ] as const) {
            const response = await fetch(`${server.url}/api/v1/${route}`);
            expect(response.headers.get("content-type")).toBe(type);
            expect(await response.text()).toContain(marker);
            const etag = response.headers.get("etag")!;
            const again = await fetch(`${server.url}/api/v1/${route}`, {
                headers: { "if-none-match": etag },
            });
            expect(again.status).toBe(304);
        }
        const panel = await fetch(`${server.url}/__happy/`);
        expect(await panel.text()).toContain("Artifact dev server");
    });

    it("makes up people by name, from a header, a cookie, or nobody, each with a photo", async () => {
        const { server, json } = await start();
        const alice = (await json("/api/v1/me", { as: "alice" })).body.user;
        expect(alice).toMatchObject({ kind: "user", name: "Alice", firstName: "Alice" });
        expect(alice.id).toMatch(/^u[a-z0-9]{23}$/);
        const bob = (await json("/api/v1/me", { headers: { cookie: "happy_dev_user=Bob%20Lee" } }))
            .body.user;
        expect(bob).toMatchObject({ name: "Bob Lee", firstName: "Bob", lastName: "Lee" });
        const referred = await json("/api/v1/me", {
            headers: { referer: `${server.url}/?as=Bob%20Lee` },
        });
        expect(referred.body.user.id).toBe(bob.id);
        const you = (await json("/api/v1/me")).body.user;
        expect(you.name).toBe("You");
        expect(new Set([alice.id, bob.id, you.id]).size).toBe(3);
        expect((await json("/api/v1/me", { as: "ALICE" })).body.user.id).toBe(alice.id);

        const photo = await fetch(`${server.url}${alice.photoUrl as string}`);
        expect(photo.headers.get("content-type")).toBe("image/svg+xml");
        expect(await photo.text()).toContain(">A</text>");
        const users = await json(`/api/v1/users?ids=${alice.id as string},${bob.id as string}`);
        expect(users.body.users.map((user: { name: string }) => user.name)).toEqual([
            "Alice",
            "Bob Lee",
        ]);
    });

    it("writes as the caller, and as anyone through the controls", async () => {
        const { json, control } = await start();
        const alice = (await json("/api/v1/me", { as: "Alice" })).body.user;
        const put = await json("/api/v1/kv/entry?key=todo/1", {
            method: "PUT",
            as: "Alice",
            body: JSON.stringify({ value: { title: "Milk" } }),
        });
        expect(put.status).toBe(200);
        expect(put.body.entry.updatedBy).toBe(alice.id);

        const carol = await control("POST", "/data/write", {
            as: "Carol",
            key: "todo/2",
            value: { title: "Eggs" },
        });
        expect(carol.entry.updatedBy).toBe(
            (await control("POST", "/users", { name: "Carol" })).user.id,
        );
        const removed = await control("POST", "/data/write", {
            as: "Carol",
            key: "todo/1",
            delete: true,
        });
        expect(removed.entry.deleted).toBe(true);
        const listed = await json("/api/v1/kv?prefix=todo/");
        expect(listed.body.entries.map((entry: { key: string }) => entry.key)).toEqual(["todo/2"]);
        expect(
            (await control("GET", "/users")).users.map((user: { name: string }) => user.name),
        ).toEqual(["You", "Alice", "Carol"]);
    });

    it("fails, delays, and loses responses on request, and logs every request", async () => {
        const { server, json, control } = await start();
        await control("POST", "/faults", { failNext: 1 });
        expect((await json("/api/v1/kv")).status).toBe(503);
        expect((await json("/api/v1/kv")).status).toBe(200);

        await control("POST", "/faults", { dropNext: 1 });
        const lost = fetch(`${server.url}/api/v1/kv/entry?key=score`, {
            method: "PUT",
            headers: { "content-type": "application/json", "x-happy-dev-user": "Dana" },
            body: JSON.stringify({ value: 7, writeId: "write-1" }),
        });
        await expect(lost).rejects.toThrow();
        // The write happened even though its answer never arrived, so a retry is replayed.
        expect((await json("/api/v1/kv/entry?key=score")).body.entry.value).toBe(7);
        const retried = await json("/api/v1/kv/entry?key=score", {
            method: "PUT",
            as: "Dana",
            body: JSON.stringify({ value: 7, writeId: "write-1" }),
        });
        expect(retried.body.replayed).toBe(true);

        await control("POST", "/faults", { latencyMs: 150 });
        const started = Date.now();
        await json("/api/v1/me");
        expect(Date.now() - started).toBeGreaterThanOrEqual(140);
        await control("POST", "/faults", { latencyMs: 0, offline: true });
        await expect(fetch(`${server.url}/api/v1/kv`)).rejects.toThrow();
        expect((await fetch(`${server.url}/api/v1/client.js`)).status).toBe(200);
        expect((await control("POST", "/faults", { offline: false })).faults).toEqual({
            offline: false,
            latencyMs: 0,
            failNext: 0,
            dropNext: 0,
        });

        const { requests } = await control("GET", "/requests");
        const faults = requests.map((request: { fault: string | null }) => request.fault);
        expect(faults).toContain("failed");
        expect(faults).toContain("dropped");
        expect(faults).toContain("offline");
        expect(requests[0]).toMatchObject({ method: "GET", path: "/api/v1/client.js" });
        expect(
            requests.find((request: { fault: string | null }) => request.fault === "dropped"),
        ).toMatchObject({ method: "PUT", user: "Dana" });
        expect((await control("POST", "/faults", { failNext: -1 })).code).toBe("invalid_request");
    });

    it("cuts change streams on request", async () => {
        const { server, control } = await start();
        const stream = await fetch(`${server.url}/api/v1/kv/events`);
        const reader = stream.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
        await until(async () => (await control("GET", "/state")).streams === 1, "the stream");
        expect((await control("POST", "/streams/cut")).cut).toBe(1);
        await expect(
            (async () => {
                for (;;) if ((await reader.read()).done) return "ended";
            })(),
        ).rejects.toThrow();
    });

    it("seeds, dumps, resets, and loads data, keeping versions and authors", async () => {
        const { json, control } = await start({ values: { "poll/a": 1, "poll/b": 2 } });
        expect((await json("/api/v1/kv?prefix=poll/")).body.entries).toHaveLength(2);
        expect(
            (await control("POST", "/data/seed", { values: { "poll/c": 3 }, as: "Eve" })).written,
        ).toBe(1);
        const dump = await control("GET", "/data");
        expect(dump).toMatchObject({ format: "happy-artifact-data/1", artifactId: "dev" });
        expect(dump.entries.map((entry: { key: string }) => entry.key)).toEqual([
            "poll/a",
            "poll/b",
            "poll/c",
        ]);
        expect(dump.users.map((user: { name: string }) => user.name)).toEqual(["You", "Eve"]);

        const { cursor } = (await json("/api/v1/kv")).body;
        await control("POST", "/data/reset");
        expect((await json("/api/v1/kv")).body).toMatchObject({ entries: [], cursor: null });
        // A cursor from before the reset cannot resume, so pages read the data again.
        expect((await json(`/api/v1/kv/changes?since=${cursor as string}`)).status).toBe(409);

        await control("PUT", "/data", dump);
        const restored = await control("GET", "/data");
        expect(restored.entries).toEqual(dump.entries);
        const next = await json("/api/v1/kv/entry?key=poll/d", {
            method: "PUT",
            body: JSON.stringify({ value: 4 }),
        });
        expect(next.body.entry.version > (cursor as string)).toBe(true);
    });

    it("starts from another artifact's dump under that artifact's ID", async () => {
        const first = await start();
        await first.control("POST", "/data/seed", { values: { note: "hello" }, as: "Frank" });
        const dump = await first.control("GET", "/data");
        const second = await start({ ...dump, artifactId: "a1b2c3" }, "a1b2c3");
        const entry = (await second.json("/api/v1/kv/entry?key=note")).body.entry;
        expect(entry).toEqual(dump.entries[0]);
        const users = await second.json(`/api/v1/users?ids=${entry.updatedBy as string}`);
        expect(users.body.users[0].name).toBe("Frank");
        expect((await second.control("GET", "/state")).artifactId).toBe("a1b2c3");
    });

    it("keeps what pages report in the debug log, by person", async () => {
        const { json, control } = await start();
        const posted = await json("/api/v1/debug/log", {
            method: "POST",
            as: "Gina",
            body: JSON.stringify({
                entries: [
                    { level: "error", source: "uncaught", message: "TypeError: x is undefined" },
                    { level: "info", source: "app", message: "opened", data: { board: 1 } },
                ],
                url: "http://127.0.0.1/?as=Gina",
            }),
        });
        expect(posted.body).toEqual({ accepted: 2, dropped: 0 });
        const errors = await control("GET", "/logs?level=error");
        expect(errors.entries).toHaveLength(1);
        expect(errors.entries[0]).toMatchObject({
            level: "error",
            source: "uncaught",
            user: "Gina",
            version: null,
            url: "http://127.0.0.1/?as=Gina",
        });
        expect((await control("GET", "/logs?user=Gina")).entries).toHaveLength(2);
        await control("DELETE", "/logs");
        expect((await control("GET", "/logs")).entries).toEqual([]);
        expect(
            (
                await json("/api/v1/debug/log", {
                    method: "POST",
                    body: JSON.stringify({ entries: [] }),
                })
            ).status,
        ).toBe(400);
    });

    it("lets the SDK recover from a lost response and an outage without doubling a write", async () => {
        const { server, control } = await start();
        const alice = await openPage(server, "Alice");
        const bob = await openPage(server, "Bob");
        expect(alice.user.name).toBe("Alice");
        const heard: string[] = [];
        bob.kv.onChange((entry: { key: string; value: unknown }) =>
            heard.push(`${entry.key}=${JSON.stringify(entry.value)}`),
        );

        await control("POST", "/faults", { dropNext: 1 });
        const written = await alice.kv.set("score", 1);
        expect(written).toMatchObject({ key: "score", value: 1 });
        await until(() => heard.includes("score=1"), "Bob to hear the write");
        const { requests } = await control("GET", "/requests");
        const puts = requests.filter((request: { method: string }) => request.method === "PUT");
        expect(puts.map((request: { fault: string | null }) => request.fault)).toEqual([
            null,
            "dropped",
        ]);
        const dump = await control("GET", "/data");
        expect(dump.entries).toHaveLength(1);
        expect(dump.entries[0].version).toBe(written.version);

        await control("POST", "/faults", { offline: true });
        await until(() => alice.status === "offline", "Alice to go offline");
        const queued = alice.kv.set("score", 2);
        expect(alice.pending).toBe(1);
        await control("POST", "/faults", { offline: false });
        expect(await queued).toMatchObject({ value: 2 });
        await until(() => heard.includes("score=2"), "Bob to hear the queued write");
        await until(() => alice.status === "online", "Alice to come back online");

        alice.debug.log("finished the round", { round: 1 });
        alice.debug.flush();
        const logs = await until(async () => {
            const page = await control("GET", "/logs?user=Alice");
            return page.entries.some((entry: { source: string }) => entry.source === "app")
                ? page.entries
                : undefined;
        }, "Alice's log entry");
        expect(logs.find((entry: { source: string }) => entry.source === "app")).toMatchObject({
            message: "finished the round",
            data: { round: 1 },
            user: "Alice",
        });
        expect(
            logs.some(
                (entry: { source: string; message: string }) =>
                    entry.source === "sync" && entry.message.includes("change stream ended"),
            ),
        ).toBe(true);
    });
});
