import { runnerIdSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

import { apiTokenSchema } from "./RemoteConnectionConfig.js";

/** The most runners one installation may configure. */
export const MAX_RUNNERS = 32;

/**
 * What `[runners] default` names to keep this machine the default while runners are configured.
 * No runner may take this ID.
 */
export const LOCAL_RUNNER_ID = "local";

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
 * runner ID; here they are kept apart. A `default` of {@link LOCAL_RUNNER_ID} keeps this machine
 * the default: work that names no runner stays here, and only work that names one goes to it.
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
