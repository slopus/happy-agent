import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeServiceAdmission } from "../../sources/services/observeServiceAdmission.js";

const directories = new Set<string>();
afterEach(async () => {
    await Promise.all([...directories].map((path) => rm(path, { recursive: true })));
    directories.clear();
});

describe.runIf(process.platform !== "win32")("private native admission", () => {
    it.each([undefined, "", "E", "invalid"])(
        "refuses admission after exit with marker %s",
        async (marker) => {
            const directory = await fixture(marker);
            const admission = observeServiceAdmission(directory, Promise.resolve());
            expect(await admission.admitted).toBe(false);
            expect(await admission.finalAdmission).toBe(false);
        },
    );
    it("accepts native admission independently of the application's exit code", async () => {
        const directory = await fixture("1");
        const admission = observeServiceAdmission(directory, Promise.resolve({ exitCode: 125 }));
        expect(await admission.admitted).toBe(true);
        expect(await admission.finalAdmission).toBe(true);
    });
    it("does not accept a public control file", async () => {
        const directory = await fixture("1");
        await chmod(join(directory, "started"), 0o644);
        const admission = observeServiceAdmission(directory, Promise.resolve());
        expect(await admission.admitted).toBe(false);
        expect(await admission.finalAdmission).toBe(false);
    });
    it("waits for admission and captures a subsequent native exec failure before cleanup", async () => {
        const directory = await fixture("");
        let exit!: () => void;
        const admission = observeServiceAdmission(
            directory,
            new Promise<void>((resolve) => {
                exit = resolve;
            }),
        );
        try {
            await writeFile(join(directory, "started"), "1");
            expect(await admission.admitted).toBe(true);
            await writeFile(join(directory, "started"), "E");
        } finally {
            exit();
        }
        expect(await admission.finalAdmission).toBe(false);
    });
});

async function fixture(marker: string | undefined) {
    const scratch = join(process.cwd(), ".context");
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, "admission-"));
    directories.add(directory);
    if (marker !== undefined) await writeFile(join(directory, "started"), marker, { mode: 0o600 });
    return directory;
}
