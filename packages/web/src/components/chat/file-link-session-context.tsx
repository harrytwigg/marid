import { createContext, useContext } from 'react'

/**
 * The session whose messages are being rendered. A chat file link names a path
 * as that session's agent saw it — absolute, `~/`, or relative to its working
 * directory, on the host it runs on — so the link has to carry the session for
 * the gateway to know where to read it.
 */
export const FileLinkSessionContext = createContext<string | null>(null)

export function useFileLinkSession() {
  return useContext(FileLinkSessionContext)
}
