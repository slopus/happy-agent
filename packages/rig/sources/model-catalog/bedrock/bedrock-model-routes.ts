import type { Model } from "@slopus/happy-agent-base";

import type { BedrockModelTransport } from "../../config/bedrock-model-overrides.js";
import { curatedModel } from "../curatedModelProfiles.js";

export type { BedrockModelTransport };

export interface BedrockModelRoute {
    model: Model;
    provider: "anthropic" | "openai";
    transports: readonly BedrockModelTransportRoute[];
}

export interface BedrockModelTransportRoute {
    regions: readonly string[];
    transport: BedrockModelTransport;
}

const BEDROCK_RUNTIME_COMMERCIAL_REGIONS = [
    "af-south-1",
    "ap-east-2",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-south-1",
    "ap-south-2",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-southeast-3",
    "ap-southeast-4",
    "ap-southeast-5",
    "ap-southeast-6",
    "ap-southeast-7",
    "ca-central-1",
    "ca-west-1",
    "eu-central-1",
    "eu-central-2",
    "eu-north-1",
    "eu-south-1",
    "eu-south-2",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "il-central-1",
    "me-central-1",
    "me-south-1",
    "mx-central-1",
    "sa-east-1",
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
] as const;

const ANTHROPIC_SONNET_5_MANTLE_REGIONS = ["eu-north-1", "eu-west-1", "us-east-1"] as const;

const ANTHROPIC_FABLE_5_MANTLE_REGIONS = ["us-east-1"] as const;

const ANTHROPIC_OPUS_5_MANTLE_REGIONS = [
    "ap-northeast-1",
    "eu-north-1",
    "eu-west-1",
    "us-east-1",
    "us-gov-west-1",
] as const;

const ANTHROPIC_OPUS_4_8_MANTLE_REGIONS = [
    "ap-northeast-1",
    "eu-north-1",
    "eu-west-1",
    "us-east-1",
    "us-gov-west-1",
] as const;

export const BEDROCK_MODEL_ROUTES: readonly BedrockModelRoute[] = [
    {
        model: curatedModel("anthropic/sonnet-5"),
        provider: "anthropic",
        transports: [
            { transport: "mantle", regions: ANTHROPIC_SONNET_5_MANTLE_REGIONS },
            { transport: "runtime", regions: BEDROCK_RUNTIME_COMMERCIAL_REGIONS },
        ],
    },
    {
        model: curatedModel("anthropic/fable-5"),
        provider: "anthropic",
        transports: [
            { transport: "mantle", regions: ANTHROPIC_FABLE_5_MANTLE_REGIONS },
            { transport: "runtime", regions: BEDROCK_RUNTIME_COMMERCIAL_REGIONS },
        ],
    },
    {
        model: curatedModel("anthropic/opus-5"),
        provider: "anthropic",
        transports: [
            { transport: "mantle", regions: ANTHROPIC_OPUS_5_MANTLE_REGIONS },
            { transport: "runtime", regions: BEDROCK_RUNTIME_COMMERCIAL_REGIONS },
        ],
    },
    {
        model: curatedModel("anthropic/opus-4-8"),
        provider: "anthropic",
        transports: [
            { transport: "mantle", regions: ANTHROPIC_OPUS_4_8_MANTLE_REGIONS },
            { transport: "runtime", regions: BEDROCK_RUNTIME_COMMERCIAL_REGIONS },
        ],
    },
    {
        model: bedrockModel(curatedModel("openai/gpt-5.6-sol"), true),
        provider: "openai",
        transports: [{ transport: "mantle", regions: ["us-east-1", "us-east-2"] }],
    },
    {
        model: bedrockModel(curatedModel("openai/gpt-5.6-terra"), true),
        provider: "openai",
        transports: [{ transport: "mantle", regions: ["us-east-1", "us-east-2", "us-west-2"] }],
    },
    {
        model: bedrockModel(curatedModel("openai/gpt-5.6-luna"), false),
        provider: "openai",
        transports: [{ transport: "mantle", regions: ["us-east-1", "us-east-2", "us-west-2"] }],
    },
    {
        model: curatedModel("openai/gpt-5.4"),
        provider: "openai",
        transports: [{ transport: "mantle", regions: ["us-east-1", "us-east-2", "us-west-2"] }],
    },
];

function bedrockModel(model: Model, omitUltra: boolean): Model {
    return {
        ...model,
        contextWindow: 272_000,
        ...(omitUltra
            ? { thinkingLevels: model.thinkingLevels.filter((level) => level !== "ultra") }
            : {}),
    };
}
