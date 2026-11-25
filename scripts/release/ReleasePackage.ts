export type ReleasePackageKey =
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
    /** A source file whose exported version constant must equal the manifest's version. */
    versionConstantPath?: string;
    testArguments: readonly (readonly string[])[];
}
