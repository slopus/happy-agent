// Build-time TypeBox schema for the private, same-executable detached reload handoff.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(
    new URL("../../../../happy-agent-modules/package.json", import.meta.url),
);
const { Type } = require("@sinclair/typebox");
const exact = { additionalProperties: false };
const pid = Type.Integer({ minimum: 1, maximum: 2147483647 });
const process = Type.Object(
    { pid, identity: Type.String({ minLength: 1, maxLength: 16384 }) },
    exact,
);
const handoff = Type.Object(
    {
        nonce: Type.String({
            pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
        }),
        caller: process,
        workerPid: pid,
        target: Type.Union([
            Type.Object(
                { ...process.properties, instance: Type.String({ minLength: 1, maxLength: 128 }) },
                exact,
            ),
            Type.Null(),
        ]),
    },
    exact,
);
writeFileSync(
    new URL("schemas.json", import.meta.url),
    JSON.stringify({ handoff }, null, 2) + "\n",
);
