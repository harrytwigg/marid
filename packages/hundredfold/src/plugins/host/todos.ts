import { addComment, type WorkItemComment } from "../../work-items/comments.js";
import { createWorkItem, listWorkItems, type ListWorkItemsFilter, type WorkItem } from "../../work-items/store.js";
import { assertVerbAllowed } from "./permissions.js";
import { provenanceRef } from "./provenance.js";

/** What a plugin may set when it mints a Todo. Provenance is not on the list —
 *  this module stamps it, so a plugin cannot claim another author. */
export interface PluginTodoDraft {
  title: string;
  body?: string;
  assignee?: string;
  department?: string;
  parentId?: string;
  priority?: number;
}

export interface PluginHostTodos {
  list(filter?: ListWorkItemsFilter): WorkItem[];
  create(draft: PluginTodoDraft): WorkItem;
  comment(todoId: string, body: string): WorkItemComment;
}

export function todoVerbs(pluginId: string, author: string): PluginHostTodos {
  return {
    list(filter) {
      assertVerbAllowed(pluginId, "todos.list");
      return listWorkItems(filter);
    },
    create(draft) {
      assertVerbAllowed(pluginId, "todos.create");
      return createWorkItem({
        ...draft,
        // A plugin is third-party code the operator mounted, which is what a
        // connector is; the enum has no truer member, and widening a persisted
        // one for the sake of a label would be the wrong trade.
        source: "connector",
        sourceRef: provenanceRef(pluginId),
        createdBy: author,
      });
    },
    comment(todoId, body) {
      assertVerbAllowed(pluginId, "todos.comment");
      return addComment({ workItemId: todoId, body, author, authorKind: "system" });
    },
  };
}
