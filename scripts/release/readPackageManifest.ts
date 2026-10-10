import { readFileSync } from "node:fs";

import type { PackageManifest } from "./PackageManifest.js";
import type { ReleasePackage } from "./ReleasePackage.js";

export function readPackageManifest(releasePackage: ReleasePackage): PackageManifest {
    return JSON.parse(
        readFileSync(`${releasePackage.directory}/package.json`, "utf8"),
    ) as PackageManifest;
}
