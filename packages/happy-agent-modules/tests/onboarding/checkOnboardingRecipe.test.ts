import { describe, expect, it } from "vitest";

import {
    assertOnboardingRecipe,
    checkOnboardingRecipe,
    type OnboardingRuntimeOffer,
} from "../../sources/onboarding/impl/checkOnboardingRecipe.js";
import { fillRecipeText } from "../../sources/onboarding/impl/fillRecipeText.js";

const OFFER: OnboardingRuntimeOffer = {
    effects: { "provider.connect": ["ok", "failed"] },
    conditions: new Set(["installed"]),
    variables: new Set(["provider"]),
    blocks: new Set(["providerMenu"]),
    tools: new Set(["save_profile"]),
    requirements: new Set(["provider"]),
};

/** A recipe that runs, changed by `change`. */
function recipe(change: (recipe: Record<string, any>) => void = () => {}): unknown {
    const value: Record<string, any> = {
        id: "small",
        version: 1,
        requirements: ["provider"],
        bootstrap: {
            start: "hello",
            typing: "disabled",
            steps: {
                hello: {
                    say: [
                        { when: "installed", text: "Connect {{provider}}." },
                        { text: ["Choose one:", "", "{{providerMenu}}"] },
                    ],
                    next: { connect: { params: { provider: { values: ["claude"] } } } },
                },
                connect: {
                    effect: { name: "provider.connect", then: { ok: "handoff", failed: "hello" } },
                },
            },
        },
        guide: "Guide {{provider}}.",
        tools: ["save_profile"],
        figures: [],
    };
    change(value);
    return value;
}

describe("checking an onboarding recipe against its runtime", () => {
    it("accepts a recipe that names only what the runtime offers", () => {
        expect(checkOnboardingRecipe(recipe(), OFFER)).toEqual([]);
    });

    it("refuses one that does not match the schema, at the place it fails", () => {
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    value["bootstrap"].typing = "sometimes";
                }),
                OFFER,
            ),
        ).toEqual([expect.stringContaining("/bootstrap/typing")]);
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    value["bootstrap"].steps["Not A Slug"] = { say: [{ text: "Hi." }] };
                }),
                OFFER,
            ),
        ).toHaveLength(1);
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    value["extra"] = true;
                }),
                OFFER,
            ),
        ).toHaveLength(1);
    });

    it("refuses targets that are no step, and step IDs that are targets", () => {
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    value["bootstrap"].start = "missing";
                    value["bootstrap"].handoffFailed = "gone";
                    value["bootstrap"].steps.hello.next = { elsewhere: {} };
                    value["bootstrap"].steps.connect.effect.then.failed = "nowhere";
                    value["bootstrap"].steps.handoff = { say: [{ text: "Hi." }] };
                }),
                OFFER,
            ),
        ).toEqual([
            '"handoff" is a target, not a step ID.',
            'bootstrap.start names no step "missing".',
            'bootstrap.handoffFailed names no step "gone".',
            'Step "hello" leads to no step "elsewhere".',
            'Step "connect" names no step "nowhere".',
        ]);
    });

    it("refuses an effect whose outcomes are not mapped exactly", () => {
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    value["bootstrap"].steps.connect.effect.then = {
                        ok: "handoff",
                        later: "hello",
                    };
                }),
                OFFER,
            ),
        ).toEqual([
            'Step "connect" leaves the outcome "failed" unmapped.',
            'Step "connect" maps an outcome "later" its effect never returns.',
        ]);
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    value["bootstrap"].steps.connect.effect.name = "routes.use";
                }),
                OFFER,
            ),
        ).toEqual(['Step "connect" uses an unknown effect "routes.use".']);
    });

    it("refuses conditions, variables, tools, and requirements the runtime does not offer", () => {
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    value["bootstrap"].steps.hello.say[0].when = "signedIn";
                    value["bootstrap"].steps.hello.say[1].text = "Hi {{name}}.";
                    value["guide"] = "Use {{secret}}.";
                    value["tools"] = ["save_profile", "delete_everything"];
                    value["requirements"] = ["provider", "payment"];
                }),
                OFFER,
            ),
        ).toEqual([
            'Step "hello" uses an unknown condition "signedIn".',
            'Step "hello" uses an unknown variable "{{name}}".',
            'The guide uses an unknown variable "{{secret}}".',
            'The recipe uses an unknown tool "delete_everything".',
            'The recipe requires something unknown: "payment".',
        ]);
    });

    it("refuses a step that neither says nor does anything", () => {
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    value["bootstrap"].steps.idle = {};
                    value["bootstrap"].steps.hello.next.idle = {};
                }),
                OFFER,
            ),
        ).toEqual(['Step "idle" neither says nor does anything.']);
    });

    it("takes a typed answer only toward a next step that declares its parameter", () => {
        const typed = (input: Record<string, unknown>, next?: Record<string, unknown>) =>
            recipe((value) => {
                const hello = value["bootstrap"].steps.hello;
                hello.input = input;
                if (next !== undefined) hello.next = next;
            });
        expect(
            checkOnboardingRecipe(
                typed(
                    {
                        step: "connect",
                        param: "provider",
                        maxLength: 40,
                        placeholder: "Or type one",
                    },
                    { connect: { params: { provider: {} } } },
                ),
                OFFER,
            ),
        ).toEqual([]);
        expect(checkOnboardingRecipe(typed({ step: "nowhere", param: "provider" }), OFFER)).toEqual(
            [
                `Step "hello" takes a typed answer toward "nowhere", which is not one of its next steps.`,
            ],
        );
        expect(checkOnboardingRecipe(typed({ step: "connect", param: "name" }), OFFER)).toEqual([
            `Step "hello" takes a typed answer as "name", which its step "connect" does not declare.`,
        ]);
        expect(
            checkOnboardingRecipe(
                typed({ step: "connect", param: "provider", maxLength: 129 }),
                OFFER,
            ),
        ).toEqual([
            expect.stringMatching(
                /^The recipe does not match its schema at \/bootstrap\/steps\/hello\/input\/maxLength/u,
            ),
        ]);
    });

    it("throws with every problem when asked for a recipe that cannot run", () => {
        expect(() =>
            assertOnboardingRecipe(
                recipe((value) => {
                    value["tools"] = ["one", "two"];
                }),
                OFFER,
            ),
        ).toThrow(/unknown tool "one"[\s\S]*unknown tool "two"/u);
    });
});

describe("filling a recipe text", () => {
    it("escapes plain variables so no value can open a tag, an attribute, or an entity", () => {
        expect(
            fillRecipeText(
                '<button data-provider="{{provider}}">{{provider}}</button>',
                { provider: `x" onclick="y' & <b>` },
                {},
            ),
        ).toBe(
            '<button data-provider="x&quot; onclick=&quot;y&#39; &amp; &lt;b&gt;">x&quot; onclick=&quot;y&#39; &amp; &lt;b&gt;</button>',
        );
    });

    it("writes block variables as the runtime wrote them, and leaves an unset variable empty", () => {
        expect(
            fillRecipeText(
                ["Choose:", "{{providerMenu}}", "for {{provider}}."],
                {},
                { providerMenu: "<menu><button>A</button></menu>" },
            ),
        ).toBe("Choose:\n<menu><button>A</button></menu>\nfor .");
    });

    it("never reads an inherited property as a value", () => {
        expect(fillRecipeText("{{toString}}{{constructor}}", {}, {})).toBe("");
    });
});

describe("checking the shapes a recipe may take", () => {
    it("accepts a negated condition and a step that ends the bootstrap once it has spoken", () => {
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    value["bootstrap"].steps.hello.say[0].when = "!installed";
                    value["bootstrap"].steps.hello.next.bye = {};
                    value["bootstrap"].steps.bye = {
                        say: [{ text: "Over to the model." }],
                        end: "handoff",
                    };
                }),
                OFFER,
            ),
        ).toEqual([]);
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    value["bootstrap"].steps.hello.say[0].when = "!signedIn";
                }),
                OFFER,
            ),
        ).toEqual(['Step "hello" uses an unknown condition "signedIn".']);
    });

    it("refuses an ending step that also does or offers something, and a message that may be empty", () => {
        expect(
            checkOnboardingRecipe(
                recipe((value) => {
                    value["bootstrap"].steps.connect.end = "finish";
                    value["bootstrap"].steps.hello.say = [{ when: "installed", text: "Hi." }];
                }),
                OFFER,
            ),
        ).toEqual([
            'Step "hello" may say nothing: its last entry has a condition.',
            'Step "connect" ends the bootstrap, so it can have no effect or next steps.',
        ]);
    });
});
