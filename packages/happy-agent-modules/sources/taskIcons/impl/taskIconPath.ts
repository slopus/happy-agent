import { fileURLToPath } from "node:url";

/** Called only with a catalog slug; the standalone binary replaces this asset resolver. */
export function taskIconPath(slug: string): string {
    return fileURLToPath(new URL(`../assets/${slug}.webp`, import.meta.url));
}
