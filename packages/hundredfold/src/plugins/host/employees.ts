import { orgRegistry } from "../../gateway/org-registry.js";
import type { Employee } from "../../shared/types.js";
import { assertVerbAllowed } from "./permissions.js";

export interface PluginHostEmployees {
  list(): Employee[];
}

export function employeeVerbs(pluginId: string): PluginHostEmployees {
  return {
    list() {
      assertVerbAllowed(pluginId, "employees.list");
      return [...orgRegistry().values()];
    },
  };
}
