export function formatFileMention(path: string): string {
    if (!/[\s"]/u.test(path)) {
        return `@${path}`;
    }

    return `@"${path.replaceAll('"', '\\"')}"`;
}
