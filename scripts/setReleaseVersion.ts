import { readFileSync, writeFileSync } from "node:fs";

import { readPackageManifest } from "./release/readPackageManifest.js";
import { replacePackageVersion } from "./release/replacePackageVersion.js";
import { resolveReleasePackage } from "./release/resolveReleasePackage.js";

const releasePackage = resolveReleasePackage(process.env.RELEASE_PACKAGE);
const releaseVersion = process.env.RELEASE_VERSION ?? "";
const manifestPath = `${releasePackage.directory}package.json`;
const contents = readFileSync(manifestPath, "utf8");

writeFileSync(manifestPath, replacePackageVersion(contents, releaseVersion));

const manifest = readPackageManifest(releasePackage);
if (manifest.version !== releaseVersion) {
    throw new Error(`Could not set ${manifest.name} to ${releaseVersion}.`);
}
console.log(`Set ${manifest.name} to release version ${releaseVersion}.`);
