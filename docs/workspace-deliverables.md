# Todos whose deliverable lands in the workspace

## Why

The build pipeline's verifier reads the repository and nothing else. It does not
open the instance home, because an automated actor with standing reach into that
directory would hold gateway tokens, session transcripts and secrets within range
of every build run — a permanent risk traded for an occasional reporting
convenience.

That rule is correct, and it leaves a gap. Some Todos deliver *into* the
workspace: a knowledge Note, a skill playbook, an org file. Their acceptance
criteria describe files the verifier will never see, so it is asked to rule on
evidence it cannot reach. The honest outcome is a refusal to rule, which the
pipeline records as a failed node — finished work parked in `blocked` because of
a contradiction in the pipeline rather than a real dependency. The dishonest
outcome is worse: signing off on criteria nobody checked.

Two mechanisms close the gap without moving the boundary an inch.

## 1. Declare the route

The route is declared to the pipeline when the build starts: `workspace` or
`repo`, with `repo` the default. It used to be stored on the Todo, as a
`deliverable` key inside its verify policy. That policy was removed from Todos,
so nothing on the Todo records the route any more. The declaration now reaches
the pipeline the same way the rest of the build brief does.

Declaring `workspace` routes the acceptance check to an actor that already has
workspace access — the operator, at the land approval. The verifier's verdict
then covers exactly what it legitimately sees: the diff, the gates, and the
evidence below. A workspace deliverable becomes a first-class outcome instead of
an error.

The declaration records a route. It grants no access to anything.

### The declaration is a hint, not an instruction

Left there, a self-declared route would be a way around review: declare
`workspace`, skip the code check. So the pipeline validates the declaration
against the real diff before honouring it:

```
git diff --name-status -z <base>..HEAD |
  node scripts/deliverable-evidence.mjs route --declared workspace
```

`workspace` is honoured only when the diff is empty or confined to non-shipping
paths — `docs/` and `.jinn-build/`. Non-shipping is an allowlist, not a denylist,
so a top-level directory added later ships by default rather than silently
escaping review. A diff touching anything else exits `2` — distinct from the
usage failure `1` — and names every offending file. A Todo carrying real source
changes is verified on the normal route; a false declaration buys nothing, and
the mismatch is loud rather than a silent downgrade.

The status form is what is fed in, not `--name-only`, because `--name-only`
names only where a rename landed: moving a shipping file under `docs/` read as
a diff of nothing but docs while it was still removing source. `--name-status`
names both sides of the rename, and the command judges both.

It arrives on stdin, NUL-delimited by `-z`, and not as arguments. A status is
separated from its path by the one byte a filename cannot contain, so it is
known by its position in the stream rather than guessed at by shape. Splitting
the fields apart on whitespace instead — which is what passing them as
arguments forces — could not tell a status from a top-level file *named* `M`,
dropped it, and reported a diff of nothing; a path containing a space broke into
two paths that were each judged separately; and git's default `"caf\303\251"`
quoting of a non-ASCII path was read back to the operator still escaped. The
first two were bypasses: a shipping diff, honoured as `workspace`. Under `-z`
none of the three is expressible. A stream that cannot be read that way — an
unknown status, or a status with no path behind it — exits `1` rather than
reporting an empty diff, because silence there would be the same bypass again.

Apart from reading that stream, the command is pure path arithmetic. It opens no
file, stats nothing, and runs no git.

## 2. Leave evidence in the repository

The implementer already has workspace access, so it is the side that can hash
what it delivered:

```
node scripts/deliverable-evidence.mjs write \
  --todo ABC-42 --home ~/.jinn --summary "one Note on X" \
  knowledge/x.md skills/y/SKILL.md
```

That writes `.jinn-build/deliverable-evidence.json` — gitignored, so per-run
evidence never enters the public repo — naming each delivered file with its
SHA-256 and byte count. Paths are relative to `--home`; anything that walks out
of the home with `..`, resolves outside it, or sits under `secrets/` is refused
before a manifest is written.

The verifier reads it back:

```
node scripts/deliverable-evidence.mjs check --todo ABC-42
```

`check` opens the manifest and nothing else — no stat, no read, no existence
check on any delivered path. It validates the shape, the 64-hex hashes, the byte
counts and the Todo id, then prints the verdict. A manifest naming a file that no
longer exists still passes, which is the proof that no deliverable is being
opened.

So the verifier confirms *identity and size* of work it cannot see. The operator,
who can see both sides, re-checks the hashes when approving the land. The hash is
what links the two halves.

## Attaching it to the Todo

The manifest lives in the worktree, which is disposable. Attach it to the Todo
with `attach_to_work_item` so the evidence outlives the branch.
