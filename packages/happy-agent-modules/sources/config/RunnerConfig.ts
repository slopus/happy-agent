import { runnerIdSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

import { apiTokenSchema } from "./RemoteConnectionConfig.js";

/** The most runners one installation may configure. */
export const MAX_RUNNERS = 32;

/** One runner as machine configuration names it. The token never leaves configuration. */
export const runnerConfigSchema = Type.Object(
    {
        name: Type.String({
            minLength: 1,
            maxLength: 128,
            pattern: "^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$",
        }),
        token: apiTokenSchema,
    },
    { additionalProperties: false },
);
export type RunnerConfig = Static<typeof runnerConfigSchema>;

/**
 * Every configured runner and the one new folders go to.
 *
 * In `happy.toml` the default and the runners share one table, `[runners]`, so `default` is not a
 * runner ID; here they are kept apart.
 */
export const runnersConfigSchema = Type.Object(
    {
        default: Type.Optional(runnerIdSchema),
        entries: Type.Record(runnerIdSchema, runnerConfigSchema, {
            additionalProperties: false,
            maxProperties: MAX_RUNNERS,
        }),
    },
    { additionalProperties: false },
);
export type RunnersConfig = Static<typeof runnersConfigSchema>;
