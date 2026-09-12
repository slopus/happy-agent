import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentClient,
    globalSkillDocumentResponseSchema,
    globalSkillFileListResponseSchema,
    globalSkillListResponseSchema,
    globalSkillSchema,
    skillPageQuerySchema,
    skillRelativePathSchema,
    skillsUpdatedPayloadSchema,
    updateGlobalSkillRequestSchema,
    type GlobalSkill,
    type HappyAgentEvent,
} from "../sources/index.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const skill: GlobalSkill = {
    id: "s1a2b3c4",
    path: "code-review",
    name: "code-review",
    description: "Review the current changes.",
    enabled: false,
    status: "ready",
    error: null,
    version,
    updatedAt: 1_755_400_000_000,
};

describe("global skills protocol", () => {
    it("keeps disabled skills installed and returns structured documents", () => {
        expect(Value.Check(globalSkillSchema, skill)).toBe(true);
        expect(
            Value.Check(globalSkillListResponseSchema, {
                skills: [skill],
                nextPageCursor: null,
                cursor: version,
            }),
        ).toBe(true);
        expect(
            Value.Check(globalSkillDocumentResponseSchema, {
                skill,
                content: "---\nname: code-review\n---\nReview the diff.\n",
                instructions: "Review the diff.\n",
            }),
        ).toBe(true);
        for (const status of ["invalid", "unreadable"] as const) {
            expect(
                Value.Check(globalSkillDocumentResponseSchema, {
                    skill: {
                        ...skill,
                        name: "Broken skill",
                        description: "",
                        status,
                        error: "Cannot read this skill.",
                    },
                    content: null,
                    instructions: null,
                }),
            ).toBe(true);
        }
        expect(Value.Check(globalSkillSchema, { ...skill, status: "deleted" })).toBe(false);
        expect(Value.Check(globalSkillSchema, { ...skill, enabled: "false" })).toBe(false);
        // New daemon fields must not break older consumers of this shape.
        expect(Value.Check(globalSkillSchema, { ...skill, futureMetadata: true })).toBe(true);
        expect(
            Value.Check(updateGlobalSkillRequestSchema, { enabled: false, mutationId: "toggle" }),
        ).toBe(true);
        expect(Value.Check(updateGlobalSkillRequestSchema, {})).toBe(false);
    });

    it.each([
        "",
        "/etc/passwd",
        "../secret",
        "a/../secret",
        "a/..",
        "./a",
        "a/.",
        "a//b",
        "a/",
        "C:/private",
        "a\\b",
        "a\u0000b",
    ])("rejects non-relative skill path %j", (path) => {
        expect(Value.Check(skillRelativePathSchema, path)).toBe(false);
    });

    it.each([
        "SKILL.md",
        "references/file with spaces.md",
        "images/日本語.png",
        "a..b/file",
        ".../file",
    ])("accepts a normalized relative path %j", (path) => {
        expect(Value.Check(skillRelativePathSchema, path)).toBe(true);
    });

    it("bounds pagination, file records, and invalidations", () => {
        expect(Value.Check(skillPageQuerySchema, {})).toBe(true);
        expect(Value.Check(skillPageQuerySchema, { limit: 100, pageCursor: "opaque" })).toBe(true);
        for (const limit of [0, -1, 101, 1.5]) {
            expect(Value.Check(skillPageQuerySchema, { limit })).toBe(false);
        }
        expect(Value.Check(skillPageQuerySchema, { pageCursor: "x".repeat(513) })).toBe(false);
        expect(
            Value.Check(globalSkillListResponseSchema, {
                skills: Array.from({ length: 101 }, () => skill),
                nextPageCursor: null,
                cursor: version,
            }),
        ).toBe(false);
        const files = {
            files: [{ path: "SKILL.md", size: 100, modifiedAt: 1 }],
            nextPageCursor: null,
            version,
        };
        expect(Value.Check(globalSkillFileListResponseSchema, files)).toBe(true);
        expect(
            Value.Check(globalSkillFileListResponseSchema, {
                ...files,
                files: [{ path: "x", size: -1, modifiedAt: 1 }],
            }),
        ).toBe(false);
        expect(
            Value.Check(skillsUpdatedPayloadSchema, {
                skillIds: [skill.id],
                paths: [],
                mutationId: "toggle",
            }),
        ).toBe(true);
        expect(Value.Check(skillsUpdatedPayloadSchema, { skillIds: null, paths: null })).toBe(true);
        expect(
            Value.Check(skillsUpdatedPayloadSchema, {
                skillIds: [],
                paths: Array.from({ length: 101 }, () => "x"),
            }),
        ).toBe(false);
        expect(Value.Check(skillsUpdatedPayloadSchema, {})).toBe(false);
    });

    it("sends paged reads, parsed document reads, versioned toggles, and binary file reads", async () => {
        const requests: { url: string; init: RequestInit | undefined }[] = [];
        const document = { skill, content: "body", instructions: "body" };
        const controller = new AbortController();
        const client = new HappyAgentClient({
            endpoint: "http://daemon/prefix?transport=key",
            token: "token",
            fetch: async (input, init) => {
                requests.push({ url: input.toString(), init });
                const url = new URL(input.toString());
                if (url.pathname.endsWith("/file")) {
                    return new Response(new Uint8Array([0, 255, 128]), {
                        headers: { "content-type": "application/octet-stream" },
                    });
                }
                if (init?.method === "PATCH") return Response.json({ skill });
                if (url.pathname.endsWith("/files"))
                    return Response.json({ files: [], nextPageCursor: null, version });
                if (url.pathname.endsWith("/skills"))
                    return Response.json({
                        skills: [skill],
                        nextPageCursor: "page/2",
                        cursor: version,
                    });
                return Response.json(document);
            },
        });
        await expect(
            client.listGlobalSkills(
                { limit: 2, pageCursor: "page/1" },
                { signal: controller.signal },
            ),
        ).resolves.toMatchObject({ skills: [skill], nextPageCursor: "page/2" });
        await expect(client.getGlobalSkill(skill.id)).resolves.toEqual(document);
        await expect(
            client.updateGlobalSkill(
                skill.id,
                { enabled: false, mutationId: "toggle" },
                { ifMatch: version },
            ),
        ).resolves.toEqual({ skill });
        await expect(client.listGlobalSkillFiles(skill.id, { limit: 1 })).resolves.toEqual({
            files: [],
            nextPageCursor: null,
            version,
        });
        const binary = await client.readGlobalSkillFile(skill.id, "assets/a #?.png");
        expect([...new Uint8Array(binary.data)]).toEqual([0, 255, 128]);
        expect(binary.contentType).toBe("application/octet-stream");
        expect(binary.etag).toBeNull();
        expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
            "/prefix/v0/skills",
            `/prefix/v0/skills/${skill.id}`,
            `/prefix/v0/skills/${skill.id}`,
            `/prefix/v0/skills/${skill.id}/files`,
            `/prefix/v0/skills/${skill.id}/file`,
        ]);
        expect(new URL(requests[0]!.url).searchParams.get("pageCursor")).toBe("page/1");
        expect(new URL(requests[0]!.url).searchParams.get("limit")).toBe("2");
        expect(requests[0]!.init?.signal).toBe(controller.signal);
        expect(new URL(requests[4]!.url).searchParams.get("path")).toBe("assets/a #?.png");
        expect(new Headers(requests[4]!.init?.headers).get("accept")).toBe(
            "application/octet-stream",
        );
        expect(new Headers(requests[2]!.init?.headers).get("if-match")).toBe(version);
        expect(requests[2]!.init?.body).toBe(
            JSON.stringify({ enabled: false, mutationId: "toggle" }),
        );
        for (const request of requests) {
            expect(new URL(request.url).searchParams.get("transport")).toBe("key");
            expect(new Headers(request.init?.headers).get("authorization")).toBe("Bearer token");
        }
    });

    it("preserves conflict details and does not retry a rejected toggle", async () => {
        let calls = 0;
        const current = { ...skill, enabled: true, version: nextVersion };
        const client = new HappyAgentClient({
            endpoint: "http://daemon",
            token: "t",
            fetch: async () => {
                calls += 1;
                return Response.json(
                    {
                        error: "The skill has changed.",
                        code: "conflict",
                        currentVersion: nextVersion,
                        skill: current,
                    },
                    { status: 409 },
                );
            },
        });
        await expect(
            client.updateGlobalSkill(skill.id, { enabled: false }, { ifMatch: version }),
        ).rejects.toMatchObject({
            status: 409,
            code: "conflict",
            body: { currentVersion: nextVersion, skill: current },
        });
        expect(calls).toBe(1);
    });

    it.each([
        { status: 404, code: "not_found" },
        { status: 501, code: "unsupported" },
    ])(
        "does not interpret unavailable skill management ($status) as an empty catalog",
        async ({ status, code }) => {
            const client = new HappyAgentClient({
                endpoint: "http://daemon",
                token: "t",
                fetch: async () =>
                    Response.json({ error: "Skill management is unavailable.", code }, { status }),
            });
            await expect(client.listGlobalSkills()).rejects.toMatchObject({
                status,
                code,
            });
        },
    );

    it("delivers file and enablement invalidations through the resumable updates feed", async () => {
        const event: HappyAgentEvent = {
            cursor: nextVersion,
            occurredAt: 1,
            type: "skills.updated",
            payload: { skillIds: [skill.id], paths: ["code-review/references/checklist.md"] },
        };
        const controller = new AbortController();
        const client = new HappyAgentClient({
            endpoint: "http://daemon",
            token: "t",
            fetch: async (input) => {
                expect(new URL(input.toString()).searchParams.get("after")).toBe(version);
                return new Response(
                    `event: hello\ndata: ${JSON.stringify({ cursor: version, gap: false, resumed: true, connectedAt: 1 })}\n\n` +
                        `id: ${nextVersion}\nevent: skills.updated\ndata: ${JSON.stringify(event)}\n\n`,
                    { headers: { "content-type": "text/event-stream" } },
                );
            },
        });
        const updates = client.updates({ after: version, signal: controller.signal });
        try {
            await expect(updates.next()).resolves.toMatchObject({
                value: { kind: "connected", cursor: version },
            });
            await expect(updates.next()).resolves.toMatchObject({
                value: { kind: "event", event },
            });
        } finally {
            controller.abort();
            await updates.return(undefined);
        }
    });
});
