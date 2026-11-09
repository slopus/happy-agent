import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    userDeviceIdSchema,
    userDeviceKindSchema,
    userEnvironmentSchema,
    type StoredUserEnvironment,
} from "../UserEnvironment.js";

/** The columns every device read selects, in the shape the database returns them. */
const userDeviceEnvironmentRowSchema = Type.Object({
    device_id: userDeviceIdSchema,
    device_kind: Type.Union([userDeviceKindSchema, Type.Null()]),
    environment_json: Type.String(),
    updated_at: Type.Integer({ minimum: 0 }),
    reported_at: Type.Integer({ minimum: 0 }),
});

/** A stored row as its device environment; a row that does not parse is a corrupt database. */
export function userDeviceEnvironmentFromRow(row: unknown): StoredUserEnvironment {
    if (!Value.Check(userDeviceEnvironmentRowSchema, row)) {
        throw new Error("A stored user environment is invalid.");
    }
    const environment: unknown = JSON.parse(row.environment_json);
    if (!Value.Check(userEnvironmentSchema, environment)) {
        throw new Error("A stored user environment is invalid.");
    }
    return {
        deviceId: row.device_id,
        ...(row.device_kind === null ? {} : { deviceKind: row.device_kind }),
        environment,
        updatedAt: row.updated_at,
        reportedAt: row.reported_at,
    };
}
