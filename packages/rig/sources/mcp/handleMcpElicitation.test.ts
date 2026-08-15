import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { createJustBashToolHarness } from "../testing/createAgentTestHarness.js";
import { handleMcpElicitation } from "./handleMcpElicitation.js";
import { runMcpClientCall } from "./runMcpClientCall.js";

describe("handleMcpElicitation", () => {
    it("collects free-form values and preserves raw enum values", async () => {
        const client = {} as Client;
        const harness = createJustBashToolHarness();
        harness.context.userInput = {
            request: async () => ({
                status: "answered" as const,
                answers: { count: ["42"], environment: ["Production environment"] },
            }),
        };
        const request = {
            method: "elicitation/create",
            params: {
                message: "Configure deployment.",
                requestedSchema: {
                    type: "object",
                    properties: {
                        count: { type: "integer", title: "Count" },
                        environment: {
                            type: "string",
                            enum: ["staging", "production"],
                            enumNames: ["Staging environment", "Production environment"],
                        },
                    },
                    required: ["count", "environment"],
                },
            },
        } as ElicitRequest;

        const result = await runMcpClientCall(client, harness.context, () =>
            handleMcpElicitation(client, request),
        );

        expect(result).toEqual({
            action: "accept",
            content: { count: 42, environment: "production" },
        });
    });

    it("preserves a required enum value named Skip", async () => {
        const client = {} as Client;
        const harness = createJustBashToolHarness();
        harness.context.userInput = {
            request: async () => ({ status: "answered" as const, answers: { action: ["Skip"] } }),
        };
        const request = {
            method: "elicitation/create",
            params: {
                message: "Choose an action.",
                requestedSchema: {
                    type: "object",
                    properties: {
                        action: { type: "string", enum: ["Skip", "Continue"] },
                    },
                    required: ["action"],
                },
            },
        } as ElicitRequest;

        const result = await runMcpClientCall(client, harness.context, () =>
            handleMcpElicitation(client, request),
        );

        expect(result).toEqual({ action: "accept", content: { action: "Skip" } });
    });

    it("presents boolean choices as Yes and No while preserving boolean values", async () => {
        const client = {} as Client;
        const harness = createJustBashToolHarness();
        const requests: unknown[] = [];
        harness.context.userInput = {
            request: async (request) => {
                requests.push(request);
                return { status: "answered" as const, answers: { confirmed: ["Yes"] } };
            },
        };
        const request = {
            method: "elicitation/create",
            params: {
                message: "Confirm the deployment.",
                requestedSchema: {
                    type: "object",
                    properties: {
                        confirmed: { type: "boolean", title: "Confirm" },
                    },
                    required: ["confirmed"],
                },
            },
        } as ElicitRequest;

        const result = await runMcpClientCall(client, harness.context, () =>
            handleMcpElicitation(client, request),
        );

        expect(requests).toMatchObject([
            {
                questions: [
                    {
                        id: "confirmed",
                        options: [
                            { description: "Answer Yes.", label: "Yes" },
                            { description: "Answer No.", label: "No" },
                        ],
                    },
                ],
            },
        ]);
        expect(result).toEqual({ action: "accept", content: { confirmed: true } });
    });

    it("asks for confirmation before accepting an empty schema", async () => {
        const client = {} as Client;
        const harness = createJustBashToolHarness();
        const requests: unknown[] = [];
        harness.context.userInput = {
            request: async (request) => {
                requests.push(request);
                return { status: "answered" as const, answers: { confirmation: ["Continue"] } };
            },
        };
        const request = emptySchemaRequest("Proceed with deleting remote records?");

        const result = await runMcpClientCall(client, harness.context, () =>
            handleMcpElicitation(client, request),
        );

        expect(result).toEqual({ action: "accept", content: {} });
        expect(requests).toMatchObject([
            {
                questions: [
                    {
                        header: "MCP request",
                        id: "confirmation",
                        options: [{ label: "Continue" }, { label: "Decline" }],
                        question: "Proceed with deleting remote records?",
                    },
                ],
            },
        ]);
    });

    it("declines an empty schema when the user does not confirm", async () => {
        const client = {} as Client;
        const harness = createJustBashToolHarness();
        harness.context.userInput = {
            request: async () => ({
                status: "answered" as const,
                answers: { confirmation: ["Decline"] },
            }),
        };

        const result = await runMcpClientCall(client, harness.context, () =>
            handleMcpElicitation(client, emptySchemaRequest("Continue?")),
        );

        expect(result).toEqual({ action: "decline" });
    });
});

function emptySchemaRequest(message: string): ElicitRequest {
    return {
        method: "elicitation/create",
        params: {
            message,
            requestedSchema: { type: "object", properties: {} },
        },
    } as ElicitRequest;
}
