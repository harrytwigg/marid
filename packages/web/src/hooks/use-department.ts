import { useQuery } from "@tanstack/react-query"
import { departmentApi } from "@/lib/department-api"

/** One department's definition. Under the `["departments"]` prefix, so a department change refetches it too. */
export function useDepartment(slug: string | null) {
  return useQuery({
    queryKey: ["departments", "definition", slug],
    queryFn: () => departmentApi.get(slug!),
    enabled: !!slug,
    staleTime: 30_000,
    retry: false,
  })
}
