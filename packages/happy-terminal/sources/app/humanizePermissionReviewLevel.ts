import type { AutoPermissionRisk, AutoPermissionUserAuthorization } from "../protocol/index.js";

export function humanizePermissionReviewLevel(
    level: AutoPermissionRisk | AutoPermissionUserAuthorization,
): string {
    if (level === "unknown") return "Unknown";
    if (level === "low") return "Low";
    if (level === "medium") return "Medium";
    if (level === "critical") return "Critical";
    return "High";
}
