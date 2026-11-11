/**
 * The account endpoints a caller reaches with no credential at all: they are how a person gets one.
 * Listed in one place because three gates must agree on them: the 401 gate (`authRequiredForRequest`),
 * the unauthenticated-write refusal in the API dispatcher, and the accounts router itself.
 */
export const PUBLIC_ACCOUNT_POST_PATHS: readonly string[] = [
  "/api/auth/login",
  "/api/auth/invites/inspect",
  "/api/auth/invites/accept",
  "/api/auth/resets/inspect",
  "/api/auth/resets/complete",
];

export function isPublicAccountRoute(method: string | undefined, pathname: string): boolean {
  return (method || "GET").toUpperCase() === "POST" && PUBLIC_ACCOUNT_POST_PATHS.includes(pathname);
}
