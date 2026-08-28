import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { CRDT_MURMUR_SERVICE as PUBLIC_CRDT_MURMUR_SERVICE } from "../sources/index.js";
import {
    addCrdtServiceMemberRequestSchema,
    createCrdtServiceRequestSchema,
    type CrdtService,
    type CrdtSharedSharing,
    type CrdtTree,
    crdtCloudIdSchema,
    crdtEncodedBytesSchema,
    crdtMurmurIdentitySchema,
    crdtServiceNameSchema,
    crdtServiceListQuerySchema,
    crdtServiceListResponseSchema,
    crdtServiceResponseSchema,
    crdtServiceSchema,
    getCrdtSharedSharingViolation,
    getCrdtTreeLimitViolation,
    removeCrdtServiceMemberRequestSchema,
    updateCrdtServiceRequestSchema,
} from "../sources/protocol/crdt.js";
import {
    crdtConnectionUpdatedPayloadSchema,
    crdtServiceCreatedPayloadSchema,
    crdtServiceUpdatedPayloadSchema,
    type HappyAgentEvent,
} from "../sources/protocol/events.js";
import { readEventStream } from "../sources/readEventStream.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const catalogVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const updatedAt = 1_755_400_000_000;
const identityKey = "A".repeat(43);
const otherIdentityKey = `${"B".repeat(42)}A`;
const cloudId = "user_01HBEQKA6K4QJAS93VPE39W1JT";

const localService: CrdtService = {
    createdAt: updatedAt,
    id: "service1",
    kind: "todo",
    name: "Launch checklist",
    service: "crdt.loro",
    sharing: { status: "local" },
    state: "AQID",
    tree: {
        todos: [{ done: false, priority: "high", text: "Ship it" }],
    },
    updatedAt,
    version,
};

describe("Happy CRDT protocol", () => {
    it("validates local and shared service snapshots with arbitrary JSON trees", () => {
        expect(Value.Check(crdtServiceSchema, localService)).toBe(true);
        expect(Value.Check(crdtServiceSchema, { ...localService, futureField: true })).toBe(true);
        expect(PUBLIC_CRDT_MURMUR_SERVICE).toBe("crdt.loro");

        const shared: CrdtService = {
            ...localService,
            sharing: {
                owner: identityKey,
                participants: [
                    { identityKey, role: "owner" },
                    { identityKey: otherIdentityKey, role: "member" },
                ],
                policies: {
                    adminsAssignAdmins: false,
                    anyoneCanAddMembers: false,
                    sendPolicy: "everyone",
                },
                recovery: "ready",
                sessionId: `${"C".repeat(42)}A`,
                status: "shared",
            },
        };
        expect(Value.Check(crdtServiceResponseSchema, { service: shared })).toBe(true);
        expect(
            Value.Check(crdtServiceSchema, {
                ...shared,
                sharing: { ...shared.sharing, policies: { sendPolicy: "everyone" } },
            }),
        ).toBe(false);
        expect(
            Value.Check(crdtServiceSchema, {
                ...shared,
                service: "crdt/yjs",
            }),
        ).toBe(false);
        expect(
            Value.Check(crdtServiceSchema, {
                ...shared,
                tree: { invalid: undefined },
            }),
        ).toBe(false);

        const sharedSharing = shared.sharing;
        if (sharedSharing.status !== "shared") throw new Error("Expected shared test fixture.");
        const invalidSharings: CrdtSharedSharing[] = [
            { ...sharedSharing, owner: otherIdentityKey },
            {
                ...sharedSharing,
                participants: [
                    { identityKey: otherIdentityKey, role: "member" },
                    { identityKey, role: "owner" },
                ],
            },
            {
                ...sharedSharing,
                participants: [
                    { identityKey, role: "owner" },
                    { identityKey, role: "member" },
                ],
            },
            {
                ...sharedSharing,
                participants: [
                    { identityKey, role: "member" },
                    { identityKey: otherIdentityKey, role: "member" },
                ],
            },
        ];
        for (const invalidSharing of invalidSharings) {
            expect(Value.Check(crdtServiceSchema, { ...shared, sharing: invalidSharing })).toBe(
                true,
            );
            expect(getCrdtSharedSharingViolation(invalidSharing)).not.toBeNull();
        }
    });

    it("bounds kinds, names, identities, Loro bytes, pages, and strict mutation bodies", () => {
        expect(
            Value.Check(createCrdtServiceRequestSchema, {
                id: "service1",
                kind: "com.example/todo-list",
                mutationId: "create-1",
                name: "Launch checklist",
                state: "AQID",
            }),
        ).toBe(true);
        for (const invalid of [
            { kind: "Todo", name: "Launch checklist", state: "AQID" },
            { kind: "todo", name: "   ", state: "AQID" },
            { kind: "todo", name: "Launch checklist", state: "not+base64" },
            { kind: "todo", name: "Launch checklist", state: "AQID", extra: true },
        ]) {
            expect(Value.Check(createCrdtServiceRequestSchema, invalid)).toBe(false);
        }

        expect(Value.Check(updateCrdtServiceRequestSchema, { update: "AQID" })).toBe(true);
        expect(Value.Check(updateCrdtServiceRequestSchema, { update: "AQID", extra: true })).toBe(
            false,
        );
        expect(Value.Check(addCrdtServiceMemberRequestSchema, {})).toBe(true);
        expect(Value.Check(addCrdtServiceMemberRequestSchema, { ticket: "AQID" })).toBe(false);
        expect(Value.Check(crdtCloudIdSchema, cloudId)).toBe(true);
        expect(Value.Check(crdtCloudIdSchema, "")).toBe(false);
        expect(Value.Check(crdtCloudIdSchema, "user/other")).toBe(false);
        expect(Value.Check(crdtCloudIdSchema, "a".repeat(257))).toBe(false);
        expect(Value.Check(crdtMurmurIdentitySchema, `${"A".repeat(42)}B`)).toBe(false);
        expect(
            Value.Check(createCrdtServiceRequestSchema, {
                kind: "todo",
                name: "Launch checklist",
                state: "AB",
            }),
        ).toBe(false);
        expect(crdtEncodedBytesSchema.maxLength).toBe(699_051);
        expect(Value.Check(removeCrdtServiceMemberRequestSchema, {})).toBe(true);
        expect(Value.Check(crdtServiceListQuerySchema, { kind: "todo", limit: 500 })).toBe(true);
        expect(Value.Check(crdtServiceListQuerySchema, { limit: 501 })).toBe(false);
    });

    it("applies Unicode character semantics and every projected-tree bound", () => {
        expect(Value.Check(crdtServiceNameSchema, `\u2028A${"😀".repeat(254)}`)).toBe(true);
        expect(Value.Check(crdtServiceNameSchema, "😀".repeat(256))).toBe(true);
        expect(Value.Check(crdtServiceNameSchema, "😀".repeat(257))).toBe(false);
        expect(Value.Check(crdtServiceNameSchema, "A\nB")).toBe(false);

        const oneMiB = "a".repeat(1024 * 1024);
        expect(getCrdtTreeLimitViolation({ text: oneMiB })).toBeNull();
        expect(getCrdtTreeLimitViolation({ text: `${oneMiB}a` })).toBe("string_size");
        expect(getCrdtTreeLimitViolation({ date: new Date() } as never)).toBe("invalid_value");
        expect(getCrdtTreeLimitViolation({ a: oneMiB, b: oneMiB, c: oneMiB, d: oneMiB })).toBe(
            "serialized_size",
        );

        const maximumValues = Array.from({ length: 99_998 }, () => null);
        expect(getCrdtTreeLimitViolation({ values: maximumValues })).toBeNull();
        expect(getCrdtTreeLimitViolation({ values: [...maximumValues, null] })).toBe(
            "total_values",
        );
        expect(
            getCrdtTreeLimitViolation({
                values: Array.from({ length: 100_001 }, () => null),
            }),
        ).toBe("entries");

        let depth64: Record<string, unknown> = {};
        for (let depth = 1; depth < 64; depth += 1) depth64 = { child: depth64 };
        expect(getCrdtTreeLimitViolation(depth64 as CrdtTree)).toBeNull();
        expect(getCrdtTreeLimitViolation({ child: depth64 } as CrdtTree)).toBe("depth");
    });

    it("validates catalogs and all three compact event shapes", async () => {
        const summary = (({ state: _state, tree: _tree, ...value }) => value)(localService);
        expect(
            Value.Check(crdtServiceListResponseSchema, {
                connection: "offline",
                cursor: localService.id,
                hasMore: false,
                services: [summary],
                updatedAt,
                version: catalogVersion,
            }),
        ).toBe(true);

        const events: HappyAgentEvent[] = [
            {
                cursor: version,
                occurredAt: updatedAt,
                payload: { catalogVersion, mutationId: "create-1", service: summary },
                type: "crdt.service.created",
            },
            {
                cursor: catalogVersion,
                occurredAt: updatedAt + 1,
                payload: {
                    catalogVersion,
                    mutationId: "update-1",
                    serviceId: localService.id,
                    version: catalogVersion,
                },
                type: "crdt.service.updated",
            },
            {
                cursor: "01991f3a-7d2f-7000-8000-3a0b2c4d5e70",
                occurredAt: updatedAt + 2,
                payload: { catalogVersion, connection: "online" },
                type: "crdt.connection.updated",
            },
        ];

        expect(Value.Check(crdtServiceCreatedPayloadSchema, events[0]!.payload)).toBe(true);
        expect(Value.Check(crdtServiceUpdatedPayloadSchema, events[1]!.payload)).toBe(true);
        expect(Value.Check(crdtConnectionUpdatedPayloadSchema, events[2]!.payload)).toBe(true);

        const frames = [];
        for await (const frame of readEventStream(
            streamOf(
                events
                    .map(
                        (event) =>
                            `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                    )
                    .join(""),
            ),
        )) {
            frames.push(frame);
        }
        expect(frames.map((frame) => frame.kind === "event" && frame.event.type)).toEqual([
            "crdt.service.created",
            "crdt.service.updated",
            "crdt.connection.updated",
        ]);
    });

    it("calls every CRDT endpoint with encoded identities and the documented bodies", async () => {
        const response = { service: localService };
        const catalog = {
            connection: "offline" as const,
            cursor: localService.id,
            hasMore: false,
            services: [],
            updatedAt,
            version: catalogVersion,
        };
        const { fetch, requests } = stubFetch((request) => {
            if (request.method === "GET" && request.url.includes("/v0/services/crdt?")) {
                return json(catalog);
            }
            if (request.method === "POST" && request.url.endsWith("/v0/services/crdt")) {
                return json(response, 201);
            }
            if (request.method === "PUT" || request.method === "DELETE") {
                return json(response, 202);
            }
            return json(response);
        });
        const client = new HappyAgentClient({ endpoint: "http://agent.local", fetch, token: "t" });

        await expect(
            client.listCrdtServices({ after: "service0", kind: "todo/list", limit: 20 }),
        ).resolves.toEqual(catalog);
        await expect(
            client.createCrdtService({ kind: "todo", name: "Launch checklist", state: "AQID" }),
        ).resolves.toEqual({ ...response, httpStatus: 201 });
        await expect(client.getCrdtService("service 1")).resolves.toEqual(response);
        await expect(
            client.updateCrdtService("service 1", { mutationId: "update-1", update: "BAUG" }),
        ).resolves.toEqual(response);
        await expect(
            client.addCrdtServiceMember("service 1", cloudId, {
                mutationId: "add-1",
            }),
        ).resolves.toEqual({ ...response, httpStatus: 202 });
        await expect(
            client.removeCrdtServiceMember("service 1", identityKey, {
                mutationId: "remove-1",
            }),
        ).resolves.toEqual({ ...response, httpStatus: 202 });

        expect(requests).toEqual([
            {
                body: null,
                method: "GET",
                url: "http://agent.local/v0/services/crdt?after=service0&kind=todo%2Flist&limit=20",
            },
            {
                body: JSON.stringify({
                    kind: "todo",
                    name: "Launch checklist",
                    state: "AQID",
                }),
                method: "POST",
                url: "http://agent.local/v0/services/crdt",
            },
            {
                body: null,
                method: "GET",
                url: "http://agent.local/v0/services/crdt/service%201",
            },
            {
                body: JSON.stringify({ mutationId: "update-1", update: "BAUG" }),
                method: "POST",
                url: "http://agent.local/v0/services/crdt/service%201/updates",
            },
            {
                body: JSON.stringify({ mutationId: "add-1" }),
                method: "PUT",
                url: `http://agent.local/v0/services/crdt/service%201/members/${cloudId}`,
            },
            {
                body: JSON.stringify({ mutationId: "remove-1" }),
                method: "DELETE",
                url: `http://agent.local/v0/services/crdt/service%201/members/${identityKey}`,
            },
        ]);
    });
});

interface RecordedRequest {
    readonly body: string | null;
    readonly method: string;
    readonly url: string;
}

function stubFetch(answer: (request: RecordedRequest) => Response): {
    fetch: typeof globalThis.fetch;
    requests: RecordedRequest[];
} {
    const requests: RecordedRequest[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = {
            body: typeof init?.body === "string" ? init.body : null,
            method: init?.method ?? "GET",
            url: input.toString(),
        };
        requests.push(request);
        return answer(request);
    };
    return { fetch, requests };
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status,
    });
}

function streamOf(text: string): ReadableStream<Uint8Array<ArrayBuffer>> {
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
}
