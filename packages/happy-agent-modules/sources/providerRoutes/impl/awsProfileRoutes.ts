import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { DetectedRoute } from "./DetectedRoute.js";
import { homeOf, providerIdFrom, type RouteMachine } from "./RouteMachine.js";

const MAX_CONFIG_BYTES = 1_000_000;
const MAX_PROFILES = 50;
const VENDOR = "Amazon Bedrock";

interface AwsProfile {
    readonly name: string;
    readonly region: string | null;
    /** Single sign-on, whose session may have expired; only a request could tell. */
    readonly sso: boolean;
}

/**
 * Bedrock through the AWS profiles in the shared AWS config file. Only profile names, their
 * region, and whether they use single sign-on are read; the credentials file is never opened, and
 * nothing asks AWS whether a profile works.
 *
 * `bedrock` is the built-in Bedrock provider when this daemon runs it and it finds local AWS
 * credentials; it stands for the default profile. `existing(profile)` names a configured provider
 * already using a profile.
 */
export async function awsProfileRoutes(
    machine: RouteMachine,
    bedrock: { readonly providerId: string; readonly available: boolean } | null,
    existing: (profile: string) => string | undefined,
): Promise<DetectedRoute[]> {
    const path = machine.env["AWS_CONFIG_FILE"]?.trim() || join(homeOf(machine), ".aws", "config");
    const profiles = await readProfiles(path);
    const routes: DetectedRoute[] = [];
    if (bedrock?.available === true) {
        routes.push({
            id: "bedrock",
            kind: "cloud",
            name: "Amazon Bedrock",
            vendors: [VENDOR],
            billing: "pay_per_token",
            account: null,
            endpoint: null,
            status: "ready",
            models: null,
            warning: null,
            providerId: bedrock.providerId,
        });
    }
    for (const profile of profiles) {
        // The default profile is what the built-in provider already uses.
        if (profile.name === "default" && bedrock !== null) continue;
        routes.push({
            id: `aws_profile:${profile.name}`,
            kind: "cloud",
            name: `AWS profile ${profile.name}`,
            vendors: [VENDOR],
            billing: "pay_per_token",
            account: { label: profile.name, email: null, plan: null, count: null },
            endpoint: null,
            status: profile.sso ? "unknown" : "ready",
            models: null,
            warning: null,
            // A provider already using the profile is found by its ID, like any added provider.
            provider: {
                id: existing(profile.name) ?? providerIdFrom("bedrock", profile.name),
                table: {
                    type: "bedrock",
                    name: `Bedrock (${profile.name})`,
                    profile: profile.name,
                    ...(profile.region === null ? {} : { region: profile.region }),
                },
                summary: `Adds Amazon Bedrock with the AWS profile ${profile.name}.`,
            },
        });
    }
    return routes;
}

/** The profiles an AWS config file declares, from its `[default]` and `[profile …]` sections. */
export async function readProfiles(path: string): Promise<AwsProfile[]> {
    let text: string;
    try {
        if ((await stat(path)).size > MAX_CONFIG_BYTES) return [];
        text = await readFile(path, "utf8");
    } catch {
        return [];
    }
    const profiles: { name: string; region: string | null; sso: boolean }[] = [];
    let current: { name: string; region: string | null; sso: boolean } | undefined;
    for (const raw of text.split(/\r?\n/u)) {
        const line = raw.trim();
        if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
        const section = /^\[\s*(?:profile\s+)?([^\]\s][^\]]*?)\s*\]$/u.exec(line);
        if (section !== null) {
            const isProfile = line.startsWith("[profile") || section[1] === "default";
            current = isProfile ? { name: section[1] ?? "", region: null, sso: false } : undefined;
            if (current !== undefined && profiles.length < MAX_PROFILES) profiles.push(current);
            continue;
        }
        const assignment = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/u.exec(line);
        if (current === undefined || assignment === null) continue;
        const [, key = "", value = ""] = assignment;
        if (key === "region" && /^[a-z0-9-]{1,32}$/u.test(value.trim()))
            current.region = value.trim();
        if (key === "sso_session" || key === "sso_start_url") current.sso = true;
    }
    return profiles.filter((profile) => /^[\w.@+-]{1,64}$/u.test(profile.name));
}
