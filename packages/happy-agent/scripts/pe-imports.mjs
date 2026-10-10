// The DLLs a Windows executable loads, read from its PE import and delay-load import tables
// rather than guessed from strings in the file. Run directly, it prints them one per line and
// fails when the executable loads the Visual C++ or Universal C runtime instead of carrying it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** DLLs whose import means the C runtime was linked dynamically rather than statically. */
export const C_RUNTIME =
    /^(vcruntime\d+(_\d+)?|msvcp\d+(_\w+)?|ucrtbased?|api-ms-win-crt-[\w-]+)\.dll$/i;

/** IMAGE_IMPORT_DESCRIPTOR is 20 bytes with the DLL name's RVA at 12. */
const IMPORT_DESCRIPTOR = { name: 12, size: 20 };
/** ImgDelayDescr is 32 bytes with its attributes at 0 and the DLL name's RVA at 4. */
const DELAY_DESCRIPTOR = { name: 4, size: 32 };
/** dlattrRva: the descriptor holds RVAs. Without it the fields are VC6-era virtual addresses. */
const DELAY_RVA_ATTRIBUTE = 1;

/**
 * The DLL names a PE32+ image imports, directly or through delay loading, in table order. A
 * malformed or truncated table throws instead of returning a partial list.
 */
export function peImports(bytes) {
    const fail = (message) => {
        throw new Error(`The Windows executable is malformed: ${message}`);
    };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const within = (offset, length) =>
        offset >= 0 && length >= 0 && offset + length <= bytes.length;
    const u16 = (offset) =>
        within(offset, 2) ? view.getUint16(offset, true) : fail("it ends early.");
    const u32 = (offset) =>
        within(offset, 4) ? view.getUint32(offset, true) : fail("it ends early.");
    if (!within(0, 64) || u16(0) !== 0x5a4d) fail("it has no MZ header.");
    const header = u32(0x3c);
    if (u32(header) !== 0x4550) fail("it has no PE signature.");
    const sections = u16(header + 6);
    const optionalSize = u16(header + 20);
    const optional = header + 24;
    if (sections === 0 || sections > 96) fail("its section count is out of range.");
    if (!within(optional, optionalSize)) fail("its optional header ends early.");
    if (optionalSize < 112 || u16(optional) !== 0x20b) fail("it is not a PE32+ image.");
    const directories = Math.min(u32(optional + 108), 16);
    if (112 + directories * 8 > optionalSize) fail("its data directories overrun the header.");
    const table = optional + optionalSize;
    if (!within(table, sections * 40)) fail("its section table ends early.");
    const mapped = [];
    for (let index = 0; index < sections; index += 1) {
        const section = table + index * 40;
        const virtualSize = u32(section + 8);
        const address = u32(section + 12);
        const rawSize = u32(section + 16);
        const raw = u32(section + 20);
        // Only the file-backed part comes from the file; the rest is zero-filled memory.
        const size = virtualSize === 0 ? rawSize : Math.min(virtualSize, rawSize);
        if (size > 0 && !within(raw, size)) fail("a section's data lies outside the file.");
        mapped.push({ address, raw, size });
    }
    /** The section that maps an RVA range entirely from file data. */
    const sectionOf = (rva, length, what) => {
        const section = mapped.find(
            (entry) => rva >= entry.address && rva + length <= entry.address + entry.size,
        );
        return section ?? fail(`${what} is not backed by file data.`);
    };
    const name = (rva) => {
        if (rva === 0) fail("an import descriptor has no DLL name.");
        const section = sectionOf(rva, 1, "an imported DLL name");
        const start = section.raw + rva - section.address;
        const end = bytes.subarray(start, section.raw + section.size).indexOf(0);
        if (end < 1 || end > 256) fail("an imported DLL name is unterminated or out of range.");
        const text = Buffer.from(bytes.subarray(start, start + end)).toString("latin1");
        if (!/^[\x20-\x7e]+$/.test(text)) fail("an imported DLL name is not printable ASCII.");
        return text;
    };
    /** One descriptor table, which must end with an all-zero entry inside its directory. */
    const descriptors = (index, layout, what) => {
        if (index >= directories) return [];
        const rva = u32(optional + 112 + index * 8);
        const size = u32(optional + 116 + index * 8);
        if (rva === 0 && size === 0) return [];
        if (rva === 0 || size < layout.size) fail(`the ${what} directory is malformed.`);
        const section = sectionOf(rva, size, `the ${what} directory`);
        const start = section.raw + rva - section.address;
        const entries = [];
        for (let entry = start; entry + layout.size <= start + size; entry += layout.size) {
            if (bytes.subarray(entry, entry + layout.size).every((byte) => byte === 0)) {
                return entries;
            }
            entries.push(entry);
        }
        return fail(`the ${what} table has no terminating entry inside its directory.`);
    };
    const imports = descriptors(1, IMPORT_DESCRIPTOR, "import").map((entry) =>
        name(u32(entry + IMPORT_DESCRIPTOR.name)),
    );
    for (const entry of descriptors(13, DELAY_DESCRIPTOR, "delay-load import")) {
        if (u32(entry) !== DELAY_RVA_ATTRIBUTE) {
            fail("a delay-load import uses an unsupported descriptor format.");
        }
        imports.push(name(u32(entry + DELAY_DESCRIPTOR.name)));
    }
    return imports;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [binary] = process.argv.slice(2);
    assert.ok(binary, "Select the Windows executable to inspect.");
    const imports = peImports(readFileSync(binary));
    for (const dll of imports) console.log(dll);
    const runtime = imports.filter((dll) => C_RUNTIME.test(dll));
    if (runtime.length > 0) {
        console.error(
            `The Windows executable loads the C runtime instead of carrying it: ${runtime.join(", ")}.`,
        );
        process.exit(1);
    }
}
