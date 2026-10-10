// Build-time TypeBox definitions for the Happy relay's external boundary.
// Rust consumes the serialized result; no JavaScript runs in the executable.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(
    new URL("../../../../happy-agent-modules/package.json", import.meta.url),
);
const { Type } = require("@sinclair/typebox");
const string = () => Type.String();
const schemas = {
    open: Type.Object({
        sid: Type.String({ minLength: 1, maxLength: 1024 }),
        pingInterval: Type.Integer({ minimum: 1, maximum: 120000 }),
        pingTimeout: Type.Integer({ minimum: 1, maximum: 120000 }),
    }),
    connected: Type.Object({ sid: Type.String({ minLength: 1, maxLength: 1024 }) }),
    subscription: Type.Union([
        Type.Object({
            result: Type.Literal("success"),
            subscribed: Type.Array(string(), { maxItems: 500 }),
            missing: Type.Array(string(), { maxItems: 500 }),
        }),
        Type.Object({ result: Type.Literal("error"), reason: string() }),
    ]),
    update: Type.Object({
        body: Type.Object({
            t: string(),
            id: Type.Optional(string()),
            sid: Type.Optional(string()),
        }),
    }),
    rpc: Type.Object({ method: string() }),
};
writeFileSync(
    new URL("socket_schemas.json", import.meta.url),
    JSON.stringify(schemas, null, 2) + "\n",
);
