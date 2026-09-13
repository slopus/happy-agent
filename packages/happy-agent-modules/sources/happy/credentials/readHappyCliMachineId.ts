import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { HappyCredentials } from "../HappyCredentials.js";
import { parseHappyCredentials } from "./parseHappyCredentials.js";

const settingsSchema = Type.Object(
    {
        machineId: Type.Optional(Type.String()),
        serverUrl: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);

/**
 * The machine Happy CLI registered from this same Happy home, if it registered one.
 *
 * Two daemons run on one computer, this one and Happy CLI's, and Happy gives each its own machine.
 * Naming the other one is what lets the phone put them back together and show the single computer
 * a person actually has.
 */
export async function readHappyCliMachineId(
    happyHome: string,
    account?: { credentials: HappyCredentials; serverUrl: string },
): Promise<string | undefined> {
    try {
        const stored: unknown = JSON.parse(
            await readFile(join(happyHome, "settings.json"), "utf8"),
        );
        if (!Value.Check(settingsSchema, stored)) return undefined;
        if (account !== undefined) {
            const { credentials } = parseHappyCredentials(
                JSON.parse(await readFile(join(happyHome, "access.key"), "utf8")),
            );
            const cliServer = stored.serverUrl ?? "https://api.cluster-fluster.com";
            if (
                credentials.encryption.type !== "dataKey" ||
                account.credentials.encryption.type !== "dataKey" ||
                !Buffer.from(credentials.encryption.publicKey).equals(
                    Buffer.from(account.credentials.encryption.publicKey),
                ) ||
                new URL(cliServer).toString().replace(/\/+$/u, "") !==
                    new URL(account.serverUrl).toString().replace(/\/+$/u, "")
            )
                return undefined;
        }
        const id = stored.machineId;
        return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
    } catch {
        // No Happy CLI beside this daemon, or nothing readable where it keeps its identity.
        // Standing alone is a normal way to run, so there is nothing to report.
        return undefined;
    }
}
