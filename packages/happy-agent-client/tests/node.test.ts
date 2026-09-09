import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentClient,
    configPatchSchema,
    configResponseSchema,
    daemonConfigSchema,
    desktopBootstrapResponseSchema,
    nodeConfigSchema,
    type HappyAgentEvent,
    type NodeConfig,
} from "../sources/index.js";

const cursor = "01900000-0000-7000-8000-000000000001";
const thumbhash = "3OcRJYB4d3h3iIeHeEh3eIhw+j2w";
const withoutAvatar = {
    name: "Steve's Mac 💻",
    avatar: null,
} satisfies NodeConfig;
const withAvatar = {
    ...withoutAvatar,
    avatar: { thumbhash },
} satisfies NodeConfig;

const config = { ...Value.Create(daemonConfigSchema), node: withAvatar };

describe("node configuration schemas", () => {
    it.each([withoutAvatar, withAvatar])("accepts nullable avatar metadata %#", (node) => {
        expect(Value.Check(nodeConfigSchema, node)).toBe(true);
        expect(Value.Check(configResponseSchema, { config: { ...config, node } })).toBe(true);
    });

    it.each([
        { ...withoutAvatar, avatar: true },
        { ...withAvatar, avatar: "image" },
        { ...withAvatar, avatar: {} },
        { ...withAvatar, avatar: { thumbhash: "" } },
        { ...withoutAvatar, name: "" },
        { ...withoutAvatar, name: "Mac\nInjected row" },
        { ...withoutAvatar, name: "a".repeat(129) },
        { ...withoutAvatar, avatar: undefined },
        { name: "Mac" },
    ])("rejects inconsistent or incomplete information %#", (node) => {
        expect(Value.Check(nodeConfigSchema, node)).toBe(false);
        expect(Value.Check(configResponseSchema, { config: { ...config, node } })).toBe(false);
    });

    it("includes node only within config and permits older config and bootstrap responses", () => {
        const bootstrapConfigSchema = Type.Pick(desktopBootstrapResponseSchema, ["config"]);
        const olderConfig = Value.Create(daemonConfigSchema);
        expect(Value.Check(configResponseSchema, { config: olderConfig })).toBe(true);
        expect(Value.Check(bootstrapConfigSchema, { config: olderConfig })).toBe(true);
        expect(Value.Check(bootstrapConfigSchema, { config })).toBe(true);
        expect(
            Value.Check(bootstrapConfigSchema, { config: { ...config, node: withoutAvatar } }),
        ).toBe(true);
        expect(Value.Check(bootstrapConfigSchema, { config: { ...config, node: null } })).toBe(
            false,
        );
        expect(desktopBootstrapResponseSchema.properties).not.toHaveProperty("node");
        expect(nodeConfigSchema.properties).not.toHaveProperty("version");
        expect(nodeConfigSchema.properties).not.toHaveProperty("hasAvatar");
    });

    it("reads avatar metadata directly from its nullable value", () => {
        const placeholder = (node: NodeConfig): string | null => node.avatar?.thumbhash ?? null;
        expect(placeholder(withAvatar)).toBe(thumbhash);
        expect(placeholder(withoutAvatar)).toBeNull();
    });

    it("accepts name config patches without permitting avatar metadata writes", () => {
        expect(Value.Check(configPatchSchema, {})).toBe(true);
        expect(Value.Check(configPatchSchema, { node: {} })).toBe(true);
        expect(Value.Check(configPatchSchema, { node: { name: "Studio Mac" } })).toBe(true);
        expect(Value.Check(configPatchSchema, { node: { name: "" } })).toBe(false);
        expect(Value.Check(configPatchSchema, { node: { p2p: { name: "Peer" } } })).toBe(false);
        expect(Value.Check(configPatchSchema, { node: { avatar: null } })).toBe(false);
        expect(Value.Check(configPatchSchema, { node: { avatar: { thumbhash } } })).toBe(false);
        expect(Value.Check(configPatchSchema, { p2p: { name: "Peer" } })).toBe(true);
    });
});

describe("node client", () => {
    it("reads node through authenticated remote config with cancellation", async () => {
        const controller = new AbortController();
        const client = new HappyAgentClient({
            endpoint: "http://main/prefix?key=transport",
            token: "main-token",
            fetch: async (input, init) => {
                expect(input.toString()).toBe(
                    "http://main/prefix/v0/connections/build-mac/api/v0/config?key=transport",
                );
                expect(init?.method).toBe("GET");
                expect(new Headers(init?.headers).get("authorization")).toBe("Bearer main-token");
                expect(init?.signal).toBe(controller.signal);
                return Response.json({ config });
            },
        });
        await expect(
            client.connection("build-mac").getConfig({ signal: controller.signal }),
        ).resolves.toEqual({ config });
    });

    it("serves image bytes and content metadata using the shared conditional request path", async () => {
        const controller = new AbortController();
        const bytes = new Uint8Array([137, 80, 78, 71]);
        const client = new HappyAgentClient({
            endpoint: "http://main/prefix?key=transport",
            token: "main-token",
            fetch: async (input, init) => {
                expect(input.toString()).toBe("http://main/prefix/v0/node/avatar?key=transport");
                expect(init?.method).toBe("GET");
                expect(init?.signal).toBe(controller.signal);
                const headers = new Headers(init?.headers);
                expect(headers.get("authorization")).toBe("Bearer main-token");
                expect(headers.get("if-none-match")).toBe('"old-image"');
                return new Response(bytes, {
                    headers: { "content-type": "image/png", etag: '"new-image"' },
                });
            },
        });
        const image = await client.getNodeAvatar({
            ifNoneMatch: '"old-image"',
            signal: controller.signal,
        });
        expect(image?.contentType).toBe("image/png");
        expect(image?.etag).toBe('"new-image"');
        expect(new Uint8Array(image!.data)).toEqual(bytes);
    });

    it("returns null for an unchanged image", async () => {
        const client = new HappyAgentClient({
            endpoint: "http://main",
            token: "t",
            fetch: async (_input, init) => {
                expect(new Headers(init?.headers).get("if-none-match")).toBe('"image"');
                return new Response(null, { status: 304 });
            },
        });
        await expect(client.getNodeAvatar({ ifNoneMatch: '"image"' })).resolves.toBeNull();
    });

    it.each([401, 404, 503])("preserves HTTP %i errors without retrying", async (status) => {
        const code = status === 401 ? "unauthorized" : status === 404 ? "not_found" : "internal";
        let requests = 0;
        const client = new HappyAgentClient({
            endpoint: "http://main",
            token: "t",
            fetch: async () => {
                requests++;
                return Response.json(
                    { code, error: "The request could not be completed." },
                    { status },
                );
            },
        });
        await expect(client.getConfig()).rejects.toMatchObject({ status, code });
        await expect(client.getNodeAvatar({ ifNoneMatch: '"removed"' })).rejects.toMatchObject({
            status,
            code,
        });
        expect(requests).toBe(2);
    });

    it("sets the daemon name through config without changing P2P or requiring a version", async () => {
        const controller = new AbortController();
        const request = { node: { name: "Studio Mac" } };
        const renamed = { ...config, node: { ...withAvatar, name: request.node.name } };
        const client = new HappyAgentClient({
            endpoint: "http://main",
            token: "t",
            fetch: async (input, init) => {
                expect(input.toString()).toBe("http://main/v0/config");
                expect(init?.method).toBe("PATCH");
                expect(init?.signal).toBe(controller.signal);
                expect(new Headers(init?.headers).get("authorization")).toBe("Bearer t");
                expect(new Headers(init?.headers).has("if-match")).toBe(false);
                expect(JSON.parse(init?.body as string)).toEqual(request);
                return Response.json({ config: renamed });
            },
        });
        await expect(client.patchConfig(request, { signal: controller.signal })).resolves.toEqual({
            config: renamed,
        });
    });

    it("preserves name mutation denials without retrying", async () => {
        let requests = 0;
        const denied = {
            code: "forbidden",
            error: "Only the owner can rename this installation.",
        };
        const client = new HappyAgentClient({
            endpoint: "http://main",
            token: "t",
            fetch: async () => {
                requests++;
                return Response.json(denied, { status: 403 });
            },
        });
        await expect(
            client.patchConfig({ node: { name: "Unauthorized rename" } }),
        ).rejects.toMatchObject({ status: 403, code: "forbidden", body: denied });
        expect(requests).toBe(1);
    });

    it("uses config invalidations after bootstrap and reads the updated node through config", async () => {
        const before = "01900000-0000-7000-8000-000000000000";
        const after = "01900000-0000-7000-8000-000000000002";
        const event: HappyAgentEvent = {
            cursor,
            type: "config.updated",
            occurredAt: 1,
            payload: {},
        };
        const cleared: HappyAgentEvent = {
            cursor: after,
            type: "config.updated",
            occurredAt: 2,
            payload: {},
        };
        const controller = new AbortController();
        const client = new HappyAgentClient({
            endpoint: "http://main",
            token: "t",
            fetch: async (input) => {
                if (input.toString().endsWith("/v0/bootstrap/desktop")) {
                    return Response.json({ config, cursor: before });
                }
                if (input.toString().endsWith("/v0/config")) {
                    return Response.json({ config: { ...config, node: withoutAvatar } });
                }
                expect(input.toString()).toBe(`http://main/v0/events/stream?after=${before}`);
                return new Response(
                    `event: hello\ndata: ${JSON.stringify({ cursor: after, gap: false, resumed: true, connectedAt: 1 })}\n\n` +
                        [event, event, cleared]
                            .map(
                                (item) =>
                                    `id: ${item.cursor}\nevent: config.updated\ndata: ${JSON.stringify(item)}\n\n`,
                            )
                            .join(""),
                    { headers: { "content-type": "text/event-stream" } },
                );
            },
        });
        const bootstrap = await client.getDesktopBootstrap();
        expect(bootstrap.config.node).toEqual(withAvatar);
        const updates = client.updates({ after: bootstrap.cursor, signal: controller.signal });
        try {
            await expect(updates.next()).resolves.toMatchObject({
                value: { kind: "connected", cursor: before },
            });
            await expect(updates.next()).resolves.toMatchObject({
                value: { kind: "event", event },
            });
            await expect(updates.next()).resolves.toMatchObject({
                value: { kind: "event", event: cleared },
            });
            await expect(client.getConfig()).resolves.toEqual({
                config: { ...config, node: withoutAvatar },
            });
        } finally {
            controller.abort();
            await updates.return(undefined);
        }
    });
});
