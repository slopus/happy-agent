import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import {
    documentBodySchema,
    securityDocumentBodySchema,
} from "../../happy-agent-modules/sources/api/ApiSchemas.ts";
import { eventIdSchema } from "../../happy-agent-modules/sources/events/types.ts";

// Build-time reference data only; the released daemon evaluates the serialized
// TypeBox contract in Rust and does not load JavaScript.
const require = createRequire(new URL("../../happy-agent-modules/package.json", import.meta.url));
const { Type } = require("@sinclair/typebox");
const schemas = {
    instructions: documentBodySchema,
    security: securityDocumentBodySchema,
    cursor: eventIdSchema,
    eventLimitText: Type.String({ pattern: "^[1-9][0-9]*$", maxLength: 5 }),
    eventLimit: Type.Integer({ minimum: 1, maximum: 10_000 }),
};
writeFileSync(
    new URL("../sources/product/request_schemas.json", import.meta.url),
    `${JSON.stringify(schemas, null, 2)}\n`,
);
