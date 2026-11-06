import { GOOD_PASSWORD, type Harness, type Reply } from "./accounts-harness.js";

export const tokenFromLink = (link: string): string => link.split("#")[1]!;

export interface Joined { cookie: string; userId: string; reply: Reply }

/** The operator invites an address to a board and the person accepts, as two browsers would. */
export async function inviteAndAccept(
  h: Harness,
  email: string,
  opts: { department?: string; role?: string; displayName?: string; password?: string } = {},
): Promise<Joined> {
  const invite = await h.asOperator("POST", `/api/boards/${opts.department ?? "ops"}/invites`, { email, role: opts.role ?? "collaborator" });
  if (invite.status !== 200 || !invite.body.link) throw new Error(`invite failed: ${JSON.stringify(invite.body)}`);
  const reply = await h.request("POST", "/api/auth/invites/accept", {
    body: { token: tokenFromLink(invite.body.link), displayName: opts.displayName ?? "Pat Member", password: opts.password ?? GOOD_PASSWORD },
  });
  if (reply.status !== 200) throw new Error(`accept failed: ${reply.status} ${JSON.stringify(reply.body)}`);
  const userId = (h.db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase()) as { id: string }).id;
  return { cookie: h.cookieFrom(reply), userId, reply };
}

/** An instance owner: invited as `owner`, accepted, and so holding an operator device cookie. */
export async function joinAsOwner(h: Harness, email: string, password = GOOD_PASSWORD): Promise<Joined> {
  const invite = await h.asOperator("POST", "/api/people/invites", { email, instanceRole: "owner" });
  const reply = await h.request("POST", "/api/auth/invites/accept", {
    body: { token: tokenFromLink(invite.body.link), displayName: "Olive Owner", password },
  });
  const userId = (h.db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase()) as { id: string }).id;
  return { cookie: h.cookieFrom(reply), userId, reply };
}
