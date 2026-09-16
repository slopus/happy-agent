import { defineAgentTool } from "@slopus/happy-agent-base";
import { computeServiceStartSchema } from "@slopus/happy-agent-compute";
import { Type } from "@sinclair/typebox";
import { ServiceError, serviceDefinitionSchema } from "../Service.js";
import type { ServicesModule } from "../ServicesModule.js";
import {
    serviceOutputTokensSchema,
    serviceToolOutputSchema,
    serviceToolOutputBytes,
    serviceToolOutput,
    formatServiceToolOutput,
} from "./ServiceToolOutput.js";

const p = computeServiceStartSchema.properties;
const sandbox = p.sandbox.properties;
export function serviceStartTool(services: ServicesModule, agentId: string) {
    return defineAgentTool({
        name: "service_start",
        defer: true,
        capabilities: ["Start, discover, read, write to, and stop sandboxed workspace services."],
        searchKeywords: ["start service", "dev server", "workspace preview", "expose port"],
        description:
            "Start an agent-owned service with one private HTTP endpoint in your exact workspace. Requires a mandatory service sandbox, including in Full access. Select only needed read-only inputs; live outside edits remain visible. Scratch is disposable private storage, never a writable host alias. No ambient credentials or control sockets are inherited. Outbound hostname/port pairs must also pass user policy. Only authenticated workspace views can attach; this creates no public URL. The command survives normal tool/turn completion, but owning-agent abort, archival and daemon shutdown stop it. Unsupported compute fails closed. Do not use an ordinary shell command as an exposure fallback.",
        parameters: Type.Object(
            {
                name: serviceDefinitionSchema.properties.name,
                cmd: p.command,
                port: p.port,
                workdir: Type.Optional(p.cwd),
                tty: Type.Optional(Type.Boolean()),
                sandbox: Type.Object(
                    {
                        inputs: sandbox.inputs,
                        scratch: Type.Optional(sandbox.scratch),
                        outbound: Type.Optional(sandbox.outbound),
                        limits: Type.Optional(
                            Type.Object(
                                {
                                    memory_mib: Type.Optional(sandbox.limits.properties.memoryMiB),
                                    processes: Type.Optional(sandbox.limits.properties.processes),
                                },
                                { additionalProperties: false },
                            ),
                        ),
                    },
                    { additionalProperties: false },
                ),
                yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })),
                max_output_tokens: serviceOutputTokensSchema,
            },
            { additionalProperties: false },
        ),
        returnType: serviceToolOutputSchema,
        durable: false,
        reloadable: false,
        steerable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: (args) =>
            `start ${JSON.stringify(args.cmd)} as workspace service ${JSON.stringify(args.name)} on private HTTP port ${args.port}, workdir ${JSON.stringify(args.workdir ?? ".")}. Selected live read-only inputs and private scratch/network limits: ${JSON.stringify(args.sandbox)}. Input contents may be served to authenticated workspace viewers; selected named pipes can communicate with an outside consumer. Mandatory resource/network/filesystem isolation remains enabled, with no public exposure or ambient credentials`,
        execute: async (ctx, args) => {
            const began = performance.now();
            const service = await services.start(ctx, agentId, {
                name: args.name,
                command: args.cmd,
                cwd: args.workdir ?? ".",
                port: args.port,
                tty: args.tty ?? false,
                sandbox: {
                    inputs: args.sandbox.inputs,
                    scratch: args.sandbox.scratch ?? [],
                    outbound: args.sandbox.outbound ?? [],
                    limits: {
                        memoryMiB: args.sandbox.limits?.memory_mib ?? 1024,
                        processes: args.sandbox.limits?.processes ?? 64,
                    },
                },
            });
            try {
                const result = await services.inputForAgent(ctx, agentId, service.id, {
                    waitMs: args.yield_time_ms ?? 1000,
                    maxOutputBytes: serviceToolOutputBytes(args.max_output_tokens),
                });
                return serviceToolOutput({
                    ...result,
                    wallTimeSeconds: (performance.now() - began) / 1000,
                });
            } catch (error: unknown) {
                if (!(error instanceof ServiceError) || error.code !== "output_unavailable")
                    throw error;
                // Startup can fail before an output handle exists. Preserve the created identity
                // and its durable error rather than encouraging an ambiguous command replay.
                return serviceToolOutput({
                    service: await services.get(ctx, service.workspaceId, service.id),
                    output: "",
                    truncated: true,
                    wallTimeSeconds: (performance.now() - began) / 1000,
                });
            }
        },
        isError: (result) => result.service.status === "failed",
        toLLM: (result) => [{ type: "text", text: formatServiceToolOutput(result) }],
    });
}
