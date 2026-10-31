import {
    MAX_CHAT_TITLE_CHARS,
    MAX_CHAT_TITLE_WORDS,
    MAX_SLUG_CHARS,
    type TitleNames,
    type TitleNamesWanted,
} from "../Title.js";
import { wantedNames } from "./createNamingRequest.js";

/**
 * Reads the names out of whatever the model said.
 *
 * A model that adds a greeting, a code fence, or a closing remark has still answered the question,
 * so only the tagged text is read and the rest is ignored. Text that is merely too long is
 * shortened rather than rejected: a slightly long name beats no name at all.
 *
 * When only one name was asked for, an answer with no tag at all is read as that name, because a
 * model that simply wrote the name has also answered. When both were asked for there is nothing to
 * fall back on — an untagged blob cannot be split into two names without guessing which is which.
 */
export function parseSuggestedNames(text: string, wanted: TitleNamesWanted): TitleNames {
    const names = wantedNames(wanted);
    const untagged = names.length === 1 ? stripFences(text) : undefined;
    const read = (name: keyof TitleNamesWanted): string | undefined => {
        if (!names.includes(name)) return undefined;
        const answer = normalizeLine(readTag(text, name) ?? untagged ?? "");
        return answer.length === 0 ? undefined : answer;
    };
    const title = keep(read("title"), shortenTitle);
    const slug = keep(read("slug"), toSlug);
    return {
        ...(slug === undefined ? {} : { slug }),
        ...(title === undefined ? {} : { title }),
    };
}

/** A name that survived being tidied, or nothing when tidying left it empty. */
function keep(answer: string | undefined, tidy: (value: string) => string): string | undefined {
    if (answer === undefined) return undefined;
    const name = tidy(answer);
    return name.length === 0 ? undefined : name;
}

function readTag(text: string, tag: string): string | undefined {
    return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "iu").exec(text)?.[1];
}

function shortenTitle(title: string): string {
    const words = title
        .replace(/^#+\s*/u, "")
        .replace(/^["'`]+|["'`.!?:;,\s]+$/gu, "")
        .split(/\s+/u)
        .filter(Boolean)
        .slice(0, MAX_CHAT_TITLE_WORDS);
    const shortened = words.join(" ");
    return shortened.length <= MAX_CHAT_TITLE_CHARS
        ? shortened
        : `${shortened.slice(0, MAX_CHAT_TITLE_CHARS - 1).trimEnd()}…`;
}

/**
 * A name a folder and a Git ref can both carry.
 *
 * The model is asked for kebab-case and usually writes it, but a title-case answer, a path, or a
 * quoted phrase all still say what the work is. Reducing them here means a stray answer costs a
 * tidier name rather than the whole rename.
 */
function toSlug(value: string): string {
    const kebab = value
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "");
    return kebab.length <= MAX_SLUG_CHARS
        ? kebab
        : kebab.slice(0, MAX_SLUG_CHARS).replace(/-+$/u, "");
}

function stripFences(text: string): string {
    return text.replace(/```[a-z]*\n?/giu, "").replace(/```/gu, "");
}

function normalizeLine(value: string): string {
    return value
        .replace(/[\r\n\t]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}
