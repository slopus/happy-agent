import { readFile } from "node:fs/promises";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { StoredHappyCredentials } from "../HappyCredentials.js";
import type { HappyConnectionTarget } from "./resolveHappyConnectionTarget.js";
import { writeHappyJsonFile } from "./writeHappyJsonFile.js";

const happySettingsSchema = Type.Record(Type.String(), Type.Unknown());

/** Persists the authorized credentials with the Happy server that issued them. */
export async function saveHappyPairingCredentials(
    target: HappyConnectionTarget,
    credentials: StoredHappyCredentials,
): Promise<void> {
    const settings = await readSettings(target.settingsPath);
    await writeHappyJsonFile(target.settingsPath, { ...settings, serverUrl: target.serverUrl });
    await writeHappyJsonFile(target.credentialsPath, credentials);
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
    try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        return Value.Check(happySettingsSchema, parsed) ? parsed : {};
    } catch {
        return {};
    }
}
