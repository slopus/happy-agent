/**
 * Portable names a workspace carries into Git and the filesystem.
 *
 * A workspace name is written the way a person writes a title. The storage key and the branch are
 * derived from it in one readable kebab-case form, so the folder someone opens and the branch other
 * software reads both say the same thing.
 */
const MAX_READABLE_KEY_LENGTH = 48;

/** Case- and normalization-insensitive key used to decide whether two names are the same name. */
export function workspaceNameKey(name: string): string {
    return name.normalize("NFKC").toLocaleLowerCase("en-US");
}

/** Portable folder key for one workspace. */
export function workspaceStorageKey(value: string): string {
    return readableKey(value);
}

/**
 * The branch Happy Agent manages for a workspace.
 *
 * It is built from the workspace's own name rather than from the folder the checkout happens to
 * sit in, because other software reads the branch name and expects it to describe the work.
 */
export function workspaceBranchName(name: string): string {
    return `worktree/${readableKey(name)}`;
}

function readableKey(value: string): string {
    const readable = transliterateCyrillic(value)
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLocaleLowerCase("en-US")
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .slice(0, MAX_READABLE_KEY_LENGTH)
        .replace(/-+$/gu, "");
    return readable.length === 0 ? "workspace" : readable;
}

const CYRILLIC_REPLACEMENTS: Record<string, string> = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "yo",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "ts",
    ч: "ch",
    ш: "sh",
    щ: "sch",
    ъ: "",
    ы: "y",
    ь: "",
    э: "e",
    ю: "yu",
    я: "ya",
};

function transliterateCyrillic(value: string): string {
    return [...value]
        .map((character) => {
            const replacement = CYRILLIC_REPLACEMENTS[character.toLocaleLowerCase("ru-RU")];
            return replacement ?? character;
        })
        .join("");
}
