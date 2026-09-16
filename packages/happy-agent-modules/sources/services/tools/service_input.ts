import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import type { ServicesModule } from "../ServicesModule.js";
import {
    serviceOutputTokensSchema,
    serviceToolOutputSchema,
    serviceToolOutputBytes,
    serviceToolOutput,
    formatServiceToolOutput,
} from "./ServiceToolOutput.js";

export function serviceInputTool(services: ServicesModule, agentId: string) {
    return defineAgentTool({
        name: "service_input",
        defer: true,
        capabilities: ["Start, discover, read, write to, and stop sandboxed workspace services."],
        searchKeywords: ["service stdin", "service output", "service logs", "service poll"],
        description:
            "Read new output from a service in your exact workspace, or write stdin and then read. Your output position is independent of other agents and Desktop views. Empty input defaults to a 5000 ms wait (maximum 300000); writes default to 250 ms (maximum 30000). Writes never widen the service sandbox and must not be automatically resent after an ambiguous failure. PTY control characters have terminal semantics only for a service started with tty.",
        parameters: Type.Object(
            {
                service_id: cuid2Schema,
                chars: Type.Optional(
                    Type.String({
                        maxLength: 65536,
                        description:
                            "Stdin text, at most 64 KiB in UTF-8. Omit or leave empty to poll without writing.",
                    }),
                ),
                yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 300000 })),
                max_output_tokens: serviceOutputTokensSchema,
            },
            { additionalProperties: false },
        ),
        returnType: serviceToolOutputSchema,
        durable: false,
        reloadable: false,
        steerable: true,
        shouldReviewInAutoMode: ({ chars }) => (chars?.length ?? 0) > 0,
        describeAutoPermissionAction: ({ service_id, chars }) =>
            `send ${JSON.stringify(chars ?? "")} to workspace service ${JSON.stringify(service_id)} under its existing mandatory sandbox, without elevation or new filesystem/network access`,
        execute: async (ctx, args) => {
            const typing = (args.chars?.length ?? 0) > 0;
            return serviceToolOutput(
                await services.inputForAgent(ctx, agentId, args.service_id, {
                    ...(args.chars === undefined ? {} : { chars: args.chars }),
                    waitMs: Math.min(
                        args.yield_time_ms ?? (typing ? 250 : 5000),
                        typing ? 30000 : 300000,
                    ),
                    maxOutputBytes: serviceToolOutputBytes(args.max_output_tokens),
                }),
            );
        },
        toLLM: (result) => [{ type: "text", text: formatServiceToolOutput(result) }],
    });
}
