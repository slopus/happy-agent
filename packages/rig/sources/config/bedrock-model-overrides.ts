export type BedrockModelTransport = "mantle" | "runtime";

export interface BedrockModelOverride {
    endpoint?: string;
    region?: string;
    transport?: BedrockModelTransport;
}

export type BedrockModelOverrides = Readonly<Record<string, BedrockModelOverride>>;
