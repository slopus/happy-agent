import { cp, rm } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..");
const repositoryDocs = join(packageRoot, "..", "..", "docs");
const packagedDocs = join(packageRoot, "dist", "docs");

await rm(packagedDocs, { force: true, recursive: true });
await cp(repositoryDocs, packagedDocs, { recursive: true });
