import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    type Cloud,
    cloudAccessTokenResponseSchema,
    cloudAuthorizingResponseSchema,
    cloudConnectedResponseSchema,
    cloudDisconnectedResponseSchema,
    cloudProfileResponseSchema,
    cloudResponseSchema,
    completeCloudAuthorizationRequestSchema,
    enrollCloudProfileRequestSchema,
    startCloudAuthorizationRequestSchema,
} from "../sources/protocol/cloud.js";
import type { HappyAgentEvent } from "../sources/protocol/events.js";
import { readEventStream } from "../sources/readEventStream.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const updatedAt = 1_755_400_000_000;

describe("Cloud protocol", () => {
    it("accepts every valid status-specific snapshot", () => {
        const snapshots: Cloud[] = [
            {
                authorization: null,
                environment: null,
                error: null,
                status: "disconnected",
                updatedAt,
                user: null,
                version,
            },
            {
                authorization: {
                    expiresAt: updatedAt + 600_000,
                    url: "https://api.workos.com/user_management/authorize?state=state",
                },
                environment: "staging",
                error: null,
                status: "authorizing",
                updatedAt,
                user: null,
                version,
            },
            {
                authorization: null,
                environment: "production",
                error: null,
                status: "connected",
                updatedAt,
                user: {
                    email: "person@example.com",
                    firstName: "Ada",
                    id: "user_01H",
                    lastName: null,
                },
                version,
            },
        ];

        for (const cloud of snapshots) {
            expect(Value.Check(cloudResponseSchema, { cloud })).toBe(true);
        }
    });

    it("rejects credentials and authorization fields in the wrong status", () => {
        const impossible = [
            {
                authorization: null,
                environment: "production",
                error: null,
                status: "disconnected",
                updatedAt,
                user: null,
                version,
            },
            {
                authorization: null,
                environment: "staging",
                error: null,
                status: "authorizing",
                updatedAt,
                user: null,
                version,
            },
        ];

        for (const cloud of impossible) {
            expect(Value.Check(cloudResponseSchema, { cloud })).toBe(false);
        }
    });

    it("validates authorization requests and access-token responses", () => {
        expect(
            Value.Check(startCloudAuthorizationRequestSchema, {
                environment: "production",
                mutationId: "mutation-1",
                redirectUri: "happy-auth://callback",
            }),
        ).toBe(true);
        expect(
            Value.Check(completeCloudAuthorizationRequestSchema, {
                callbackUrl: "happy-auth://callback?code=code&state=state",
            }),
        ).toBe(true);
        expect(
            Value.Check(startCloudAuthorizationRequestSchema, {
                environment: "development",
                redirectUri: "happy-auth://callback",
            }),
        ).toBe(false);
        expect(
            Value.Check(cloudAccessTokenResponseSchema, {
                accessToken: "access-token",
                cloud: {
                    authorization: null,
                    environment: "production",
                    error: null,
                    status: "connected",
                    updatedAt,
                    user: {
                        email: "person@example.com",
                        firstName: null,
                        id: "user_01H",
                        lastName: null,
                    },
                    version,
                },
            }),
        ).toBe(true);
    });

    it("rejects success snapshots with the wrong status", () => {
        const disconnected = {
            authorization: null,
            environment: null,
            error: null,
            status: "disconnected",
            updatedAt,
            user: null,
            version,
        };
        const authorizing = {
            authorization: {
                expiresAt: updatedAt + 600_000,
                url: "https://api.workos.com/user_management/authorize?state=state",
            },
            environment: "production",
            error: null,
            status: "authorizing",
            updatedAt,
            user: null,
            version,
        };

        expect(Value.Check(cloudAuthorizingResponseSchema, { cloud: authorizing })).toBe(true);
        expect(Value.Check(cloudAuthorizingResponseSchema, { cloud: disconnected })).toBe(false);
        expect(Value.Check(cloudConnectedResponseSchema, { cloud: authorizing })).toBe(false);
        expect(Value.Check(cloudDisconnectedResponseSchema, { cloud: disconnected })).toBe(true);
        expect(
            Value.Check(cloudAccessTokenResponseSchema, {
                accessToken: "access-token",
                cloud: disconnected,
            }),
        ).toBe(false);
    });

    it("validates registered, unregistered, and enrollment profile shapes", () => {
        expect(
            Value.Check(cloudProfileResponseSchema, {
                profile: { firstName: null, username: null },
            }),
        ).toBe(true);
        expect(
            Value.Check(cloudProfileResponseSchema, {
                futureResponseField: true,
                profile: {
                    firstName: "Ada",
                    futureProfileField: true,
                    lastName: "Lovelace",
                    username: "ada_1",
                },
            }),
        ).toBe(true);
        expect(
            Value.Check(enrollCloudProfileRequestSchema, {
                mutationId: "enroll-1",
                username: "ada_1",
            }),
        ).toBe(true);
        expect(
            Value.Check(enrollCloudProfileRequestSchema, {
                firstName: "Ada",
                username: "ada_1",
            }),
        ).toBe(false);

        for (const invalid of [{}, { username: "No" }, { username: "ab" }]) {
            expect(Value.Check(enrollCloudProfileRequestSchema, invalid)).toBe(false);
        }
    });

    it("parses cloud.updated as a complete replacement with a mutation echo", async () => {
        const cloud: Cloud = {
            authorization: null,
            environment: null,
            error: { code: "credentials_rejected", message: "Cloud authorization expired." },
            status: "disconnected",
            updatedAt,
            user: null,
            version,
        };
        const event: HappyAgentEvent = {
            cursor: version,
            occurredAt: updatedAt,
            payload: { cloud, mutationId: "mutation-3" },
            type: "cloud.updated",
        };
        const body = streamOf(
            `id: ${version}\nevent: cloud.updated\ndata: ${JSON.stringify(event)}\n\n`,
        );
        const frames = [];
        for await (const frame of readEventStream(body)) frames.push(frame);

        expect(frames).toEqual([{ cursor: version, event, kind: "event" }]);
        const parsed = frames[0];
        if (parsed?.kind !== "event" || parsed.event.type !== "cloud.updated") {
            throw new Error("Expected a cloud.updated event.");
        }
        expect(parsed.event.payload).toEqual({ cloud, mutationId: "mutation-3" });
    });

    it("parses cloud.profile.updated as a compact mutation invalidation", async () => {
        const event: HappyAgentEvent = {
            cursor: version,
            occurredAt: updatedAt,
            payload: { mutationId: "profile-3" },
            type: "cloud.profile.updated",
        };
        const frames = [];
        for await (const frame of readEventStream(
            streamOf(
                `id: ${version}\nevent: cloud.profile.updated\ndata: ${JSON.stringify(event)}\n\n`,
            ),
        )) {
            frames.push(frame);
        }

        expect(frames).toEqual([{ cursor: version, event, kind: "event" }]);
    });
});

function streamOf(text: string): ReadableStream<Uint8Array<ArrayBuffer>> {
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
}
