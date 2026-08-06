export function formatAgentsSecurityInstructions(cwd: string, text: string): string {
    return `# AGENTS_SECURITY.md rules for ${cwd}

<SECURITY_RULES>
${text}
</SECURITY_RULES>`;
}