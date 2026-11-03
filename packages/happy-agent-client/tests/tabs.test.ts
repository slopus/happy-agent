import { describe, expect, it } from "vitest";
import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { formatHappyReferenceUrl, parseHappyUrl } from "../sources/happyLinks.js";
import { surfaceSchema } from "../sources/protocol/surfaces.js";
import { tabSchema } from "../sources/protocol/tabs.js";
import { Value } from "@sinclair/typebox/value";
import { createSurfaceRequestSchema } from "../sources/protocol/surfaces.js";

describe("Tabs compatibility", () => {
    it("defaults only canonical monitor creation to owner-scoped reuse and keeps the returned ID", async () => {
        const bodies: unknown[] = [];
        const existing = { surface: { id: "existing-monitor" } };
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "token",
            fetch: async (_input, init) => {
                bodies.push(JSON.parse(String(init?.body)));
                return Response.json(existing);
            },
        });
        const request = {
            type: "system_monitor",
            name: "Monitor",
            id: "abcdefghijklmnopqrstuvwx",
        } as const;
        expect(await client.createTab(request)).toEqual(existing);
        await client.createSurface(request);
        await client.createTab({ ...request, reuseExisting: false });
        expect(bodies).toEqual([
            { ...request, reuseExisting: true },
            request,
            { ...request, reuseExisting: false },
        ]);
        expect(Value.Check(createSurfaceRequestSchema, { ...request, reuseExisting: true })).toBe(
            true,
        );
        expect(Value.Check(createSurfaceRequestSchema, { ...request, reuseExisting: "true" })).toBe(
            false,
        );
        expect(
            Value.Check(createSurfaceRequestSchema, {
                type: "todo",
                name: "List",
                reuseExisting: true,
            }),
        ).toBe(false);
    });
    it("keeps the same wire schema and accepts old and canonical links", () => {
        expect(tabSchema).toBe(surfaceSchema);
        const reference = { kind: "surface", id: "abcdefghijklmnopqrstuvwx" } as const;
        const canonical = formatHappyReferenceUrl(reference);
        expect(canonical).toBe(`happy://tabs/${reference.id}`);
        expect(parseHappyUrl(canonical)).toEqual({ type: "reference", reference });
        expect(parseHappyUrl(`happy://surfaces/${reference.id}`)).toEqual({
            type: "reference",
            reference,
        });
        expect(parseHappyUrl(`happy://abcdefghijklmnopqrstuvwx/tabs/${reference.id}`)).toEqual({
            type: "reference",
            reference,
            instanceId: "abcdefghijklmnopqrstuvwx",
        });
        expect(parseHappyUrl(`${canonical}?version=1`)).toBeUndefined();
    });

    it("duplicates namespace requests without translating compatible bodies or responses", async () => {
        const requests: { url: string; method: string; body: string | null; headers: Headers }[] =
            [];
        const response = { surfaces: [], cursor: "cursor" };
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "token",
            fetch: async (input, init) => {
                requests.push({
                    url: input.toString(),
                    method: init?.method ?? "GET",
                    body: typeof init?.body === "string" ? init.body : null,
                    headers: new Headers(init?.headers),
                });
                return Response.json(response);
            },
        });
        expect(await client.listTabs()).toEqual(response);
        expect(await client.listSurfaces()).toEqual(response);
        const tabId = "abcdefghijklmnopqrstuvwx";
        await client.createTab({ type: "todo", name: "Shopping" });
        await client.updateTabTodo(tabId, "todo", { text: "Milk" }, { ifMatch: "version" });
        await client.getTabDocumentState(tabId, { seq: 3 });
        await client.listTabMessages(tabId, { afterSeq: 4 });
        await client.getTabSystemMonitor(tabId);
        await client.listTabCalendarEvents(tabId, { from: 1, to: 2, timeZone: "UTC" });
        expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
            "/v0/tabs",
            "/v0/surfaces",
            "/v0/tabs",
            `/v0/tabs/todo/${tabId}/todo`,
            `/v0/tabs/document/${tabId}/state`,
            `/v0/tabs/chat/${tabId}/messages`,
            `/v0/tabs/system-monitor/${tabId}`,
            `/v0/tabs/calendar/${tabId}`,
        ]);
        expect(requests[2]?.body).toBe(JSON.stringify({ type: "todo", name: "Shopping" }));
        expect(requests[3]?.headers.get("if-match")).toContain("version");
        expect(
            requests.every((request) => request.headers.get("authorization") === "Bearer token"),
        ).toBe(true);
    });
});
