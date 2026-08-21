export function endsAfterOpeningCodeFence(text: string): boolean {
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    let openFence: { marker: string; size: number } | undefined;
    let openingLine = -1;

    for (const [index, line] of lines.entries()) {
        const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
        if (match === null) continue;

        const fence = match[1] ?? "";
        const marker = fence[0] ?? "";
        if (openFence === undefined) {
            if (marker === "`" && (match[2] ?? "").includes("`")) continue;
            openFence = { marker, size: fence.length };
            openingLine = index;
            continue;
        }

        if (
            marker === openFence.marker &&
            fence.length >= openFence.size &&
            (match[2] ?? "").trim().length === 0
        ) {
            openFence = undefined;
            openingLine = -1;
        }
    }

    return openFence !== undefined && openingLine === lines.length - 1;
}
