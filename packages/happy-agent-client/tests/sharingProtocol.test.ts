import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { desktopBootstrapResponseSchema } from "../sources/protocol/bootstrap.js";
import { sharingUpdatedPayloadSchema, type HappyAgentEvent } from "../sources/protocol/events.js";
import {
    type Sharing,
    sharingInvitationResponseSchema,
    sharingMutationRequestSchema,
    sharingRequestSubmissionSchema,
    sharingResponseSchema,
} from "../sources/protocol/sharing.js";
import { readEventStream } from "../sources/readEventStream.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const updatedAt = 1_755_400_000_000;
const localIdentity = "3q2LrgP9XenocXNBhZ0Jv5uW8dTGkxwm4AiY1cFsRHo";
const peerIdentity = "Zt7hK2mQfXcVbN9pLw4RyD8sJaG6uE1oTiP0xM5nCkA";
const requestIdentity = "Uv3mB8xQnR7tKpH2wLcY5dJ9zF4gS1eAoN6iVrT0MkE";
const outgoingPeerIdentity = "Pw9cD4rT2yUqLm6vXk1sHj8bZf3nEa7gRoK5tCiW0Nd";
const outgoingId = "Ks4pX7vNqR2mJ9cLd5wHb8tYe1zAf6oUi3gE0kSVWnQ";
const invitation = "Fh6sN2vXpQ9rKt4wLb8mYc1zJd7gAe3oTiU5xMnB0Wk";

const peerProfile = {
    email: "kirill@example.com",
    name: "Kirill Dubovitskiy",
    photo: { thumbhash: "3OcRJYB4d3h/iIeHeEh3eIhw+j3A" },
    updatedAt: updatedAt - 1_000,
    version,
};

const unenrolled: Sharing = {
    status: "unenrolled",
    updatedAt,
    version,
};

const enrolled: Sharing = {
    connection: "connected",
    contacts: [{ identity: peerIdentity, profile: peerProfile, status: "active" }],
    identity: localIdentity,
    incomingRequests: [{ id: "opaque/incoming request", identity: requestIdentity, profile: null }],
    outgoingRequests: [{ id: outgoingId, identity: outgoingPeerIdentity }],
    status: "enrolled",
    updatedAt,
    version,
};

describe("sharing protocol", () => {
    it("accepts both discriminated sharing snapshots", () => {
        expect(Value.Check(sharingResponseSchema, { sharing: unenrolled })).toBe(true);
        expect(Value.Check(sharingResponseSchema, { sharing: enrolled })).toBe(true);

        const connection = (sharing: Sharing): string =>
            sharing.status === "enrolled" ? sharing.connection : sharing.status;
        expect(connection(enrolled)).toBe("connected");
        expect(connection(unenrolled)).toBe("unenrolled");
    });

    it("rejects malformed identities, discriminants, and bounded request fields", () => {
        expect(
            Value.Check(sharingResponseSchema, {
                sharing: { ...unenrolled, status: "disabled" },
            }),
        ).toBe(false);
        expect(
            Value.Check(sharingResponseSchema, {
                sharing: { ...enrolled, identity: "too-short" },
            }),
        ).toBe(false);
        expect(
            Value.Check(sharingResponseSchema, {
                sharing: {
                    ...enrolled,
                    incomingRequests: [{ id: "", identity: requestIdentity, profile: null }],
                },
            }),
        ).toBe(false);
        expect(
            Value.Check(sharingResponseSchema, {
                sharing: {
                    ...enrolled,
                    outgoingRequests: [{ id: "not-base64url-43", identity: peerIdentity }],
                },
            }),
        ).toBe(false);
    });

    it("validates required invitation and mutation fields", () => {
        expect(Value.Check(sharingMutationRequestSchema, {})).toBe(true);
        expect(Value.Check(sharingMutationRequestSchema, { mutationId: "mutation-1" })).toBe(true);
        expect(
            Value.Check(sharingRequestSubmissionSchema, {
                invitation,
                mutationId: "mutation-2",
            }),
        ).toBe(true);
        expect(
            Value.Check(sharingInvitationResponseSchema, {
                expiresAt: updatedAt + 300_000,
                invitation,
            }),
        ).toBe(true);
    });

    it("tolerates future additive fields in requests, snapshots, profiles, and events", () => {
        expect(
            Value.Check(sharingMutationRequestSchema, { futureOption: true, mutationId: "m1" }),
        ).toBe(true);
        expect(
            Value.Check(sharingResponseSchema, {
                responseExtension: "newer-daemon",
                sharing: {
                    ...enrolled,
                    contacts: [
                        {
                            ...enrolled.contacts[0],
                            profile: { ...peerProfile, profileExtension: "newer-daemon" },
                        },
                    ],
                    snapshotExtension: "newer-daemon",
                },
            }),
        ).toBe(true);
        expect(Value.Check(sharingUpdatedPayloadSchema, { eventExtension: true, version })).toBe(
            true,
        );
    });

    it("keeps sharing optional and additive in protocol-22 desktop bootstrap", () => {
        const bootstrap = desktopBootstrap();
        expect(Value.Check(desktopBootstrapResponseSchema, bootstrap)).toBe(true);
        expect(
            Value.Check(desktopBootstrapResponseSchema, { ...bootstrap, sharing: unenrolled }),
        ).toBe(true);
        expect(
            Value.Check(desktopBootstrapResponseSchema, {
                ...bootstrap,
                sharing: { ...unenrolled, futureField: localIdentity },
            }),
        ).toBe(true);
    });

    it("keeps Cloud optional and additive in protocol-22 desktop bootstrap", () => {
        const bootstrap = desktopBootstrap();
        const cloud = {
            authorization: null,
            environment: null,
            error: null,
            status: "disconnected" as const,
            updatedAt,
            user: null,
            version,
        };
        const cloudSocial = {
            blocked: [],
            connection: null,
            friends: [],
            incomingRequests: [],
            outgoingRequests: [],
            status: "unenrolled" as const,
            updatedAt,
            version,
        };

        expect(Value.Check(desktopBootstrapResponseSchema, bootstrap)).toBe(true);
        expect(Value.Check(desktopBootstrapResponseSchema, { ...bootstrap, cloud })).toBe(true);
        expect(Value.Check(desktopBootstrapResponseSchema, { ...bootstrap, cloudSocial })).toBe(
            true,
        );
        expect(
            Value.Check(desktopBootstrapResponseSchema, {
                ...bootstrap,
                cloud: { ...cloud, futureField: "newer-daemon" },
                cloudSocial: { ...cloudSocial, futureField: "newer-daemon" },
            }),
        ).toBe(true);
    });

    it("parses sharing.updated as a compact version invalidation", async () => {
        const event: HappyAgentEvent = {
            cursor: version,
            occurredAt: updatedAt,
            payload: { mutationId: "mutation-3", version },
            type: "sharing.updated",
        };
        expect(Value.Check(sharingUpdatedPayloadSchema, event.payload)).toBe(true);

        const body = streamOf(
            `id: ${version}\nevent: sharing.updated\ndata: ${JSON.stringify(event)}\n\n`,
        );
        const frames = [];
        for await (const frame of readEventStream(body)) frames.push(frame);

        expect(frames).toEqual([{ cursor: version, event, kind: "event" }]);
        const parsed = frames[0];
        if (parsed?.kind !== "event" || parsed.event.type !== "sharing.updated") {
            throw new Error("Expected a sharing.updated event.");
        }
        expect(parsed.event.payload).toEqual({ mutationId: "mutation-3", version });
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

function desktopBootstrap() {
    return {
        config: {
            defaults: {
                effort: "medium",
                modelId: "openai/gpt-5.6-sol",
                permissionMode: "auto",
                providerId: "codex",
            },
            features: { crossWorkspace: false, workflows: true, workspaces: true },
            mcpServers: {},
            models: {},
            network: {
                allowedDomains: [],
                allowedLoopbackPorts: [],
                allowedPorts: [],
                allowLocalBinding: false,
                deniedDomains: [],
            },
            p2p: {
                enableDirect: false,
                enableIroh: true,
                enableSsh: false,
                exposeApi: false,
                name: "steves-macbook",
                role: "primary",
            },
            permissions: { protectedPaths: [] },
            presence: { current: "online", fallback: "online", states: {} },
            providers: {},
            settings: {
                compactCompletedTurns: false,
                completionChime: false,
                inferenceMaxRetries: 10,
                showReasoning: false,
                showUsage: false,
                toolResultRetentionDays: 7,
            },
            theme: {
                accent: "cyan",
                brand: "ansi:202",
                error: "red",
                primary: "default",
                secondary: "dim",
                success: "green",
                warning: "yellow",
            },
            workspace: {
                keepCopiesOnArchive: true,
                keepWorktreesOnArchive: false,
                protectedSync: [],
                setupCommands: [],
                sync: [],
            },
        },
        cursor: version,
        onboarding: {
            completed: false,
            steps: {
                profile: { done: false },
                project: { done: false },
                providers: { done: false, signedIn: [] },
            },
        },
        profile: { email: null, name: null, photo: null, updatedAt, version },
        projects: [],
        workspaces: [],
    };
}
