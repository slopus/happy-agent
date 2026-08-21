export function stripAnsi(value: string): string {
    let result = "";

    for (let index = 0; index < value.length; index += 1) {
        if (value.charCodeAt(index) !== 0x1b) {
            result += value[index];
            continue;
        }

        index += 1;
        const introducer = value[index];
        if (introducer === "[") {
            while (index + 1 < value.length) {
                index += 1;
                const code = value.charCodeAt(index);
                if (code >= 0x40 && code <= 0x7e) break;
            }
            continue;
        }

        if (introducer === "]" || introducer === "P" || introducer === "^" || introducer === "_") {
            while (index + 1 < value.length) {
                index += 1;
                if (value.charCodeAt(index) === 0x07) break;
                if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\") {
                    index += 1;
                    break;
                }
            }
        }
    }

    return result;
}
