// Prints the MCP session capability the gateway of the instance at $HUNDREDFOLD_HOME derives for a
// session id, so a verification script can call the gateway as that session (and so as a
// department-scoped caller). Run it with HUNDREDFOLD_HOME set to a SANDBOX instance only; it reads
// that instance's capability key file, creating it if the gateway has not.
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [sessionId] = process.argv.slice(2)
if (!sessionId || !process.env.HUNDREDFOLD_HOME) throw new Error('usage: HUNDREDFOLD_HOME=<sandbox home> mint-session-capability.mjs <session-id>')

const identity = path.join(import.meta.dirname, '..', 'packages', 'hundredfold', 'dist', 'src', 'mcp', 'identity.js')
const { ensureSessionCapability } = await import(pathToFileURL(identity).href)
process.stdout.write(ensureSessionCapability(sessionId))
