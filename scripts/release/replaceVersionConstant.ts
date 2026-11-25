/** Set the version an exported `const X_VERSION = "..."` declaration names, and only that one. */
export function replaceVersionConstant(contents: string, version: string): string {
    const declaration = /(export const [A-Z_]+_VERSION = ")([^"]+)(";)/u;
    if (!declaration.test(contents)) {
        throw new Error("Could not find the exported version constant.");
    }
    return contents.replace(declaration, (_match, start: string, _old, end: string) =>
        [start, version, end].join(""),
    );
}
