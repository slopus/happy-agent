import {
    appletIconUrl,
    appletSchema,
    type Applet,
    type AppletVersion,
} from "@slopus/happy-agent-features";
import { Value } from "@sinclair/typebox/value";

import { readNumber, readOptionalString, readString } from "../session/impl/sqliteRow.js";

export function readAppletRow(
    row: Record<string, unknown>,
    versions: readonly AppletVersion[],
): Applet {
    const sourceDescription = readOptionalString(row, "source_description");
    const iconThumbhash = readString(row, "icon_thumbhash");
    return {
        allowedScopes: Value.Decode(
            appletSchema.properties.allowedScopes,
            JSON.parse(readString(row, "allowed_scopes_json")),
        ),
        name: readString(row, "name"),
        description: readString(row, "description"),
        purpose: readString(row, "purpose"),
        ...(iconThumbhash === "" ? {} : { iconThumbhash }),
        iconUrl: appletIconUrl(readString(row, "name")),
        authorSessionId: readString(row, "author_session_id"),
        ...(sourceDescription === undefined ? {} : { sourceDescription }),
        currentVersion: readNumber(row, "current_version"),
        versions: [...versions],
        createdAt: readNumber(row, "created_at_ms"),
        updatedAt: readNumber(row, "updated_at_ms"),
    };
}

export function readAppletVersionRow(row: Record<string, unknown>): AppletVersion {
    return {
        version: readNumber(row, "version"),
        changeDescription: readString(row, "change_description"),
        createdAt: readNumber(row, "created_at_ms"),
        operationId: readString(row, "operation_id"),
    };
}