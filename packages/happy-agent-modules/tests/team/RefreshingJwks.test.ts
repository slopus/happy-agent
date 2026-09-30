import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, type CryptoKey, type JWK } from "jose";
import { describe, expect, it } from "vitest";

import { RefreshingJwks } from "../../sources/team/RefreshingJwks.js";

const URL = "https://sso.acme.example/.well-known/jwks.json";

async function signingKey(kid: string): Promise<{ privateKey: CryptoKey; jwk: JWK }> {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: "ES256" } };
}

async function sign(privateKey: CryptoKey, kid: string): Promise<string> {
    return await new SignJWT({ sub: "person-1" })
        .setProtectedHeader({ alg: "ES256", kid })
        .setExpirationTime("5m")
        .sign(privateKey);
}

/** A JWKS endpoint whose answer the test controls, counting downloads. */
function endpoint(initial: () => Response) {
    let answer = initial;
    const requests: RequestInit[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
        expect(String(input)).toBe(URL);
        requests.push(init ?? {});
        return answer();
    };
    return {
        fetch,
        requests,
        answer(next: () => Response) {
            answer = next;
        },
    };
}

const jwks =
    (...keys: JWK[]) =>
    () =>
        Response.json({ keys });

describe("RefreshingJwks", () => {
    it("downloads on first use and verifies with the downloaded key", async () => {
        const a = await signingKey("a");
        const server = endpoint(jwks(a.jwk));
        const set = new RefreshingJwks({ url: URL, intervalMs: 3_600_000, fetch: server.fetch });

        const { payload } = await jwtVerify(await sign(a.privateKey, "a"), set.getKey);

        expect(payload.sub).toBe("person-1");
        expect(server.requests).toHaveLength(1);
        expect(server.requests[0]).toMatchObject({
            headers: { accept: "application/json" },
            redirect: "error",
        });
        await jwtVerify(await sign(a.privateKey, "a"), set.getKey);
        expect(server.requests).toHaveLength(1);
    });

    it("picks up a rotated key at once but downloads at most every 30 seconds", async () => {
        const a = await signingKey("a");
        const b = await signingKey("b");
        const c = await signingKey("c");
        const server = endpoint(jwks(a.jwk));
        let now = 1_000_000;
        const set = new RefreshingJwks({
            url: URL,
            intervalMs: 3_600_000,
            fetch: server.fetch,
            now: () => now,
        });
        await set.refresh();

        server.answer(jwks(a.jwk, b.jwk));
        await expect(jwtVerify(await sign(b.privateKey, "b"), set.getKey)).resolves.toBeDefined();
        expect(server.requests).toHaveLength(2);

        server.answer(jwks(a.jwk, b.jwk, c.jwk));
        now += 10_000;
        await expect(jwtVerify(await sign(c.privateKey, "c"), set.getKey)).rejects.toThrow();
        expect(server.requests).toHaveLength(2);

        now += 30_000;
        await expect(jwtVerify(await sign(c.privateKey, "c"), set.getKey)).resolves.toBeDefined();
        expect(server.requests).toHaveLength(3);
    });

    it("stops accepting a key once a download removes it", async () => {
        const a = await signingKey("a");
        const b = await signingKey("b");
        const server = endpoint(jwks(a.jwk, b.jwk));
        const set = new RefreshingJwks({ url: URL, intervalMs: 3_600_000, fetch: server.fetch });
        await set.refresh();
        const token = await sign(a.privateKey, "a");
        await expect(jwtVerify(token, set.getKey)).resolves.toBeDefined();

        server.answer(jwks(b.jwk));
        expect(await set.refresh()).toBe(true);

        await expect(jwtVerify(token, set.getKey)).rejects.toThrow();
    });

    it.each([
        ["an error status", () => new Response("no", { status: 500 })],
        ["invalid JSON", () => new Response("{")],
        ["a non-JWKS document", () => Response.json({ keys: "nope" })],
        [
            "more than 100 keys",
            () => Response.json({ keys: Array.from({ length: 101 }, () => ({ kty: "EC" })) }),
        ],
        ["more than 1 MiB", () => new Response("x".repeat(1_048_577))],
        [
            "a network failure",
            () => {
                throw new TypeError("offline");
            },
        ],
    ])("keeps the last good set after %s", async (_name, failure) => {
        const a = await signingKey("a");
        const server = endpoint(jwks(a.jwk));
        const set = new RefreshingJwks({ url: URL, intervalMs: 3_600_000, fetch: server.fetch });
        expect(await set.refresh()).toBe(true);

        server.answer(failure);
        expect(await set.refresh()).toBe(false);

        await expect(jwtVerify(await sign(a.privateKey, "a"), set.getKey)).resolves.toBeDefined();
    });

    it("rejects every token until a download succeeds", async () => {
        const a = await signingKey("a");
        const server = endpoint(() => new Response("no", { status: 503 }));
        const set = new RefreshingJwks({ url: URL, intervalMs: 3_600_000, fetch: server.fetch });

        await expect(jwtVerify(await sign(a.privateKey, "a"), set.getKey)).rejects.toThrow();
    });

    it("shares one download between concurrent callers", async () => {
        const a = await signingKey("a");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const requests: string[] = [];
        const set = new RefreshingJwks({
            url: URL,
            intervalMs: 3_600_000,
            fetch: async () => {
                requests.push("download");
                await gate;
                return Response.json({ keys: [a.jwk] });
            },
        });
        const token = await sign(a.privateKey, "a");

        const verifications = [jwtVerify(token, set.getKey), set.refresh(), set.refresh()];
        release();
        await Promise.all(verifications);

        expect(requests).toEqual(["download"]);
    });

    it("downloads on its interval, retries sooner after a failure, and stops with its lifetime", async () => {
        const a = await signingKey("a");
        const outcomes = [false, true, true];
        const downloads: boolean[] = [];
        const controller = new AbortController();
        const set = new RefreshingJwks({
            url: URL,
            intervalMs: 5,
            retryAfterFailureMs: 1,
            fetch: async () => {
                const ok = outcomes[downloads.length] ?? true;
                downloads.push(ok);
                if (downloads.length === 3) controller.abort();
                return ok ? Response.json({ keys: [a.jwk] }) : new Response("no", { status: 500 });
            },
        });
        const ctx = withLifetime(createRootContext().named("jwks-test"), controller.signal);

        await set.run(ctx);

        expect(downloads).toEqual([false, true, true]);
        await expect(jwtVerify(await sign(a.privateKey, "a"), set.getKey)).resolves.toBeDefined();
    });
});
