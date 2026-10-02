import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTempDir } from '../../shared/test-support/temp-dir.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-list-all-session-ids-'));
process.env.JINN_HOME = home;

type Registry = typeof import('../registry.js');
let registry: Registry;

beforeAll(async () => {
  registry = await import('../registry.js');
  (await import('../../shared/db.js')).initDb();
});

afterAll(async () => {
  (await import('../../shared/db.js')).__closeDbForTest();
  removeTempDir(home);
});

/**
 * `listSessions` hardcodes `archived_at IS NULL AND workflow_kind IS NULL`, which
 * makes it a display query, not a liveness signal. Retention sweeps over
 * per-session on-disk state read "id absent" as "delete that session's data", so
 * they need the unfiltered set or they reap live sessions' state.
 */
describe('listAllSessionIds', () => {
  it('returns archived and workflow-phase ids that listSessions omits', async () => {
    const plain = registry.createSession({ engine: 'codex', source: 'web', sourceRef: 'chat:plain' });
    const archived = registry.createSession({ engine: 'codex', source: 'web', sourceRef: 'chat:archived' });
    registry.archiveSession(archived.id);
    const phase = registry.createSession({
      engine: 'codex',
      source: 'web',
      sourceRef: 'workflow-run:run-ids-1:build:1',
      sessionKey: 'workflow-run:run-ids-1:build:1',
    });
    // A phase row a previous version left behind: only the raw column marks it.
    (await import('../../shared/db.js')).initDb()
      .prepare("UPDATE sessions SET workflow_kind = 'phase' WHERE id = ?").run(phase.id);

    const listed = registry.listSessions().map((session) => session.id);
    expect(listed).toContain(plain.id);
    expect(listed).not.toContain(archived.id);
    expect(listed).not.toContain(phase.id);

    const all = registry.listAllSessionIds();
    expect(all).toContain(plain.id);
    expect(all).toContain(archived.id);
    expect(all).toContain(phase.id);
  });
});
