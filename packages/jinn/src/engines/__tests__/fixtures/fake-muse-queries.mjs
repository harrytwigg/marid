// The query the fake `muse serve` answers outside a turn, `model/list`, shaped from Muse Code 1.4.8's own schema.
//
//   FAKE_MUSE_MODELS      a JSON `model/list` result to answer with (default: two rows, the
//                         newer one `isDefault`, both priced); `error` fails the request,
//                         `hang` never answers it
import { fail, reply } from "./fake-muse-store.mjs";

const row = (modelId, displayLabel, isDefault, cost) => ({
  contextLimit: 262144, cost, defaultReasoningEffort: "high", description: null, displayLabel, isActive: false, isDefault,
  modelId, outputLimit: 32768, profileId: "tbh", providerId: "meta", reasoningEffortVariants: [], releaseDate: null,
  variants: ["none", "minimal", "low", "medium", "high", "xhigh"],
});

const DEFAULT_MODELS = {
  models: [
    row("muse-spark-1.3", "Muse Spark 1.3", true, { cached: "0.15", currency: null, input: "1.50", output: "7.50" }),
    row("muse-spark-1.2", "Muse Spark 1.2", false, null),
  ],
  profileId: "tbh",
  providerId: "meta",
  source: "providerCatalog",
};

export function modelList(id) {
  const stated = process.env.FAKE_MUSE_MODELS;
  if (stated === "hang") return;
  if (stated === "error") return fail(id, -32603, "model catalog unavailable", { kind: "internal" });
  reply(id, stated ? JSON.parse(stated) : DEFAULT_MODELS);
}
