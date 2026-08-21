import { close, url } from "node:inspector";

export function closeNodeInspector(): boolean {
    if (url() === undefined) return false;

    close();
    return true;
}
