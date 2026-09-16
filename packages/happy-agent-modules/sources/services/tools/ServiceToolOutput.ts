import { workspaceServiceSchema, type WorkspaceService } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

const p = workspaceServiceSchema.properties;
export const serviceToolSnapshotSchema = Type.Object(
    {
        service_id: p.id,
        workspace_id: p.workspaceId,
        agent_id: p.agentId,
        name: p.name,
        cmd: p.command,
        port: p.port,
        tty: p.tty,
        status: p.status,
        endpoint_status: p.endpointStatus,
        exit_code: p.exitCode,
        error: p.error,
    },
    { additionalProperties: false },
);
export type ServiceToolSnapshot = Static<typeof serviceToolSnapshotSchema>;
export const serviceToolOutputSchema = Type.Object(
    {
        service: serviceToolSnapshotSchema,
        output: Type.String(),
        truncated: Type.Boolean(),
        wall_time_seconds: Type.Number({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type ServiceToolOutput = Static<typeof serviceToolOutputSchema>;
export const serviceOutputTokensSchema = Type.Optional(
    Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "Output token budget, default 10000. Larger requests remain capped by policy.",
    }),
);

export function serviceToolSnapshot(service: WorkspaceService): ServiceToolSnapshot {
    return {
        service_id: service.id,
        workspace_id: service.workspaceId,
        agent_id: service.agentId,
        name: service.name,
        cmd: service.command,
        port: service.port,
        tty: service.tty,
        status: service.status,
        endpoint_status: service.endpointStatus,
        exit_code: service.exitCode,
        error: service.error,
    };
}

export function serviceToolOutput(result: {
    service: WorkspaceService;
    output: string;
    truncated: boolean;
    wallTimeSeconds: number;
}): ServiceToolOutput {
    return {
        service: serviceToolSnapshot(result.service),
        output: result.output,
        truncated: result.truncated,
        wall_time_seconds: result.wallTimeSeconds,
    };
}

/**
 * Conservatively use one UTF-8 byte per requested token, with a shared 10,000-byte ceiling.
 * This is below the curated models' shell policies (Codex 10k tokens, Claude/Grok 40k chars),
 * including high-entropy output where the usual four-characters-per-token estimate is unsafe.
 * Keep the ceiling under every supported model's policy when adding a new curated model.
 */
export function serviceToolOutputBytes(tokens = 10000): number {
    return Math.min(tokens, 10000);
}

export function formatServiceToolOutput(result: ServiceToolOutput): string {
    const service = result.service;
    return [
        `Service ${service.service_id}: ${service.status}; endpoint ${service.endpoint_status}.`,
        `Wall time: ${result.wall_time_seconds.toFixed(3)} seconds.`,
        ...(service.exit_code === null ? [] : [`Process exited with code ${service.exit_code}.`]),
        ...(service.error === null ? [] : [service.error.message]),
        ...(result.truncated
            ? [
                  "Output was truncated, lost during capture, or replayed after this reader's idle position expired.",
              ]
            : []),
        result.output.length > 0 ? result.output : "(no new output)",
    ].join("\n");
}
