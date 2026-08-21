const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
    cjs: "javascript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    bash: "shell",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "shell",
    zsh: "shell",
};

export function detectCodexDiffLanguage(path: string): string | undefined {
    const basename = path.split(/[\\/]/).at(-1) ?? path;
    const extension = basename.includes(".")
        ? basename.split(".").at(-1)?.toLowerCase()
        : undefined;
    return extension === undefined ? undefined : (LANGUAGE_BY_EXTENSION[extension] ?? extension);
}
