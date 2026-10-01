import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTempDir } from '../../shared/test-support/temp-dir.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-settle-legacy-phase-'));
process.env.JINN_HOME = home;

type Registry = typeof import('../registry.js');
let registry: Registry;
let db: import('better-sqlite3').Database;

beforeAll(async () => {
  registry = await import('../registry.js');
  db = (await import('../../shared/db.js')).initDb();
});

afterAll(async () => {
  (await import('../../shared/db.js')).__closeDbForTest();
  removeTempDir(home);
});

function row(status: 'running' | 'waiting', ref: string, workflowKind: 'phase' | null) {
  const session = registry.createSession({ engine: 'codex', source: 'web', sourceRef: ref });
  db.prepare('UPDATE sessions SET status = ?, workflow_kind = ? WHERE id = ?').run(status, workflowKind, session.id);
  const queued = registry.enqueueQueueItem(session.id, session.sessionKey || session.id, `queued for ${ref}`);
  return { id: session.id, queued };
}

const queueStatus = (id: string) =>
  (db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as { status: string }).status;

/**
 * A previous version's Workflow runtime can leave phase rows running or waiting
 * when the home is upgraded. Nothing runs them any more, so boot settles them.
 */
describe('settleLegacyWorkflowPhaseSessions', () => {
  it('interrupts running and waiting phase rows, cancels their queued turns, and leaves everything else alone', () => {
    const runningPhase = row('running', 'wf-phase:running', 'phase');
    const waitingPhase = row('waiting', 'wf-phase:waiting', 'phase');
    const ordinary = row('running', 'chat:running', null);

    expect(registry.settleLegacyWorkflowPhaseSessions()).toBe(2);

    for (const phase of [runningPhase, waitingPhase]) {
      const settled = registry.getSession(phase.id)!;
      expect(settled.status).toBe('interrupted');
      expect(settled.lastError).toMatch(/Workflows were removed/);
      // Only `recoverStaleSessions` stamps a resume, and nothing should resume a phase.
      expect(settled.transportMeta?.[registry.RESTART_RESUME_META_KEY]).toBeUndefined();
      expect(queueStatus(phase.queued)).toBe('cancelled');
    }

    expect(registry.getSession(ordinary.id)?.status).toBe('running');
    expect(queueStatus(ordinary.queued)).toBe('pending');
  });

  it('is idempotent: a second boot finds nothing to settle', () => {
    expect(registry.settleLegacyWorkflowPhaseSessions()).toBe(0);
  });
});
