import assert from "node:assert/strict";
import { test } from "node:test";

import { C_RUNTIME, peImports } from "./pe-imports.mjs";

const SECTION_RVA = 0x1000;
const SECTION_OFFSET = 0x200;

/**
 * A minimal PE32+ image whose single section holds the import table, then the delay-load import
 * table, then the DLL names. Options bend one field at a time to model a malformed image.
 */
function image({
    imports = [],
    delayed = [],
    delayAttributes = 1,
    importSize,
    importRva,
    virtualExtra = 0,
    zeroNameOf,
    unterminatedName = false,
    mention = "",
} = {}) {
    const importBytes = (imports.length + 1) * 20;
    const delayBytes = delayed.length === 0 ? 0 : (delayed.length + 1) * 32;
    const names = [...imports, ...delayed];
    let data = Buffer.alloc(importBytes + delayBytes);
    const nameRvas = [];
    for (const name of names) {
        nameRvas.push(SECTION_RVA + data.length);
        data = Buffer.concat([data, Buffer.from(`${name}\0`, "latin1")]);
    }
    if (unterminatedName) data = data.subarray(0, data.length - 1);
    data = Buffer.concat([data, Buffer.from(mention, "latin1")]);
    imports.forEach((dll, index) => {
        if (zeroNameOf !== dll) data.writeUInt32LE(nameRvas[index], index * 20 + 12);
        data.writeUInt32LE(SECTION_RVA + 0x8000, index * 20 + 16);
    });
    delayed.forEach((_, index) => {
        const entry = importBytes + index * 32;
        data.writeUInt32LE(delayAttributes, entry);
        data.writeUInt32LE(nameRvas[imports.length + index], entry + 4);
        data.writeUInt32LE(SECTION_RVA + 0x8000, entry + 8);
    });

    const optionalSize = 112 + 16 * 8;
    const optional = 0x40 + 24;
    const table = optional + optionalSize;
    const bytes = Buffer.alloc(SECTION_OFFSET + data.length);
    bytes.write("MZ", 0, "latin1");
    bytes.writeUInt32LE(0x40, 0x3c);
    bytes.write("PE\0\0", 0x40, "latin1");
    bytes.writeUInt16LE(0x8664, 0x44);
    bytes.writeUInt16LE(1, 0x46);
    bytes.writeUInt16LE(optionalSize, 0x40 + 20);
    bytes.writeUInt16LE(0x20b, optional);
    bytes.writeUInt32LE(16, optional + 108);
    bytes.writeUInt32LE(importRva ?? SECTION_RVA, optional + 112 + 8);
    bytes.writeUInt32LE(importSize ?? importBytes, optional + 116 + 8);
    if (delayed.length > 0) {
        bytes.writeUInt32LE(SECTION_RVA + importBytes, optional + 112 + 13 * 8);
        bytes.writeUInt32LE(delayBytes, optional + 116 + 13 * 8);
    }
    bytes.write(".idata", table, "latin1");
    bytes.writeUInt32LE(data.length + virtualExtra, table + 8);
    bytes.writeUInt32LE(SECTION_RVA, table + 12);
    bytes.writeUInt32LE(data.length, table + 16);
    bytes.writeUInt32LE(SECTION_OFFSET, table + 20);
    data.copy(bytes, SECTION_OFFSET);
    return bytes;
}

test("reads direct and delay-load imports in table order", () => {
    const bytes = image({ imports: ["KERNEL32.dll", "ntdll.dll"], delayed: ["USER32.dll"] });
    assert.deepEqual(peImports(bytes), ["KERNEL32.dll", "ntdll.dll", "USER32.dll"]);
});

test("finds a C runtime that is only delay-loaded", () => {
    const imports = peImports(image({ imports: ["KERNEL32.dll"], delayed: ["VCRUNTIME140.dll"] }));
    assert.deepEqual(
        imports.filter((dll) => C_RUNTIME.test(dll)),
        ["VCRUNTIME140.dll"],
    );
});

test("ignores a runtime DLL that is only mentioned as a string", () => {
    const bytes = image({ imports: ["KERNEL32.dll"], mention: "VCRUNTIME140.dll\0" });
    assert.ok(bytes.includes("VCRUNTIME140.dll"));
    assert.deepEqual(peImports(bytes), ["KERNEL32.dll"]);
});

test("refuses an import table whose terminator lies outside its directory", () => {
    // The zero entry is still in the file right after the directory, so reading past the
    // directory would have silently accepted this table.
    const bytes = image({ imports: ["KERNEL32.dll", "VCRUNTIME140.dll"], importSize: 40 });
    assert.throws(() => peImports(bytes), /no terminating entry inside its directory/);
});

test("refuses a directory that is smaller than one descriptor", () => {
    const bytes = image({ imports: ["KERNEL32.dll"], importSize: 12 });
    assert.throws(() => peImports(bytes), /import directory is malformed/);
});

test("refuses a file cut off inside its import table", () => {
    const whole = image({ imports: ["KERNEL32.dll", "VCRUNTIME140.dll"] });
    assert.throws(() => peImports(whole.subarray(0, SECTION_OFFSET + 30)), /outside the file/);
    assert.throws(() => peImports(whole.subarray(0, 0x50)), /ends early/);
    assert.throws(() => peImports(Buffer.alloc(0)), /no MZ header/);
});

test("refuses a directory in zero-filled memory that the file does not back", () => {
    const valid = image({ imports: ["KERNEL32.dll"] });
    const rawSize = valid.length - SECTION_OFFSET;
    const bytes = image({
        imports: ["KERNEL32.dll"],
        importRva: SECTION_RVA + rawSize,
        virtualExtra: 0x1000,
    });
    assert.throws(() => peImports(bytes), /import directory is not backed by file data/);
});

test("refuses a directory outside every section", () => {
    const bytes = image({ imports: ["KERNEL32.dll"], importRva: 0x9000 });
    assert.throws(() => peImports(bytes), /not backed by file data/);
});

test("refuses delay-load descriptors that hold virtual addresses", () => {
    const bytes = image({ delayed: ["VCRUNTIME140.dll"], delayAttributes: 0 });
    assert.throws(
        () => peImports(bytes),
        /delay-load import uses an unsupported descriptor format/,
    );
});

test("refuses a descriptor without a DLL name", () => {
    const bytes = image({
        imports: ["KERNEL32.dll", "VCRUNTIME140.dll"],
        zeroNameOf: "KERNEL32.dll",
    });
    assert.throws(() => peImports(bytes), /has no DLL name/);
});

test("refuses a DLL name that runs off the end of its section", () => {
    const bytes = image({ imports: ["KERNEL32.dll"], unterminatedName: true });
    assert.throws(() => peImports(bytes), /unterminated or out of range/);
});

test("refuses an image that is not PE32+", () => {
    const bytes = image({ imports: ["KERNEL32.dll"] });
    bytes.writeUInt16LE(0x10b, 0x40 + 24);
    assert.throws(() => peImports(bytes), /not a PE32\+ image/);
});
