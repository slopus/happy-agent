import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/*
 * Kept free of the agent runtime: the crash supervisor and lifecycle commands read the stamp
 * without loading anything else, through the `@slopus/happy-agent-modules/data-version` export.
 */

const MAX_STAMP_BYTES = 4 * 1024;
const versionSchema = Type.String({ minLength: 1, maxLength: 128 });

/**
 * `<happyHome>/agent/data-version.json`: which Happy Agent releases can open this home's data,
 * readable without opening or migrating the databases. The migration ledger inside the databases
 * decides whether a daemon may open them; this file lets a launcher or installer, which cannot run
 * a release to ask it, avoid choosing one that would be refused.
 */
const happyAgentDataVersionSchema = Type.Object(
    {
        version: Type.Literal(1),
        /** The release that most recently opened the data. */
        writtenBy: versionSchema,
        /**
         * The oldest release that may open the data. Raised, never lowered, to a release's own
         * version before it applies any migration, so every older release is refused.
         */
        minimumVersion: versionSchema,
        updatedAt: Type.String({ minLength: 1, maxLength: 64 }),
    },
    { additionalProperties: false },
);
export type HappyAgentDataVersion = Static<typeof happyAgentDataVersionSchema>;

/** Where the stamp lives inside the daemon's private directory, `<happyHome>/agent`. */
export function happyAgentDataVersionPath(agentHome: string): string {
    return join(agentHome, "data-version.json");
}

/** The stamp, or undefined when it is absent or unreadable. It is advisory, never authority. */
export async function readHappyAgentDataVersion(
    path: string,
): Promise<HappyAgentDataVersion | undefined> {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
        return undefined;
    }
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_STAMP_BYTES) return undefined;
        const bytes = Buffer.alloc(MAX_STAMP_BYTES + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_STAMP_BYTES) return undefined;
        const parsed: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
        return Value.Check(happyAgentDataVersionSchema, parsed) ? parsed : undefined;
    } catch {
        return undefined;
    } finally {
        await handle.close();
    }
}

/**
 * Record that `version` opened the data. With `raiseMinimum`, the data is about to be migrated
 * by `version`, so no older release may open it afterwards. A home with no stamp yet starts at
 * `version`: what earlier releases wrote is unknown, and keeping a newer daemon is safer than
 * handing the data to an older one. A development build has no release version, so it never
 * raises the minimum; the next release to migrate the data does.
 */
export async function stampHappyAgentDataVersion(
    path: string,
    version: string,
    options: { readonly raiseMinimum: boolean },
): Promise<HappyAgentDataVersion> {
    const existing = await readHappyAgentDataVersion(path);
    const release = parseVersion(version) !== undefined;
    const minimumVersion =
        existing === undefined
            ? release
                ? version
                : "0.0.0"
            : release &&
                options.raiseMinimum &&
                compareHappyAgentVersions(version, existing.minimumVersion) > 0
              ? version
              : existing.minimumVersion;
    const stamp: HappyAgentDataVersion = {
        version: 1,
        writtenBy: version,
        minimumVersion,
        updatedAt: new Date().toISOString(),
    };
    const contents = JSON.stringify(Value.Parse(happyAgentDataVersionSchema, stamp));
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
        const file = await open(temporaryPath, "wx", 0o600);
        try {
            await writeFile(file, contents);
            // The stamp must be on disk before the migration it announces.
            await file.sync();
        } finally {
            await file.close();
        }
        await rename(temporaryPath, path);
    } finally {
        await unlink(temporaryPath).catch(() => undefined);
    }
    return stamp;
}

/**
 * Order two Happy Agent versions, `YYYY.M.C` or `YYYY.M.C-preview.N`, as semantic versions: a
 * preview comes before its release, and every CalVer release follows the legacy `0.4.x` ones. A version that does not parse orders after every one that does and
 * equal to another that does not, so an unknown version is never taken for an older release.
 */
export function compareHappyAgentVersions(left: string, right: string): number {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (a === undefined || b === undefined) {
        return a === undefined ? (b === undefined ? 0 : 1) : -1;
    }
    for (let index = 0; index < 3; index += 1) {
        const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
        if (difference !== 0) return Math.sign(difference);
    }
    if (a.prerelease.length === 0 || b.prerelease.length === 0) {
        return Math.sign(b.prerelease.length - a.prerelease.length);
    }
    for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
        const x = a.prerelease[index];
        const y = b.prerelease[index];
        if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
        if (x === y) continue;
        const xNumeric = /^\d+$/.test(x);
        const yNumeric = /^\d+$/.test(y);
        if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y));
        if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
        return x < y ? -1 : 1;
    }
    return 0;
}

function parseVersion(
    version: string,
): { readonly core: readonly number[]; readonly prerelease: readonly string[] } | undefined {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        version.trim(),
    );
    if (match === null) return undefined;
    return {
        core: [Number(match[1]), Number(match[2]), Number(match[3])],
        prerelease: match[4] === undefined ? [] : match[4].split("."),
    };
}

/** The refusal a person reads when an older release finds data a newer one wrote. */
export function describeHappyAgentNewerData(stamp: HappyAgentDataVersion | undefined): string {
    if (stamp === undefined)
        return "This data was written by a newer Happy Agent; update to continue.";
    const update =
        compareHappyAgentVersions(stamp.minimumVersion, stamp.writtenBy) < 0
            ? `update to version ${stamp.minimumVersion} or newer to continue`
            : "update to continue";
    return `This data was written by a newer Happy Agent (version ${stamp.writtenBy}); ${update}.`;
}

/**
 * The exit status of a daemon that refused data a newer release wrote (`EX_DATAERR`). Restarting
 * cannot help, so the crash supervisor and `start` stop instead of trying again.
 */
export const HAPPY_AGENT_NEWER_DATA_EXIT_CODE = 65;

/** A daemon refused to open data that a newer Happy Agent release migrated. */
export class HappyAgentNewerDataError extends Error {
    readonly exitCode = HAPPY_AGENT_NEWER_DATA_EXIT_CODE;
    /** What the stamp said when the refusal was made, if it could be read. */
    readonly stamp: HappyAgentDataVersion | undefined;

    constructor(stamp: HappyAgentDataVersion | undefined, options: { cause?: unknown } = {}) {
        super(describeHappyAgentNewerData(stamp), options);
        this.name = "HappyAgentNewerDataError";
        this.stamp = stamp;
    }
}
