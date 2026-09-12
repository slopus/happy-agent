import { basename, dirname, isAbsolute, join } from "node:path";

/** Windows PowerShell must find its own built-in modules before a PowerShell 7 parent's. */
export function shellEnvironment(shell: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (
        process.platform !== "win32" ||
        basename(shell).toLowerCase() !== "powershell.exe" ||
        !isAbsolute(shell)
    )
        return environment;
    const result = { ...environment };
    const key = Object.keys(result).find((name) => name.toLowerCase() === "psmodulepath");
    const inherited = key === undefined ? undefined : result[key];
    if (inherited === undefined) return environment;
    if (key !== undefined) delete result[key];
    const builtins = join(dirname(shell), "Modules");
    result.PSModulePath = [
        builtins,
        ...inherited.split(";").filter((path) => path.toLowerCase() !== builtins.toLowerCase()),
    ].join(";");
    return result;
}
