import { describe, expect, it } from "vitest";

import type { RelayTokenDecision } from "../../sources/accountLink/impl/AccountTokenVerifier.js";
import { RelaySession } from "../../sources/accountLink/impl/RelaySession.js";

const WINDOW = 1_048_576;

/** A session whose token check answers only when the test says so. */
function heldSession() {
    const sent: (string | Buffer)[] = [];
    let release!: (decision: RelayTokenDecision) => void;
    const decision = new Promise<RelayTokenDecision>((resolve) => {
        release = resolve;
    });
    let checks = 0;
    const session = new RelaySession(
        (data) => sent.push(data),
        async () => {
            checks += 1;
            return await decision;
        },
        { socketPath: "/nonexistent/agent.sock", tokenPath: "/nonexistent/token" },
        () => undefined,
    );
    session.receive(Buffer.from(JSON.stringify({ t: "hello", v: 1, window: WINDOW })), false);
    return {
        checks: () => checks,
        control: (message: object) => session.receive(Buffer.from(JSON.stringify(message)), false),
        body: (id: number, bytes: number) => {
            const frame = Buffer.alloc(5 + bytes);
            frame.writeUInt8(1, 0);
            frame.writeUInt32BE(id, 1);
            session.receive(frame, true);
        },
        release,
        frames: () => sent.filter((entry): entry is Buffer => typeof entry !== "string"),
        texts: () => sent.filter((entry) => typeof entry === "string"),
    };
}

describe("RelaySession before a request is admitted", () => {
    it("holds at most one window of upload it has not credited and aborts a relay that sends more", () => {
        const held = heldSession();
        held.control({ body: true, h: [], id: 7, m: "POST", p: "/v0/echo", t: "req" });

        for (let sentBytes = 0; sentBytes < WINDOW; sentBytes += 65_536) held.body(7, 65_536);
        expect(held.texts()).toEqual([]);
        held.body(7, 1);

        expect(held.texts()).toEqual([JSON.stringify({ id: 7, t: "abort" })]);
    });

    it("ignores a second request that reuses a live exchange id", () => {
        const held = heldSession();
        held.control({ body: false, h: [], id: 7, m: "GET", p: "/v0/health", t: "req" });
        held.control({ body: false, h: [], id: 7, m: "DELETE", p: "/v0/agents/x", t: "req" });

        expect(held.checks()).toBe(1);
    });

    it("refuses requests beyond its limit of live exchanges without checking them", () => {
        const held = heldSession();
        for (let id = 1; id <= 1_024; id += 1) {
            held.control({ body: false, h: [], id, m: "GET", p: "/v0/health", t: "req" });
        }
        expect(held.checks()).toBe(1_024);

        held.control({ body: false, h: [], id: 5_000, m: "GET", p: "/v0/health", t: "req" });

        expect(held.checks()).toBe(1_024);
        const refusal = held.frames().at(-1)!;
        expect(refusal.readUInt8(0)).toBe(3);
        expect(refusal.readUInt32BE(1)).toBe(5_000);
        expect(refusal.toString("utf8")).toContain('"s":503');
        expect(refusal.toString("utf8")).toContain('{"code":"too_many_requests"}');
    });

    it("serves nothing before hello and nothing after the socket closed", async () => {
        const sent: (string | Buffer)[] = [];
        let checks = 0;
        const session = new RelaySession(
            (data) => sent.push(data),
            async () => {
                checks += 1;
                return { allowed: false, refusal: "unauthenticated" };
            },
            { socketPath: "/nonexistent/agent.sock", tokenPath: "/nonexistent/token" },
            () => undefined,
        );
        const request = Buffer.from(
            JSON.stringify({ body: false, h: [], id: 1, m: "GET", p: "/v0/health", t: "req" }),
        );

        session.receive(request, false);
        session.close();
        session.receive(Buffer.from(JSON.stringify({ t: "hello", v: 1, window: WINDOW })), false);
        session.receive(request, false);
        await new Promise((resolve) => setImmediate(resolve));

        expect(checks).toBe(0);
        expect(sent).toEqual([]);
    });
});
