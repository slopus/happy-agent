export async function loadIrohBindings(): Promise<typeof import("@number0/iroh/index.js")> {
    if (process.platform === "darwin" && process.arch === "x64") {
        throw new Error(
            "Iroh P2P networking is not supported on Intel Macs because Iroh does not publish a Darwin x64 native binding.",
        );
    }
    try {
        return await import("@number0/iroh/index.js");
    } catch (cause) {
        throw new Error(
            `Iroh P2P networking could not load its native binding for ${process.platform}/${process.arch}.`,
            { cause },
        );
    }
}
