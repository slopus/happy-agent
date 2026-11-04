// Self-contained so the release workflow can run it with Node's own type stripping before
// installing dependencies: `node scripts/release/validateReleaseNotes.ts v0.4.106`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_NOTES_SECTIONS = ["Features", "Fixes", "Thanks"] as const;
export const RELEASE_NOTES_MAX_BULLETS_PER_SECTION = 3;
export const RELEASE_NOTES_MAX_WORDS_PER_BULLET = 6;
export const RELEASE_NOTES_MAX_THANKS = 8;

const MARKDOWN_CHARACTERS = /[`*_[\]<>#~|\\]/u;
/**
 * One person the release thanks: `@login` and the issues or pull requests in Happy's own
 * repositories they are credited for. Happy Desktop's update card reads exactly this shape.
 */
const THANKS_BULLET =
    /^@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?: slopus\/(?:happy|happy-agent|happy-desktop)#[1-9]\d{0,6})+$/u;

export function releaseNotesPath(tag: string): string {
    return `release-notes/${tag}.md`;
}

/** Returns every problem with a short per-release notes file; an empty list means it is valid. */
export function validateReleaseNotes(markdown: string): string[] {
    const problems: string[] = [];
    const counts = new Map<string, number>();
    const thanked = new Set<string>();
    let section: string | undefined;

    for (const [index, rawLine] of markdown.replace(/\r\n/gu, "\n").split("\n").entries()) {
        const line = rawLine.trimEnd();
        const where = `Line ${index + 1}`;
        if (line.length === 0) {
            continue;
        }
        const heading = /^## (.+)$/u.exec(line)?.[1]?.trim();
        if (heading !== undefined) {
            if (!RELEASE_NOTES_SECTIONS.some((name) => name === heading)) {
                problems.push(
                    `${where}: only "## Features", "## Fixes", and "## Thanks" sections are allowed.`,
                );
                section = undefined;
            } else if (counts.has(heading)) {
                problems.push(`${where}: "## ${heading}" appears more than once.`);
                section = undefined;
            } else {
                counts.set(heading, 0);
                section = heading;
            }
            continue;
        }
        const match = /^-(?: (.*))?$/u.exec(line);
        if (match === null) {
            problems.push(
                `${where}: expected a "## Features" or "## Fixes" heading or a "- " bullet.`,
            );
            continue;
        }
        if (section === undefined) {
            problems.push(`${where}: bullets must sit under "## Features" or "## Fixes".`);
            continue;
        }
        const bullet = (match[1] ?? "").trim();
        const count = (counts.get(section) ?? 0) + 1;
        counts.set(section, count);
        if (section === "Thanks") {
            if (count === RELEASE_NOTES_MAX_THANKS + 1) {
                problems.push(
                    `${where}: "## Thanks" has more than ${RELEASE_NOTES_MAX_THANKS} people.`,
                );
            }
            const login = THANKS_BULLET.exec(bullet)?.[1];
            if (login === undefined) {
                problems.push(
                    `${where}: thank someone as "- @login slopus/happy-agent#73", with one or more issues or pull requests in slopus/happy, happy-agent, or happy-desktop.`,
                );
            } else if (thanked.has(login.toLowerCase())) {
                problems.push(`${where}: @${login} is thanked more than once.`);
            } else {
                thanked.add(login.toLowerCase());
            }
            continue;
        }
        if (count === RELEASE_NOTES_MAX_BULLETS_PER_SECTION + 1) {
            problems.push(
                `${where}: "## ${section}" has more than ${RELEASE_NOTES_MAX_BULLETS_PER_SECTION} bullets.`,
            );
        }
        if (bullet.length === 0) {
            problems.push(`${where}: the bullet is empty.`);
            continue;
        }
        if (MARKDOWN_CHARACTERS.test(bullet)) {
            problems.push(`${where}: bullets are plain text, without Markdown or HTML.`);
        }
        const words = bullet.split(/\s+/u).length;
        if (words > RELEASE_NOTES_MAX_WORDS_PER_BULLET) {
            problems.push(
                `${where}: the bullet has ${words} words; keep it to ${RELEASE_NOTES_MAX_WORDS_PER_BULLET}.`,
            );
        }
    }
    return problems;
}

function main(tag: string | undefined): void {
    if (tag === undefined || !/^v\d+\.\d+\.\d+(-preview\.\d+)?$/u.test(tag)) {
        throw new Error("Pass the release tag, for example v0.4.106 or v0.4.106-preview.5.");
    }
    const path = releaseNotesPath(tag);
    let markdown: string;
    try {
        markdown = readFileSync(path, "utf8");
    } catch {
        console.error(`${path} is missing. Commit the release's short notes to main first.`);
        process.exit(1);
    }
    const problems = validateReleaseNotes(markdown);
    if (problems.length > 0) {
        console.error(
            `${path} is not valid:\n${problems.map((problem) => `  ${problem}`).join("\n")}`,
        );
        process.exit(1);
    }
    console.log(`${path} is valid.`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv[2]);
}
