/**
 * A glob as the case-insensitive expression matching a whole relative path: `**` crosses folders,
 * also matching none of them before a slash, `*` and `?` stay within one name, `[...]` is one of a set of
 * characters (`[!...]` none of them), and `{a,b}` offers alternatives. Everything else is literal.
 */
export function vaultGlob(pattern: string): RegExp {
    return new RegExp(`^${translate(pattern)}$`, "iu");
}

function translate(pattern: string): string {
    let expression = "";
    for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index]!;
        if (character === "*") {
            if (pattern[index + 1] === "*") {
                index += pattern[index + 2] === "/" ? 2 : 1;
                expression += pattern[index] === "/" ? "(?:[^/]*/)*" : ".*";
                continue;
            }
            expression += "[^/]*";
        } else if (character === "?") expression += "[^/]";
        else if (character === "[") {
            const close = pattern.indexOf("]", index + 2);
            if (close < 0) {
                expression += "\\[";
                continue;
            }
            let set = pattern.slice(index + 1, close);
            const negated = set.startsWith("!") || set.startsWith("^");
            if (negated) set = set.slice(1);
            expression += `[${negated ? "^/" : ""}${set.replace(/[\\\]^]/g, "\\$&")}]`;
            index = close;
        } else if (character === "{") {
            const close = pattern.indexOf("}", index);
            if (close < 0) {
                expression += "\\{";
                continue;
            }
            expression += `(?:${pattern
                .slice(index + 1, close)
                .split(",")
                .map(translate)
                .join("|")})`;
            index = close;
        } else expression += character.replace(/[.+^$()|\\\]{}]/g, "\\$&");
    }
    return expression;
}
