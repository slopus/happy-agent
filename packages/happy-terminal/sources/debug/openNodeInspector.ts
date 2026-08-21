import { open, url } from "node:inspector";

export function openNodeInspector(): string {
    const activeUrl = url();
    if (activeUrl !== undefined) return activeUrl;

    open(0, "127.0.0.1", false);
    const openedUrl = url();
    if (openedUrl === undefined) throw new Error("Node inspector did not start.");
    return openedUrl;
}
