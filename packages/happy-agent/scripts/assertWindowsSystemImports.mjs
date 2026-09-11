import { readFileSync } from "node:fs";

/** Reject native assets that need a compiler redistributable on an end user's PC. */
export function assertWindowsSystemImports(path) {
    const bytes = readFileSync(path);
    const signature = bytes.readUInt32LE(0x3c);
    if (bytes.toString("ascii", signature, signature + 4) !== "PE\0\0")
        throw new Error(`Not a Windows PE image: ${path}`);
    const optional = signature + 24;
    if (bytes.readUInt16LE(optional) !== 0x20b) throw new Error("Expected Windows x64 image.");
    const sections = [];
    const table = optional + bytes.readUInt16LE(signature + 20);
    for (let index = 0; index < bytes.readUInt16LE(signature + 6); index++) {
        const at = table + index * 40;
        sections.push({
            rva: bytes.readUInt32LE(at + 12),
            size: Math.max(bytes.readUInt32LE(at + 8), bytes.readUInt32LE(at + 16)),
            offset: bytes.readUInt32LE(at + 20),
        });
    }
    const offset = (rva) => {
        const section = sections.find((entry) => rva >= entry.rva && rva < entry.rva + entry.size);
        if (!section) throw new Error("Invalid Windows import address.");
        return section.offset + rva - section.rva;
    };
    const imports = [];
    const importRva = bytes.readUInt32LE(optional + 120);
    if (importRva !== 0) {
        for (let at = offset(importRva); bytes.readUInt32LE(at + 12); at += 20) {
            const name = offset(bytes.readUInt32LE(at + 12));
            imports.push(bytes.toString("ascii", name, bytes.indexOf(0, name)));
        }
    }
    const system = new Set([
        "advapi32.dll",
        "bcrypt.dll",
        "bcryptprimitives.dll",
        "combase.dll",
        "crypt32.dll",
        "dbghelp.dll",
        "dnsapi.dll",
        "fwpuclnt.dll",
        "gdi32.dll",
        "iphlpapi.dll",
        "kernel32.dll",
        "msvcrt.dll",
        "netapi32.dll",
        "ntdll.dll",
        "ole32.dll",
        "oleaut32.dll",
        "rpcrt4.dll",
        "secur32.dll",
        "shell32.dll",
        "user32.dll",
        "userenv.dll",
        "version.dll",
        "winhttp.dll",
        "wininet.dll",
        "ws2_32.dll",
    ]);
    const external = imports.filter(
        (name) => !system.has(name.toLowerCase()) && !/^(api-ms-win-|ext-ms-win-)/i.test(name),
    );
    if (external.length > 0)
        throw new Error(`Windows native asset needs external DLLs: ${external.join(", ")}`);
    return imports;
}
