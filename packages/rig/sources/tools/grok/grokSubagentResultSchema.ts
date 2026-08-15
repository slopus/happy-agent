import { Type, type Static } from "@sinclair/typebox";

export const grokSubagentResultSchema = Type.Union([
    Type.Object(
        {
            target: Type.String(),
            status: Type.Literal("not_found"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            agent_id: Type.String(),
            path: Type.String(),
            status: Type.String(),
            output: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
    ),
]);

export type GrokSubagentResult = Static<typeof grokSubagentResultSchema>;
