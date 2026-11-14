/**
 * Environment-variable indirection for config values that hold secrets.
 *
 * Lets a user write `apiKey: "${OPENAI_API_KEY}"` in config.yaml and keep the
 * key itself in the environment. Shared by the MCP server resolver and the
 * realtime provider factory.
 */

/**
 * Resolve a value that may reference an environment variable.
 * Supports `${VAR_NAME}` and bare `$VAR_NAME`; anything else is returned as-is.
 * An unset variable resolves to `undefined`, never to the literal reference.
 *
 * The environment is named once, in the signature, so a caller can hand in its
 * own rather than have the ambient one read from inside the body.
 */
export function resolveEnvVar(value: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{(.+)\}$/);
  if (match) {
    return env[match[1]!] || undefined;
  }
  // Also check if the raw value is a plain env var name
  if (value.startsWith("$")) {
    return env[value.slice(1)] || undefined;
  }
  return value;
}
