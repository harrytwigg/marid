import type { JinnMcpTool } from "./toolkit.js";
import { buildBoardWalkTools } from "./board-walk-tools.js";

/**
 * The tools a jinn server serves: the company belt, or the purpose-built
 * toolset its spec names (identity.ts `MCP_TOOLSET_ARG`). A toolset name this
 * build does not know serves nothing, never the belt: the name was set to
 * narrow the surface, not widen it.
 */
export function toolsFor(toolset: string | undefined, belt: () => JinnMcpTool[], log: (message: string) => void = () => {}): JinnMcpTool[] {
  if (!toolset) return belt();
  if (toolset === "board-walk") return buildBoardWalkTools();
  log(`unknown toolset ${JSON.stringify(toolset)}: serving no tools`);
  return [];
}
