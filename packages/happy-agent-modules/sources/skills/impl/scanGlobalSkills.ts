import { createHash } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import type { GlobalSkill, GlobalSkillFile } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import { skillRelativePathSchema } from "@slopus/happy-agent-client";
import { GlobalSkillsError } from "../GlobalSkillsError.js";
import { skillEntrySchema } from "../Skills.js";
import { parseSkillFrontmatter } from "./parseSkillFrontmatter.js";
import { readGlobalSkillFile, withinSkill } from "./readGlobalSkillFile.js";

export interface ScannedGlobalSkill {
    path: string;
    canonical: string;
    name: string;
    description: string;
    status: GlobalSkill["status"];
    error: string | null;
    content: string | null;
    instructions: string | null;
    files: GlobalSkillFile[];
    stamp: string;
    filesError: boolean;
}
export interface GlobalSkillScan {
    skills: ScannedGlobalSkill[];
    paths: Map<string, string>;
    directories: string[];
    rootStamp: string;
    unreadable: string[];
}
const MAX_ENTRIES = 1_000_000;
const MAX_DIRECTORIES = 200_000;
const MAX_SKILLS = 100_000;

/** Bounded recursive discovery. Directory aliases are distinct identities; ancestor cycles are skipped. */
export async function scanGlobalSkills(root: string): Promise<GlobalSkillScan> {
    const result: GlobalSkillScan = {
        skills: [],
        paths: new Map(),
        directories: [],
        rootStamp: "",
        unreadable: [],
    };
    let rootCanonical: string;
    try {
        rootCanonical = await realpath(root);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
        throw new GlobalSkillsError(503, "internal", "The global skills directory cannot be read.");
    }
    const queue = [
        { canonical: rootCanonical, path: "", ancestors: new Set<string>(), discover: true },
    ];
    const initialRoot = await lstat(rootCanonical).catch(() => undefined);
    if (initialRoot === undefined)
        throw new GlobalSkillsError(503, "internal", "The global skills directory cannot be read.");
    const files: { path: string; canonical: string; stamp: string; file?: GlobalSkillFile }[] = [];
    const unreadable = result.unreadable;
    const installedPaths = new Set<string>();
    let entries = 0;
    let documentBytes = 0;
    const deadline = Date.now() + 60_000;
    for (let index = 0; index < queue.length; index += 1) {
        if (queue.length > MAX_DIRECTORIES || Date.now() > deadline)
            throw new GlobalSkillsError(
                503,
                "internal",
                "The global skills directory exceeds the scan limit.",
            );
        const directory = queue[index]!;
        // Hidden/vendor directories cannot install skills, but an installed skill's inventory
        // still includes their supporting files.
        if (
            !directory.discover &&
            !ancestorsOf(directory.path).some((path) => installedPaths.has(path))
        )
            continue;
        if (directory.ancestors.has(directory.canonical)) continue;
        result.directories.push(directory.canonical);
        const ancestors = new Set(directory.ancestors).add(directory.canonical);
        let hasDocument = false;
        try {
            const handle = await opendir(directory.canonical);
            for await (const entry of handle) {
                if (++entries > MAX_ENTRIES || Date.now() > deadline)
                    throw new GlobalSkillsError(
                        503,
                        "internal",
                        "The global skills directory exceeds the scan limit.",
                    );
                const path = directory.path ? `${directory.path}/${entry.name}` : entry.name;
                if (!Value.Check(skillRelativePathSchema, path)) continue;
                const candidate = join(directory.canonical, entry.name);
                let info;
                try {
                    info = await lstat(candidate);
                } catch {
                    if (directory.path === "")
                        throw new GlobalSkillsError(
                            503,
                            "internal",
                            "The global skills directory changed during the scan.",
                        );
                    unreadable.push(directory.path);
                    continue;
                }
                const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`;
                result.paths.set(path, stamp);
                if (entry.name === "SKILL.md" && directory.path !== "" && directory.discover)
                    hasDocument = true;
                if (info.isDirectory() || info.isSymbolicLink()) {
                    try {
                        const canonical = await realpath(candidate);
                        const linked = info.isDirectory() ? info : await lstat(canonical);
                        if (linked.isDirectory()) {
                            if (!ancestors.has(canonical))
                                queue.push({
                                    canonical,
                                    path,
                                    ancestors,
                                    discover:
                                        directory.discover &&
                                        !entry.name.startsWith(".") &&
                                        entry.name !== "node_modules",
                                });
                            continue;
                        }
                    } catch {
                        unreadable.push(directory.path);
                    }
                }
                files.push({
                    path,
                    canonical: candidate,
                    stamp,
                    ...(info.isFile()
                        ? { file: { path, size: info.size, modifiedAt: info.mtimeMs } }
                        : {}),
                });
            }
        } catch (error) {
            if (error instanceof GlobalSkillsError) throw error;
            if (directory.path === "")
                throw new GlobalSkillsError(
                    503,
                    "internal",
                    "The global skills directory cannot be read.",
                );
            unreadable.push(directory.path);
            // A known SKILL.md in a directory that became unreadable remains an installed record.
            try {
                hasDocument =
                    directory.discover &&
                    (await lstat(join(directory.canonical, "SKILL.md"))).isFile();
            } catch {
                /* Reconciler retains unreadable previous records. */
            }
        }
        if (!hasDocument) continue;
        if (result.skills.length >= MAX_SKILLS)
            throw new GlobalSkillsError(
                503,
                "internal",
                "Too many global skills are installed to scan safely.",
            );
        const skill: ScannedGlobalSkill = {
            path: directory.path,
            canonical: directory.canonical,
            name: basename(directory.path),
            description: "",
            status: "unreadable",
            error: "The skill document cannot be read.",
            content: null,
            instructions: null,
            files: [],
            stamp: "",
            filesError: false,
        };
        try {
            if ((await lstat(join(directory.canonical, "SKILL.md"))).isSymbolicLink())
                throw new Error("Linked document");
            const bytes = await readGlobalSkillFile(directory.canonical, "SKILL.md", 256 * 1024);
            documentBytes += bytes.length;
            if (documentBytes > 256 * 1024 * 1024)
                throw new GlobalSkillsError(
                    503,
                    "internal",
                    "The skill documents exceed the scan memory limit.",
                );
            skill.content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            skill.status = "invalid";
            skill.error = "The skill needs valid name and description frontmatter.";
            const metadata = parseSkillFrontmatter(skill.content, basename(directory.canonical));
            if (
                Value.Check(skillEntrySchema, {
                    ...metadata,
                    location: join(directory.canonical, "SKILL.md"),
                    source: "user",
                })
            ) {
                const normalized = skill.content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
                const lines = normalized.split("\n");
                const end = lines.findIndex(
                    (line, lineIndex) => lineIndex > 0 && /^[ \t]*---[ \t]*(?:#.*)?$/u.test(line),
                );
                skill.name = metadata.name;
                skill.description = metadata.description;
                skill.instructions = lines.slice(end + 1).join("\n");
                skill.status = "ready";
                skill.error = null;
            }
        } catch (error) {
            if (error instanceof GlobalSkillsError && error.status === 503) throw error;
            /* The current unreadable or invalid state is intentional, never stale metadata. */
        }
        result.skills.push(skill);
        installedPaths.add(skill.path);
    }
    result.skills.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // Assign each path to its nearest installed ancestor once. Filtering the entire inventory
    // separately for every skill made a flat catalog quadratic.
    const byPath = new Map(result.skills.map((skill) => [skill.path, skill]));
    const ownerOf = (path: string): ScannedGlobalSkill | undefined => {
        let current = path;
        while (current !== "") {
            const skill = byPath.get(current);
            if (skill !== undefined) return skill;
            const slash = current.lastIndexOf("/");
            current = slash < 0 ? "" : current.slice(0, slash);
        }
        return undefined;
    };
    const stamps = new Map<string, [string, string][]>();
    for (const [path, stamp] of result.paths) {
        const owner = ownerOf(path);
        if (owner === undefined) continue;
        const owned = stamps.get(owner.path) ?? [];
        owned.push([path, stamp]);
        stamps.set(owner.path, owned);
    }
    for (const file of files) {
        const owner = ownerOf(file.path);
        if (
            owner !== undefined &&
            file.file !== undefined &&
            withinSkill(owner.canonical, file.canonical)
        ) {
            owner.files.push({ ...file.file, path: file.path.slice(owner.path.length + 1) });
        }
    }
    for (const path of unreadable) {
        for (const parent of [path, ...ancestorsOf(path)]) {
            const skill = byPath.get(parent);
            if (skill !== undefined) skill.filesError = true;
        }
    }
    for (const skill of result.skills) {
        skill.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const ownedPaths = stamps.get(skill.path) ?? [];
        skill.stamp = hash(
            JSON.stringify([
                skill.canonical,
                skill.content,
                skill.status,
                skill.filesError,
                ownedPaths.sort(),
            ]),
        );
    }
    const rootInfo = await lstat(rootCanonical).catch(() => undefined);
    if (
        rootInfo === undefined ||
        rootInfo.dev !== initialRoot.dev ||
        rootInfo.ino !== initialRoot.ino
    )
        throw new GlobalSkillsError(
            503,
            "internal",
            "The global skills directory changed during the scan.",
        );
    result.rootStamp = hash(
        JSON.stringify([rootCanonical, rootInfo.dev, rootInfo.ino, [...result.paths].sort()]),
    );
    return result;
}
function hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function ancestorsOf(path: string): string[] {
    const ancestors: string[] = [];
    for (let slash = path.lastIndexOf("/"); slash >= 0; slash = path.lastIndexOf("/", slash - 1)) {
        ancestors.push(path.slice(0, slash));
        if (slash === 0) break;
    }
    return ancestors;
}
