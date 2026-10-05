import { useCallback, useState } from "react"
import type { ProjectInput } from "@/lib/project-api"
import { useUpdateProject } from "@/hooks/use-projects"
import { errorText } from "./project-parts"

/** Saves edits to one project and keeps the server's answer when it refuses them. */
export function useProjectSave(id: string) {
  const update = useUpdateProject()
  const [error, setError] = useState<string | null>(null)
  const save = useCallback(
    (input: ProjectInput, onDone?: () => void) => {
      setError(null)
      update.mutate(
        { id, input },
        { onSuccess: onDone, onError: (err) => setError(errorText(err, "Couldn't save the project")) },
      )
    },
    [id, update],
  )
  return { save, error, pending: update.isPending }
}

export type ProjectSave = ReturnType<typeof useProjectSave>["save"]
