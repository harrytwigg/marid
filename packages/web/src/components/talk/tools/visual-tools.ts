import { params, str, type TalkTool } from "./tool-spec"

/** Executed by the session driver because it must append an image provider item. */
export const VISUAL_CAPTURE_TOOL: TalkTool = {
  name: "capture_current_view",
  description:
    "Capture one bounded image of the current Hundredfold page only when the live semantic context explicitly names the missing visual evidence. Give that exact missing-evidence reason. The Talk orb and secret controls are excluded.",
  parameters: params({ reason: str("Exact visual gap named in the current screen context.") }, ["reason"]),
  execute: () => ({
    ok: false,
    error: "capture_current_view is available only inside a live Talk transport.",
  }),
}
