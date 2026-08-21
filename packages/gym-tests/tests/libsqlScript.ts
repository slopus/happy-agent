import { fileURLToPath } from "node:url";

const localHappyTerminalPackageJson = JSON.stringify(
    fileURLToPath(new URL("../../happy-terminal/package.json", import.meta.url)),
);

const esmSetup = String.raw`
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const happyTerminalPackageJson = existsSync("/app/packages/happy-terminal/package.json")
    ? "/app/packages/happy-terminal/package.json"
    : ${localHappyTerminalPackageJson};
const requireFromHappyTerminal = createRequire(happyTerminalPackageJson);
const { createClient } = requireFromHappyTerminal("@libsql/client");

async function openDatabase(path, readOnly = false) {
    const database = createClient({
        intMode: "number",
        url: path.startsWith("file:") ? path : "file:" + path,
    });
    try {
        if (readOnly) await database.execute("PRAGMA query_only = ON");
        return database;
    } catch (error) {
        await database.close();
        throw error;
    }
}
`;

const commonJsSetup = String.raw`
const { existsSync } = require("node:fs");
const { createRequire } = require("node:module");

const happyTerminalPackageJson = existsSync("/app/packages/happy-terminal/package.json")
    ? "/app/packages/happy-terminal/package.json"
    : ${localHappyTerminalPackageJson};
const requireFromHappyTerminal = createRequire(happyTerminalPackageJson);
const { createClient } = requireFromHappyTerminal("@libsql/client");

async function openDatabase(path, readOnly = false) {
    const database = createClient({
        intMode: "number",
        url: path.startsWith("file:") ? path : "file:" + path,
    });
    try {
        if (readOnly) await database.execute("PRAGMA query_only = ON");
        return database;
    } catch (error) {
        await database.close();
        throw error;
    }
}
`;

export function libsqlEsmScript(body: string, imports = ""): string {
    return `${imports}
${esmSetup}
async function main() {
${body}
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
`;
}

export function libsqlCommonJsScript(body: string): string {
    return `${commonJsSetup}
(async () => {
${body}
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
`;
}
