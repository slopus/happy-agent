import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { computeSchema, computeSelectionSchema } from "../sources/protocol/common.js";
import { runnersUpdatedPayloadSchema, type HappyAgentEvent } from "../sources/protocol/events.js";
import {
    cloneProjectRequestSchema,
    projectSettingsSchema,
    registerProjectRequestSchema,
} from "../sources/protocol/projects.js";
import { runnerListResponseSchema, runnerSchema } from "../sources/protocol/runners.js";

const connectedRunner = {
    id: "build-box",
    name: "Build box",
    default: true,
    status: "connected" as const,
    machine: {
        version: "0.4.70",
        platform: "linux",
        arch: "x64",
        hostname: "build-1",
        home: "/home/happy-runner",
    },
    protocol: 1,
    since: 1755300000000,
    reason: null,
};

const neverConnectedRunner = {
    id: "spare",
    name: "Spare",
    default: false,
    status: "disconnected" as const,
    machine: null,
    protocol: null,
    since: 1755300000000,
    reason: "The runner has not connected yet.",
};

describe("runners", () => {
    it("delivers a resumable complete list with the same version as the list response", async () => {
        const before = "01900000-0000-7000-8000-000000000000";
        const cursor = "01900000-0000-7000-8000-000000000001";
        const list = { version: cursor, runners: [connectedRunner] };
        const event: HappyAgentEvent = {
            cursor,
            type: "runners.updated",
            occurredAt: 1,
            payload: list,
        };
        expect(Value.Check(runnersUpdatedPayloadSchema, event.payload)).toBe(true);
        expect(Value.Check(runnersUpdatedPayloadSchema, { token: "private" })).toBe(false);
        const controller = new AbortController();
        const client = new HappyAgentClient({
            endpoint: "http://main",
            token: "main-token",
            fetch: async (input) => {
                if (input.toString().endsWith("/v0/runners")) return Response.json(list);
                expect(input.toString()).toBe(`http://main/v0/events/stream?after=${before}`);
                return new Response(
                    `event: hello\ndata: ${JSON.stringify({ cursor, gap: false, resumed: true, connectedAt: 1 })}\n\n` +
                        `id: ${cursor}\nevent: runners.updated\ndata: ${JSON.stringify(event)}\n\n`,
                    { headers: { "content-type": "text/event-stream" } },
                );
            },
        });
        const updates = client.updates({ after: before, signal: controller.signal });
        try {
            await expect(updates.next()).resolves.toMatchObject({
                value: { kind: "connected", cursor: before },
            });
            await expect(updates.next()).resolves.toMatchObject({
                value: { kind: "event", event },
            });
            await expect(client.listRunners()).resolves.toEqual(list);
        } finally {
            controller.abort();
            await updates.return(undefined);
        }
    });

    it("requires the version on list responses and updates", () => {
        for (const schema of [runnerListResponseSchema, runnersUpdatedPayloadSchema]) {
            expect(
                Value.Check(schema, {
                    runners: [],
                    version: "01900000-0000-7000-8000-000000000001",
                }),
            ).toBe(true);
            expect(Value.Check(schema, { runners: [] })).toBe(false);
        }
    });

    it("reads the list through the authenticated route", async () => {
        const list = {
            version: "01900000-0000-7000-8000-000000000001",
            runners: [connectedRunner, neverConnectedRunner],
        };
        expect(Value.Check(runnerListResponseSchema, list)).toBe(true);
        let requested = "";
        const controller = new AbortController();
        const client = new HappyAgentClient({
            endpoint: "http://main/prefix?key=transport",
            token: "main-token",
            fetch: async (input, init) => {
                requested = input.toString();
                expect(init?.method).toBe("GET");
                expect(init?.signal).toBe(controller.signal);
                expect(new Headers(init?.headers).get("authorization")).toBe("Bearer main-token");
                return Response.json(list);
            },
        });
        await expect(client.listRunners({ signal: controller.signal })).resolves.toEqual(list);
        expect(requested).toBe("http://main/prefix/v0/runners?key=transport");
    });

    it("accepts connected and never-connected runners but no unknown status or bad IDs", () => {
        expect(Value.Check(runnerSchema, connectedRunner)).toBe(true);
        expect(Value.Check(runnerSchema, neverConnectedRunner)).toBe(true);
        for (const runner of [
            { ...connectedRunner, status: "connecting" },
            { ...connectedRunner, id: "Build-Box" },
            { ...connectedRunner, id: "../build" },
            { ...connectedRunner, name: "" },
            { ...connectedRunner, protocol: "1" },
            { ...connectedRunner, machine: { ...connectedRunner.machine, home: null } },
            { ...connectedRunner, reason: undefined },
        ]) {
            expect(Value.Check(runnerSchema, runner)).toBe(false);
        }
    });

    it("describes runner and Docker computes", () => {
        for (const compute of [
            { type: "runner", runnerId: "build-box", path: "/srv/projects/rig" },
            { type: "runner", runnerId: "build-box", path: null },
            { type: "docker", image: "node:22" },
            { type: "docker", image: "node:22", path: "/srv/projects/rig-ws" },
            {
                type: "docker",
                image: "node:22",
                path: "/srv/projects/rig-ws",
                runnerId: "build-box",
            },
        ]) {
            expect(Value.Check(computeSchema, compute)).toBe(true);
        }
        for (const compute of [
            { type: "runner", runnerId: "build-box" },
            { type: "runner", path: "/srv/projects/rig" },
            { type: "runner", runnerId: "Build", path: "/srv" },
            { type: "docker", image: "node:22", runnerId: 1 },
        ]) {
            expect(Value.Check(computeSchema, compute)).toBe(false);
        }
    });

    it("selects runner and Docker-on-runner workspace computes in project settings", () => {
        for (const defaultWorkspaceCompute of [
            { type: "host" },
            { type: "docker", image: "node:22" },
            { type: "docker", image: "node:22", runnerId: "build-box" },
            { type: "runner", runnerId: "build-box" },
        ]) {
            expect(Value.Check(computeSelectionSchema, defaultWorkspaceCompute)).toBe(true);
            expect(Value.Check(projectSettingsSchema, { defaultWorkspaceCompute })).toBe(true);
        }
        expect(Value.Check(computeSelectionSchema, { type: "runner" })).toBe(false);
    });

    it("sends the optional runner on project registration and cloning", async () => {
        const register = { path: "/srv/projects/rig", runnerId: "build-box" };
        const clone = {
            name: "rig",
            runnerId: "build-box",
            source: { kind: "github" as const, repository: "slopus/rig" },
        };
        expect(Value.Check(registerProjectRequestSchema, register)).toBe(true);
        expect(Value.Check(registerProjectRequestSchema, { path: "/srv" })).toBe(true);
        expect(Value.Check(registerProjectRequestSchema, { ...register, runnerId: "Bad" })).toBe(
            false,
        );
        expect(Value.Check(cloneProjectRequestSchema, clone)).toBe(true);
        expect(Value.Check(cloneProjectRequestSchema, { ...clone, runnerId: 1 })).toBe(false);
        const bodies: unknown[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://main",
            token: "t",
            fetch: async (_input, init) => {
                bodies.push(JSON.parse(init?.body as string));
                return Response.json({ project: {} }, { status: 202 });
            },
        });
        await client.registerProject(register);
        await client.cloneProject(clone);
        expect(bodies).toEqual([register, clone]);
    });

    it.each([
        { status: 503, code: "runner_unavailable" },
        { status: 409, code: "local_execution_disabled" },
    ])("preserves $code failures", async ({ status, code }) => {
        const client = new HappyAgentClient({
            endpoint: "http://main",
            token: "t",
            fetch: async () => Response.json({ code, error: "Not here." }, { status }),
        });
        await expect(client.registerProject({ path: "/srv/projects/rig" })).rejects.toMatchObject({
            status,
            code,
        });
    });

    it("does not hide errors from older daemons without runners", async () => {
        const client = new HappyAgentClient({
            endpoint: "http://main",
            token: "t",
            fetch: async () =>
                Response.json({ code: "not_found", error: "Not found." }, { status: 404 }),
        });
        await expect(client.listRunners()).rejects.toMatchObject({
            status: 404,
            code: "not_found",
        });
    });
});
