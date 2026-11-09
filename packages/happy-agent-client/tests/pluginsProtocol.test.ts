import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentClient,
    availablePluginListResponseSchema,
    availablePluginSchema,
    globalSkillSchema,
    installPluginRequestSchema,
    pluginIdSchema,
    pluginInstallationListResponseSchema,
    pluginInstallationSchema,
    pluginsUpdatedPayloadSchema,
    type AvailablePlugin,
    type HappyAgentEvent,
    type PluginInstallation,
} from "../sources/index.js";

const cursor = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const installation: PluginInstallation = {
    id: "p1a2b3c4",
    pluginId: "nvidia-skills",
    version: "1.0.0",
    name: "NVIDIA Skills",
    description: "Skills for building with NVIDIA tools.",
    status: "installing",
    error: null,
    path: "/Users/me/Happy/Plugins/nvidia-skills",
    createdAt: 1_755_400_000_000,
    updatedAt: 1_755_400_000_000,
};
const available: AvailablePlugin = {
    pluginId: "nvidia-skills",
    version: "1.0.0",
    name: "NVIDIA Skills",
    description: "Skills for building with NVIDIA tools.",
    kind: "external",
    multiInstance: false,
    installable: true,
    reason: null,
    manifest: { id: "nvidia-skills", version: "1.0.0", skills: "skills", future: { a: 1 } },
};

describe("plugins protocol", () => {
    it("accepts installations, catalog entries, and their list responses", () => {
        expect(Value.Check(pluginInstallationSchema, installation)).toBe(true);
        for (const status of ["installed", "failed"] as const)
            expect(Value.Check(pluginInstallationSchema, { ...installation, status })).toBe(true);
        expect(Value.Check(pluginInstallationSchema, { ...installation, status: "global" })).toBe(
            false,
        );
        expect(
            Value.Check(pluginInstallationListResponseSchema, {
                plugins: [installation],
                cursor,
            }),
        ).toBe(true);
        expect(Value.Check(availablePluginSchema, available)).toBe(true);
        expect(
            Value.Check(availablePluginSchema, {
                ...available,
                kind: "internal",
                installable: false,
                reason: "This plugin runs code, which Happy Agent cannot install yet.",
            }),
        ).toBe(true);
        expect(
            Value.Check(availablePluginListResponseSchema, {
                plugins: [available],
                catalogUrl: "https://slopus.github.io/happy-plugins/catalog.json",
                fetchedAt: 1,
            }),
        ).toBe(true);
        // New daemon fields must not break older consumers of these shapes.
        expect(Value.Check(pluginInstallationSchema, { ...installation, future: true })).toBe(true);
    });

    it("requires a kebab-case plugin ID and a version to install", () => {
        expect(Value.Check(pluginIdSchema, "nvidia-skills")).toBe(true);
        for (const id of ["", "NVIDIA", "a_b", "-a", "a-", "a--b", "a/b"])
            expect(Value.Check(pluginIdSchema, id)).toBe(false);
        expect(
            Value.Check(installPluginRequestSchema, {
                pluginId: "nvidia-skills",
                version: "1.0.0",
                mutationId: "m",
            }),
        ).toBe(true);
        expect(Value.Check(installPluginRequestSchema, { pluginId: "nvidia-skills" })).toBe(false);
    });

    it("attributes global skills to plugins optionally", () => {
        const skill = {
            id: "s1a2b3c4",
            path: "nvidia-skills/cuda",
            name: "cuda",
            description: "Write CUDA kernels.",
            enabled: true,
            status: "ready",
            error: null,
            version: cursor,
            updatedAt: 1,
        };
        expect(Value.Check(globalSkillSchema, skill)).toBe(true);
        expect(Value.Check(globalSkillSchema, { ...skill, plugin: null })).toBe(true);
        expect(
            Value.Check(globalSkillSchema, {
                ...skill,
                plugin: {
                    installationId: installation.id,
                    pluginId: "nvidia-skills",
                    name: "NVIDIA Skills",
                },
            }),
        ).toBe(true);
        expect(Value.Check(globalSkillSchema, { ...skill, plugin: { pluginId: "x" } })).toBe(false);
    });

    it("bounds the invalidation event", () => {
        expect(
            Value.Check(pluginsUpdatedPayloadSchema, {
                installationIds: [installation.id],
                mutationId: "m",
            }),
        ).toBe(true);
        expect(Value.Check(pluginsUpdatedPayloadSchema, { installationIds: null })).toBe(true);
        expect(
            Value.Check(pluginsUpdatedPayloadSchema, {
                installationIds: Array.from({ length: 101 }, () => "p"),
            }),
        ).toBe(false);
        const event: HappyAgentEvent = {
            cursor,
            type: "plugins.updated",
            occurredAt: 1,
            payload: { installationIds: null },
        };
        expect(event.type).toBe("plugins.updated");
    });

    it("sends list, catalog, install, and uninstall requests", async () => {
        const requests: { url: string; init: RequestInit | undefined }[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://daemon/prefix",
            token: "token",
            fetch: async (input, init) => {
                requests.push({ url: input.toString(), init });
                const url = new URL(input.toString());
                if (init?.method === "POST")
                    return Response.json({ plugin: installation }, { status: 202 });
                if (init?.method === "DELETE") return Response.json({ plugin: installation });
                if (url.pathname.endsWith("/available"))
                    return Response.json({
                        plugins: [available],
                        catalogUrl: "https://catalog",
                        fetchedAt: 1,
                    });
                return Response.json({ plugins: [installation], cursor });
            },
        });
        await expect(client.listPlugins()).resolves.toEqual({ plugins: [installation], cursor });
        await expect(client.listAvailablePlugins()).resolves.toMatchObject({
            plugins: [available],
        });
        await expect(
            client.installPlugin({ pluginId: "nvidia-skills", version: "1.0.0", mutationId: "m" }),
        ).resolves.toEqual({ plugin: installation });
        await expect(client.uninstallPlugin(installation.id)).resolves.toEqual({
            plugin: installation,
        });
        expect(requests.map(({ url, init }) => `${init?.method} ${new URL(url).pathname}`)).toEqual(
            [
                "GET /prefix/v0/plugins",
                "GET /prefix/v0/plugins/available",
                "POST /prefix/v0/plugins",
                `DELETE /prefix/v0/plugins/${installation.id}`,
            ],
        );
        expect(requests[2]!.init?.body).toBe(
            JSON.stringify({ pluginId: "nvidia-skills", version: "1.0.0", mutationId: "m" }),
        );
        expect(requests[3]!.init?.body).toBe("{}");
    });

    it.each([
        { status: 404, code: "not_found" },
        { status: 501, code: "unsupported" },
    ])(
        "reports unavailable plugins ($status) as an error, not as nothing installed",
        async ({ status, code }) => {
            const client = new HappyAgentClient({
                endpoint: "http://daemon",
                token: "t",
                fetch: async () =>
                    Response.json({ error: "Plugins are unavailable.", code }, { status }),
            });
            await expect(client.listPlugins()).rejects.toMatchObject({ status, code });
        },
    );

    it("keeps a single-instance conflict's existing installation", async () => {
        const client = new HappyAgentClient({
            endpoint: "http://daemon",
            token: "t",
            fetch: async () =>
                Response.json(
                    {
                        error: "NVIDIA Skills is already installed.",
                        code: "already_installed",
                        plugin: installation,
                    },
                    { status: 409 },
                ),
        });
        await expect(
            client.installPlugin({ pluginId: "nvidia-skills", version: "1.0.0" }),
        ).rejects.toMatchObject({
            status: 409,
            code: "already_installed",
            body: { plugin: installation },
        });
    });
});
