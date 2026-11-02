import type { PlatformPath } from "node:path";

import { computePermissions, type Compute } from "@slopus/happy-agent-compute";

import type { MirroredSkill, MirroredSkillFile } from "./collectMirroredSkills.js";

const PRODUCT = computePermissions("full_access");
/** Where a skill is assembled before it appears; discovery skips dot-directories. */
const PARTIAL_PREFIX = ".partial-";

/** What one sync changed on the machine. */
export interface SkillMirrorChanges {
    readonly written: readonly string[];
    readonly removed: readonly string[];
}

/**
 * Make `root` on a machine hold exactly these skills, sending only the ones it lacks.
 *
 * Every skill sits in a folder named for its content, so a folder that is already there with its
 * document is already right and is left alone. A new one is assembled under a dot-name discovery
 * skips and then moved into place, so an agent never sees half a skill. Anything else in the root
 * is removed, including what an interrupted sync left behind. Files are made read-only where the
 * machine supports it, and keep their executable bit so a skill's scripts still run.
 */
export async function writeSkillMirror(
    machine: Compute,
    paths: PlatformPath,
    root: string,
    skills: readonly MirroredSkill[],
    options: { readonly readOnly: boolean },
): Promise<SkillMirrorChanges> {
    const fs = machine.fs;
    await fs.mkdir(PRODUCT, root, { recursive: true });
    const wanted = new Map(skills.map((skill) => [skill.folder, skill]));
    const present = new Set(await fs.readdir(PRODUCT, root));
    const removed: string[] = [];
    for (const name of present) {
        if (wanted.has(name)) continue;
        await fs.rm(PRODUCT, paths.join(root, name), { recursive: true, force: true });
        removed.push(name);
    }
    const kept = [...wanted.keys()].filter((folder) => present.has(folder));
    const documents = await fs.lstatMany(
        PRODUCT,
        kept.map((folder) => paths.join(root, folder, "SKILL.md")),
    );
    const complete = new Set(kept.filter((_folder, index) => documents[index]?.isFile === true));
    const written: string[] = [];
    for (const skill of skills) {
        if (complete.has(skill.folder)) continue;
        const destination = paths.join(root, skill.folder);
        const partial = paths.join(root, `${PARTIAL_PREFIX}${skill.folder}`);
        await fs.rm(PRODUCT, destination, { recursive: true, force: true });
        await fs.rm(PRODUCT, partial, { recursive: true, force: true });
        await writeFiles(machine, paths, partial, skill.files, options);
        await fs.move(PRODUCT, partial, destination);
        written.push(skill.folder);
    }
    return { written, removed };
}

/** The file in a copied folder that names the content it holds. */
const CONTENT_MARKER = ".happy-agent-content";

/**
 * Make `destination` on a machine hold exactly this folder, unless it already does.
 *
 * The folder's hash is kept in a marker file inside it, so an unchanged folder costs one small
 * read. A changed one is assembled beside it under a dot-name and swapped in. Returns whether
 * anything was written.
 */
export async function writeMirroredFolder(
    machine: Compute,
    paths: PlatformPath,
    destination: string,
    folder: { readonly files: readonly MirroredSkillFile[]; readonly hash: string },
    options: { readonly readOnly: boolean },
): Promise<boolean> {
    const fs = machine.fs;
    const marker = paths.join(destination, CONTENT_MARKER);
    const current = await fs.readFile(PRODUCT, marker).catch(() => undefined);
    if (current === folder.hash) return false;
    const partial = paths.join(
        paths.dirname(destination),
        `${PARTIAL_PREFIX}${paths.basename(destination)}`,
    );
    await fs.rm(PRODUCT, partial, { recursive: true, force: true });
    await writeFiles(machine, paths, partial, folder.files, options);
    await fs.writeFile(PRODUCT, paths.join(partial, CONTENT_MARKER), folder.hash);
    await fs.rm(PRODUCT, destination, { recursive: true, force: true });
    await fs.move(PRODUCT, partial, destination);
    return true;
}

async function writeFiles(
    machine: Compute,
    paths: PlatformPath,
    root: string,
    files: readonly MirroredSkillFile[],
    options: { readonly readOnly: boolean },
): Promise<void> {
    const fs = machine.fs;
    await fs.mkdir(PRODUCT, root, { recursive: true });
    for (const file of files) {
        const target = paths.join(root, ...file.path.split("/"));
        await fs.mkdir(PRODUCT, paths.dirname(target), { recursive: true });
        await fs.writeFile(PRODUCT, target, await file.read());
        if (options.readOnly) await fs.chmod(PRODUCT, target, file.executable ? 0o555 : 0o444);
    }
}
