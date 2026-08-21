export async function readExecPrompt(prompt: string | undefined): Promise<string> {
    if (prompt !== undefined && prompt.trim().length > 0) return prompt.trim();
    if (process.stdin.isTTY) {
        throw new Error("Provide a prompt argument or pipe a prompt to happy-terminal exec.");
    }

    process.stdin.setEncoding("utf8");
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    if (input.trim().length === 0) {
        throw new Error("The prompt from standard input was empty.");
    }
    return input.trim();
}
