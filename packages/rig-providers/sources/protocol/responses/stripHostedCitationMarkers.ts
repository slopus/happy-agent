/**
 * Removes the citation markers OpenAI writes around a hosted search's sources.
 *
 * When a search runs on OpenAI's backend, the answer sometimes carries its citations as ordinary
 * markdown links and sometimes as private-use markers of the form `citeturn0search0
 * `. The reference behind one of those is an index into that turn's search results, which
 * only exist on OpenAI's backend: a hosted search never returns its results to Rig, so there is
 * nothing here to resolve them against and there never will be.
 *
 * That leaves two honest options, and showing the reader `cite turn0search0` in the middle of a
 * sentence is not one of them. The marker is removed and the prose reads as written.
 *
 * Removal is a state machine rather than a regular expression because the text arrives as stream
 * deltas, and a marker split across two of them would otherwise reach the reader in pieces and
 * stay there. Nothing needs to be held back to decide: every character from the opening marker to
 * the closing one is dropped, so a marker still open when the stream ends drops its tail, which is
 * what an unterminated marker deserves.
 */
export function createHostedCitationFilter(): (text: string) => string {
    let inMarker = false;
    return (text: string): string => {
        if (!inMarker && !text.includes(CITATION_START)) return text;
        let output = "";
        for (const character of text) {
            if (inMarker) {
                if (character === CITATION_END) inMarker = false;
                continue;
            }
            if (character === CITATION_START) {
                inMarker = true;
                continue;
            }
            output += character;
        }
        return output;
    };
}

const CITATION_START = "\u{e200}";
const CITATION_END = "\u{e201}";
