import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { readGlobalSkillFile } from "./readGlobalSkillFile.js";
import { scanGlobalSkills, type ScannedGlobalSkill } from "./scanGlobalSkills.js";

/** The most skills one machine receives. */
export const MAX_MIRRORED_SKILLS = 100_000;
/** The most files one skill may have and still be copied. */
export const MAX_MIRRORED_SKILL_FILES = 512;
/** The largest file a copied skill may hold. */
export const MAX_MIRRORED_FILE_BYTES = 8 * 1024 * 1024;
/** The most bytes all copied skills together may hold. */
export const MAX_MIRRORED_BYTES = 64 * 1024 * 1024;

/** One file of a skill to copy, read only when a machine needs it. */
export interface MirroredSkillFile {
    /** The path inside the skill, with `/` separators. */
    readonly path: string;
    readonly size: number;
    readonly executable: boolean;
    read(): Promise<Uint8Array>;
}

/** One skill as a machine receives it, in a folder named for its content. */
export interface MirroredSkill {
    readonly name: string;
    /** `<name>-<content hash>`: the same skill always lands in the same folder. */
    readonly folder: string;
    readonly files: readonly MirroredSkillFile[];
}

/** What one collection found, and what it left out and why. */
export interface MirroredSkillSet {
    readonly skills: readonly MirroredSkill[];
    readonly skipped: readonly string[];
}

/** A skill's content hash, kept while its scan stamp is unchanged so unchanged files are not reread. */
export type MirroredSkillHashes = Map<string, string>;

/**
 * The skills this machine offers its own agents, in the order discovery ranks them: the installed
 * global skills that are enabled and ready, then each configured folder's. A name already taken
 * is left out, so a machine receives exactly the skill this machine's agents would use.
 *
 * Collection fails as a whole when a folder cannot be scanned, so a passing failure never looks
 * like every skill in it was removed.
 */
export async function collectMirroredSkills(
    roots: readonly string[],
    unavailable: ReadonlySet<string>,
    hashes: MirroredSkillHashes,
): Promise<MirroredSkillSet> {
    const skills: MirroredSkill[] = [];
    const skipped: string[] = [];
    const names = new Set<string>();
    const stamps = new Set<string>();
    let bytes = 0;
    for (const root of roots) {
        const scan = await scanGlobalSkills(root);
        for (const scanned of scan.skills) {
            if (scanned.status !== "ready" || names.has(scanned.name)) continue;
            if (unavailable.has(join(scanned.canonical, "SKILL.md"))) continue;
            names.add(scanned.name);
            const size = scanned.files.reduce((total, file) => total + file.size, 0);
            const refusal =
                skills.length >= MAX_MIRRORED_SKILLS
                    ? `more than ${String(MAX_MIRRORED_SKILLS)} skills`
                    : scanned.filesError
                      ? "some of its files cannot be read"
                      : scanned.files.length > MAX_MIRRORED_SKILL_FILES
                        ? `more than ${String(MAX_MIRRORED_SKILL_FILES)} files`
                        : scanned.files.some((file) => file.size > MAX_MIRRORED_FILE_BYTES)
                          ? "a file larger than 8 MiB"
                          : bytes + size > MAX_MIRRORED_BYTES
                            ? "the skills together exceed 64 MiB"
                            : undefined;
            if (refusal !== undefined) {
                skipped.push(`${scanned.name}: ${refusal}`);
                continue;
            }
            bytes += size;
            stamps.add(scanned.stamp);
            skills.push(await mirroredSkill(scanned, hashes));
        }
    }
    for (const stamp of [...hashes.keys()]) if (!stamps.has(stamp)) hashes.delete(stamp);
    return { skills, skipped };
}

async function mirroredSkill(
    scanned: ScannedGlobalSkill,
    hashes: MirroredSkillHashes,
): Promise<MirroredSkill> {
    const files = await Promise.all(
        scanned.files.map(async (file): Promise<MirroredSkillFile> => {
            const info = await stat(join(scanned.canonical, file.path));
            return {
                path: file.path,
                size: file.size,
                executable: (info.mode & 0o111) !== 0,
                read: async () =>
                    await readGlobalSkillFile(
                        scanned.canonical,
                        file.path,
                        MAX_MIRRORED_FILE_BYTES,
                    ),
            };
        }),
    );
    let hash = hashes.get(scanned.stamp);
    if (hash === undefined) {
        const digest = createHash("sha256");
        for (const file of files) {
            digest.update(JSON.stringify([file.path, file.executable]));
            digest.update(
                createHash("sha256")
                    .update(await file.read())
                    .digest(),
            );
        }
        hash = digest.digest("hex").slice(0, 16);
        hashes.set(scanned.stamp, hash);
    }
    return { name: scanned.name, folder: `${folderName(scanned.name)}-${hash}`, files };
}

/** A skill name as a folder name on any machine. */
function folderName(name: string): string {
    const slug = name
        .toLowerCase()
        .replaceAll(/[^a-z0-9_-]+/gu, "-")
        .replaceAll(/^-+|-+$/gu, "")
        .slice(0, 64);
    return slug.length === 0 ? "skill" : slug;
}
