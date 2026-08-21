import { readFileSync } from "node:fs";

import type { PackageManifest } from "./PackageManifest.js";
import type { ReleasePackage } from "./ReleasePackage.js";
import { resolveReleasePackage } from "./resolveReleasePackage.js";

export function readPackageManifest(
    releasePackage: ReleasePackage = resolveReleasePackage("happy-terminal"),
): PackageManifest {
    return JSON.parse(
        readFileSync(`${releasePackage.directory}/package.json`, "utf8"),
    ) as PackageManifest;
}
