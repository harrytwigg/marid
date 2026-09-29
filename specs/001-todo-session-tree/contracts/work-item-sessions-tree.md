# Contract: `GET /api/work-items/:id/sessions?tree=1`

**Status**: extension of an existing route (`packages/jinn/src/gateway/api.ts:2828`). The route,
its id validation (`requireTodoRouteId`), and its auth are unchanged.

## Backward compatibility (binding)

**Without `tree=1` the response is byte-identical to today's.** It remains
`serializeSessionList(listSessionsByWorkItem(id))` — a flat `Session[]`. This is not a courtesy:
`packages/web/src/components/talk/context/surface-adapters.ts:54` reads the
`["work-item-sessions", id]` cache and the Todo page's own `hasLiveSession` /
`dispatcherSession` derivations (`task-page.tsx:147-149`) both consume the flat array. A contract
test must assert the un-parameterised shape did not change.

## Request

```
GET /api/work-items/{todoId}/sessions?tree=1
Authorization: Bearer <gateway token>
```

- `todoId` — an existing Todo id. Unknown id → the route's existing 404 behaviour.
- Any value of `tree` other than `1` is treated as absent.

## Response `200`

```json
{
  "roots": [
    {
      "id": "15279347-a990-4e8a-a293-64f727babe6c",
      "employee": "todo-dispatcher",
      "status": "running",
      "title": "Dispatch TST-81",
      "role": "execute",
      "workItemId": "TST-81",
      "isRootLink": true,
      "archived": false,
      "truncated": null,
      "children": [
        {
          "id": "9f2c…",
          "employee": "senior-developer",
          "status": "running",
          "title": "Release the workflow-trigger claim",
          "role": "execute",
          "workItemId": "TST-83",
          "isRootLink": false,
          "archived": false,
          "truncated": null,
          "children": []
        },
        {
          "id": "b71a…",
          "employee": "qa",
          "status": "idle",
          "title": "Review TST-81",
          "role": "review",
          "workItemId": "TST-81",
          "isRootLink": false,
          "archived": false,
          "truncated": null,
          "children": []
        }
      ]
    }
  ],
  "directory": {
    "15279347-a990-4e8a-a293-64f727babe6c": {
      "id": "15279347-a990-4e8a-a293-64f727babe6c",
      "employee": "todo-dispatcher",
      "status": "running",
      "title": "Dispatch TST-81",
      "archived": false,
      "missing": false
    }
  },
  "truncated": { "depth": false, "count": false },
  "totals": { "nodes": 3, "live": 2 }
}
```

## Behavioural guarantees

| # | Guarantee | Traces to |
| --- | --- | --- |
| C1 | Omitting `tree` returns exactly today's flat array | regression guard above |
| C2 | `roots` contains every session linked to the Todo, including archived ones and finished ones | FR-003, FR-010 |
| C3 | Each node's `children` are the sessions whose `parentSessionId` is that node | FR-003 |
| C4 | No session id appears twice; no node is its own ancestor; a cyclic parent link terminates the walk | FR-007 |
| C5 | `role` is `review` exactly when the session's link role is review; absent/NULL means `execute` | FR-006 |
| C6 | Depth > 6 or node count > 200 sets the node's `truncated` and the response-level `truncated` flag; nodes are never dropped silently | FR-008 |
| C7 | ~~A parent id not present in the session table yields a tombstone~~ — **withdrawn**: a linked session cannot be hard-deleted, so no tree node can name a missing row (see research R6). Archived sessions stay in the tree with `archived: true` | FR-010 |
| C8 | `directory` resolves every `session:<id>` the Todo references — tree nodes, `createdBy`, comment authors, audit actors | FR-001, R8 |
| C9 | The call performs no write of any kind | FR-011 |
| C10 | A Todo with no linked sessions returns `roots: []`, `totals.nodes: 0` | FR-012 |

## Client contract (web)

| Concern | Value |
| --- | --- |
| Query key | `["work-item-sessions", todoId, "tree"]` |
| Invalidation | Inherited from the existing `['work-item-sessions']` prefix arm (`packages/web/src/hooks/use-query-invalidation.ts:112`). No new arm. |
| Navigation — session | `navigate('/?session=' + encodeURIComponent(id))`, as `task-page.tsx:477` |
| Navigation — Todo | the Todo route already used by the Todo page |

## Non-goals

No write verbs. No cost or spend fields. No org-wide tree. No change to how delegation or review
is performed.
