/** A snake_case folder name derived from a task's display name, before collision suffixes. */
export function deriveTaskFolderName(name: string): string {
    let folderName = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    if (folderName.length === 0) folderName = "task";
    if (!/^[a-z]/.test(folderName)) folderName = `task_${folderName}`;
    return folderName.slice(0, 64).replace(/_+$/g, "") || "task";
}
