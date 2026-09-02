import { readFile } from "node:fs/promises";

/** Load the bundled picture used when the installation creates its Chief of Staff. */
export async function loadChiefOfStaffAvatar(): Promise<Uint8Array> {
    return new Uint8Array(
        await readFile(new URL("../assets/chief-of-staff.webp", import.meta.url)),
    );
}
