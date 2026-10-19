import fs from 'node:fs'
import path from 'node:path'

/** The request headers a capture tool sends the sandbox gateway, from the sandbox home's own credentials. */
export function authHeaders(sandboxHome) {
  const { token } = JSON.parse(fs.readFileSync(path.join(sandboxHome, 'gateway.json'), 'utf8'))
  return { authorization: `Bearer ${token}` }
}
