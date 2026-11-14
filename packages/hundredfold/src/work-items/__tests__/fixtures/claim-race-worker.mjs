import { pathToFileURL } from "node:url";

const [home, claimsPath, workItemId, owner, startAt] = process.argv.slice(2);
process.env.HUNDREDFOLD_HOME = home;

// One racer per process, every one of them held at the same wall-clock instant
// so the claim path is entered simultaneously rather than in whatever order the
// processes happened to boot. Logging goes to stderr only: the parent
// JSON.parses this worker's stdout.
try {
  const sibling = (name) => new URL(`../shared/${name}`, pathToFileURL(claimsPath).href).href;
  const { configureLogger } = await import(sibling("logger.js"));
  configureLogger({ stdout: false, file: false });
  const dbModule = await import(sibling("db.js"));
  const { claimWorkItem, getWorkItemClaim } = await import(pathToFileURL(claimsPath).href);

  // Migrate, warm the connection, and create the claims table BEFORE the start
  // line: every one of those is a write, and SQLite would queue the racers up
  // behind each other's DDL instead of letting them contend for the claim.
  dbModule.initDb();
  getWorkItemClaim(workItemId);
  const start = Number(startAt);
  while (Date.now() < start) { /* spin: sleeping would spread the racers out */ }

  const result = claimWorkItem({ workItemId, owner });
  process.stdout.write(JSON.stringify({ owner, state: result.state }));
  dbModule.__closeDbForTest();
} catch (error) {
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
  process.exitCode = 1;
}
