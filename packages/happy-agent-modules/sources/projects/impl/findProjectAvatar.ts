import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { GitModule } from "../../git/index.js";
import {
    MAX_AVATAR_BYTES,
    normalizeProjectAvatar,
    readBoundedResponseBytes,
} from "./normalizeProjectAvatar.js";

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
const SKIPPED_DIRECTORIES = new Set([
    ".git",
    ".next",
    "build",
    "cache",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
]);
const DISCOVERY_BUDGET_MS = 2_000;
const DISCOVERY_ENTRY_BUDGET = 200;

/**
 * Looks for a picture the repository already keeps of itself.
 *
 * A project's own logo is the best avatar it can have, and repositories keep one in a small,
 * predictable set of places. The search is bounded in both entries and time because it runs while
 * someone is waiting for a project to appear, and finding nothing is an ordinary outcome.
 */
export async function findRepositoryAvatar(root: string): Promise<Buffer | undefined> {
    const deadline = Date.now() + DISCOVERY_BUDGET_MS;
    const candidates: { path: string; score: number }[] = [];
    const directories = [
        root,
        ...[".github", "assets", "branding", "docs", "public", "resources", "static"].map(
            (directory) => join(root, directory),
        ),
        join(root, "src"),
    ];
    let inspected = 0;
    for (const directory of directories) {
        if (inspected >= DISCOVERY_ENTRY_BUDGET || Date.now() >= deadline) break;
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (Date.now() >= deadline) break;
            inspected += 1;
            if (inspected > DISCOVERY_ENTRY_BUDGET) break;
            if (entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
            if (entry.isDirectory() && directory === join(root, "src")) {
                let children;
                try {
                    children = await readdir(join(directory, entry.name), { withFileTypes: true });
                } catch {
                    continue;
                }
                for (const child of children) {
                    if (Date.now() >= deadline) break;
                    inspected += 1;
                    if (
                        inspected > DISCOVERY_ENTRY_BUDGET ||
                        !child.isFile() ||
                        child.isSymbolicLink() ||
                        !IMAGE_EXTENSIONS.has(extname(child.name).toLocaleLowerCase())
                    ) {
                        continue;
                    }
                    candidates.push({
                        path: join(directory, entry.name, child.name),
                        score: avatarCandidateScore(child.name, 2),
                    });
                }
                continue;
            }
            if (!entry.isFile() || !IMAGE_EXTENSIONS.has(extname(entry.name).toLocaleLowerCase())) {
                continue;
            }
            candidates.push({
                path: join(directory, entry.name),
                score: avatarCandidateScore(entry.name, directory === root ? 0 : 1),
            });
        }
    }
    for (const candidate of candidates
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
        .slice(0, 32)) {
        if (Date.now() >= deadline) break;
        try {
            const info = await lstat(candidate.path);
            if (!info.isFile() || info.size > MAX_AVATAR_BYTES) continue;
            const bytes = await readFile(candidate.path);
            await normalizeProjectAvatar(bytes);
            return bytes;
        } catch {
            // Try the next deterministic candidate.
        }
    }
    return undefined;
}

/**
 * Asks the hosting service for the owner's picture when the repository has none of its own.
 *
 * Only the three hosts Happy Agent understands are contacted, only over HTTPS, only without redirects,
 * and only for an image served from that host's own avatar domain. Failure is ordinary: a project
 * without a picture is perfectly usable.
 */
export async function findHostingAvatar(
    git: GitModule,
    remote: string,
): Promise<Buffer | undefined> {
    const repository = git.parseHostingRepository(remote);
    if (repository === undefined) return undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, DISCOVERY_BUDGET_MS);
    timeout.unref?.();
    try {
        const metadata = await fetch(metadataUrl(repository), {
            headers: { accept: "application/json", "user-agent": "Happy Agent" },
            redirect: "error",
            signal: controller.signal,
        });
        if (!metadata.ok) return undefined;
        const metadataBytes = await readBoundedResponseBytes(metadata, 1_048_576, controller);
        const json = JSON.parse(metadataBytes.toString("utf8")) as Record<string, unknown>;
        const avatarUrl =
            repository.host === "bitbucket.org"
                ? readNestedString(json, ["links", "avatar", "href"])
                : typeof json.avatar_url === "string"
                  ? json.avatar_url
                  : undefined;
        if (avatarUrl === undefined) return undefined;
        const avatar = new URL(avatarUrl);
        if (
            avatar.protocol !== "https:" ||
            !allowedAvatarHosts(repository.host).has(avatar.hostname)
        ) {
            return undefined;
        }
        const response = await fetch(avatar, {
            headers: { accept: "image/*", "user-agent": "Happy Agent" },
            redirect: "error",
            signal: controller.signal,
        });
        if (!response.ok || response.headers.get("content-type")?.startsWith("image/") !== true) {
            return undefined;
        }
        return await readBoundedResponseBytes(response, MAX_AVATAR_BYTES, controller);
    } catch {
        return undefined;
    } finally {
        clearTimeout(timeout);
    }
}

function metadataUrl(repository: { host: string; owner: string; repository: string }): URL {
    if (repository.host === "github.com") {
        return new URL(`https://api.github.com/users/${encodeURIComponent(repository.owner)}`);
    }
    if (repository.host === "gitlab.com") {
        return new URL(
            `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${repository.owner}/${repository.repository}`)}`,
        );
    }
    return new URL(
        `https://api.bitbucket.org/2.0/repositories/${repository.owner
            .split("/")
            .map(encodeURIComponent)
            .join("/")}/${encodeURIComponent(repository.repository)}`,
    );
}

function allowedAvatarHosts(host: string): ReadonlySet<string> {
    if (host === "github.com") return new Set(["avatars.githubusercontent.com"]);
    if (host === "gitlab.com") return new Set(["gitlab.com", "secure.gravatar.com"]);
    return new Set(["bitbucket.org", "secure.gravatar.com"]);
}

function avatarCandidateScore(name: string, depth: number): number {
    const stem = basename(name, extname(name)).toLocaleLowerCase("en-US");
    const preferred = ["logo", "icon", "app-icon", "appicon", "brand"];
    const index = preferred.indexOf(stem);
    let score = index === -1 ? 0 : 100 - index * 10;
    score -= depth * 10;
    if (/(?:wordmark|banner|screenshot|badge|favicon|dark|light)/u.test(stem)) score -= 60;
    return score;
}

function readNestedString(
    value: Record<string, unknown>,
    path: readonly string[],
): string | undefined {
    let current: unknown = value;
    for (const key of path) {
        if (current === null || typeof current !== "object" || Array.isArray(current)) {
            return undefined;
        }
        current = (current as Record<string, unknown>)[key];
    }
    return typeof current === "string" ? current : undefined;
}
