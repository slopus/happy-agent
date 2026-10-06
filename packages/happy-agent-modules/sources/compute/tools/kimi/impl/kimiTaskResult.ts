import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ComputeSessionSnapshot } from "../../../Compute.js";
import { boundOutputText } from "../../../impl/boundOutputText.js";

export const kimiTaskResultSchema = Type.Object(
    {
        task_id: Type.String(),
        status: Type.Union([
            Type.Literal("running"),
            Type.Literal("completed"),
            Type.Literal("killed"),
        ]),
        exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
        output: Type.String(),
        truncated: Type.Boolean(),
    },
    { additionalProperties: false },
);

const taskIdSchema = Type.String({ pattern: "^[1-9][0-9]{0,15}$" });
const sessionIdSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

export function parseKimiTaskId(id: string): number {
    const sessionId = Number(id);
    if (!Value.Check(taskIdSchema, id) || !Value.Check(sessionIdSchema, sessionId))
        throw new Error("The shell task identifier is invalid.");
    return sessionId;
}

export function kimiTaskResult(snapshot: ComputeSessionSnapshot) {
    const output = boundOutputText(
        [snapshot.stdoutDelta, snapshot.stderrDelta].filter(Boolean).join("\n"),
        { maxCharacters: 60000 },
    );
    return {
        task_id: String(snapshot.sessionId),
        status: snapshot.status,
        ...(snapshot.status === "running" ? {} : { exit_code: snapshot.exitCode }),
        output: output.text,
        truncated:
            output.truncated ||
            (snapshot.stdoutDeltaOmittedBytes ?? 0) + (snapshot.stderrDeltaOmittedBytes ?? 0) > 0,
    };
}
