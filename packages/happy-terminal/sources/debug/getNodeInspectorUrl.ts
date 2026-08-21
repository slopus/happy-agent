import { url } from "node:inspector";

export function getNodeInspectorUrl(): string | undefined {
    return url();
}
