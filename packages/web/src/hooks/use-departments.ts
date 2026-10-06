import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { DepartmentRowWire } from "@/lib/department-api"

/**
 * The department rows, each with its scope. Refetched on `company:changed {entity: "department"}`.
 * `api.getDepartments` types the registry row only; the same response carries the definition
 * fields, all optional so an older gateway still renders.
 */
export function useDepartments() {
  return useQuery({
    queryKey: ["departments"],
    queryFn: async (): Promise<DepartmentRowWire[]> => (await api.getDepartments()).departments as DepartmentRowWire[],
    staleTime: 60_000,
  })
}
