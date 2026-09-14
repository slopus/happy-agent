import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readServiceControlFile, servicePathIsMissing } from "./serviceControlFiles.js";

const markerSchema = Type.Union([Type.Literal(""), Type.Literal("1"), Type.Literal("E")]);

/** Native admission is private control data, never a magic string in application output. */
export function observeServiceAdmission(directory: string, exited: Promise<unknown>) {
    let finished = false;
    const finalAdmission = exited.then(async () => {
        finished = true;
        return (await readAdmission(directory)) === true;
    });
    const admitted = (async () => {
        while (!finished) {
            const current = await readAdmission(directory);
            if (current !== undefined) return current;
            let timer: NodeJS.Timeout | undefined;
            try {
                await Promise.race([
                    finalAdmission,
                    new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, 20);
                    }),
                ]);
            } finally {
                if (timer !== undefined) clearTimeout(timer);
            }
        }
        return finalAdmission;
    })();
    return { admitted, finalAdmission };
}

async function readAdmission(directory: string): Promise<boolean | undefined> {
    try {
        const marker = await readServiceControlFile(join(directory, "started"), 1);
        if (!Value.Check(markerSchema, marker)) return false;
        return marker === "" ? undefined : marker === "1";
    } catch (error) {
        // Missing startup files are expected before admission. Any other failure refuses admission.
        return servicePathIsMissing(error) ? undefined : false;
    }
}
