import type { AgentKV } from "@slopus/happy-agent-base";
import { Type, type TSchema } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

export async function durableCheckpoint(
    ctx: Context,
    kv: AgentKV,
    key: string,
    work: () => Promise<void>,
    marker: unknown = true,
): Promise<void> {
    if ((await kv.read(ctx, key)) === marker) return;
    await work();
    await kv.write(ctx, key, marker);
}

export const durableEntityArgumentsSchema = <Id extends TSchema>(id: Id) =>
    Type.Object({ id }, { additionalProperties: false });

export function durableProvisionResultSchema<Error extends TSchema>(error: Error) {
    return Type.Union([
        Type.Object({ outcome: Type.Literal("ready") }, { additionalProperties: false }),
        Type.Object({ outcome: Type.Literal("superseded") }, { additionalProperties: false }),
        Type.Object({ error, outcome: Type.Literal("failed") }, { additionalProperties: false }),
    ]);
}
