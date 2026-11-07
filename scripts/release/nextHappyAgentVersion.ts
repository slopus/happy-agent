// Self-contained so the release workflow can run it with Node's own type stripping before
// installing dependencies. Fetch tags first, then:
// `node scripts/release/nextHappyAgentVersion.ts preview` (or `stable`).
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type HappyAgentReleaseChannel = "stable" | "preview";

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/u;

/**
 * The next Happy Agent version, `YYYY.M.C` or `YYYY.M.C-preview.N`, from the existing release
 * tags. C counts this UTC month's stable releases; only a stable release moves it. A preview
 * previews the next stable C and takes the next unused N for it. Tags from other months,
 * including the legacy `v0.4.x` releases, never count.
 */
export function nextHappyAgentVersion(
    tags: readonly string[],
    channel: HappyAgentReleaseChannel,
    now: Date,
): string {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    let stable = 0;
    const previews = new Map<number, number>();
    for (const tag of tags) {
        const match = RELEASE_TAG.exec(tag.trim());
        if (match === null || Number(match[1]) !== year || Number(match[2]) !== month) continue;
        const count = Number(match[3]);
        if (match[4] === undefined) {
            stable = Math.max(stable, count);
        } else {
            previews.set(count, Math.max(previews.get(count) ?? 0, Number(match[4])));
        }
    }
    const version = `${year}.${month}.${stable + 1}`;
    if (channel === "stable") return version;
    return `${version}-preview.${(previews.get(stable + 1) ?? 0) + 1}`;
}

function main(channel: string | undefined): void {
    if (channel !== "stable" && channel !== "preview") {
        throw new Error("Pass the release channel: stable or preview.");
    }
    const tags = execFileSync("git", ["tag", "--list", "v[0-9]*"], { encoding: "utf8" });
    console.log(nextHappyAgentVersion(tags.split("\n"), channel, new Date()));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv[2]);
}
