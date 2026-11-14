import { searchKnowledge, type KnowledgeSearchHit } from "../../notes/store.js";
import { assertVerbAllowed } from "./permissions.js";

export interface PluginHostKnowledge {
  search(query: string): KnowledgeSearchHit[];
}

export function knowledgeVerbs(pluginId: string): PluginHostKnowledge {
  return {
    search(query) {
      assertVerbAllowed(pluginId, "knowledge.search");
      return searchKnowledge(query);
    },
  };
}
