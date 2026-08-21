export type ReleasePackageKey =
    | "happy-terminal"
    | "happy-agent-base"
    | "happy-agent-client"
    | "happy-agent-compute"
    | "happy-plugins"
    | "happy-providers";

export interface ReleasePackage {
    buildArguments: readonly string[];
    checkArguments: readonly string[];
    commitPrefix: string;
    directory: string;
    key: ReleasePackageKey;
    manifestPath: string;
    tagPrefix: string;
    testArguments: readonly (readonly string[])[];
}
