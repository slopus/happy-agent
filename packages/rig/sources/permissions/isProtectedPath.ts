import { isAbsolute, relative } from "node:path";

export function isProtectedPath(targetPath: string, protectedPaths: readonly string[]): boolean {
    return protectedPaths.some((protectedPath) => {
        const fromProtectedPath = relative(protectedPath, targetPath);
        return (
            fromProtectedPath === "" ||
            (!fromProtectedPath.startsWith("..") && !isAbsolute(fromProtectedPath))
        );
    });
}
