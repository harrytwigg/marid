/**
 * The fixed paragraph a department's generated `CLAUDE.md` always ends with (FR-029).
 * It is a guardrail written for the model, not a boundary: the gateway enforces scope in
 * its routes and tools, and this says what the session is expected to do about the rest.
 */
export function departmentScopeParagraph(slug: string): string {
  return [
    "## Department scope",
    "",
    `This session is scoped to the **${slug}** department.`,
    "",
    "- Use the jinn tools for company state: Todos, members, sessions and Notes. They reach only this department.",
    "- Do not use your shell to read the Jinn home, other repositories, or other sessions' transcripts.",
    `- Keep your working state in \`knowledge/departments/${slug}/state.md\` through the note tools.`,
  ].join("\n");
}
