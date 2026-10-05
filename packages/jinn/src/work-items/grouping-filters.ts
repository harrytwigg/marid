import { projectFilterCondition } from './projects-schema.js';
import { sprintFilterCondition } from './sprints-schema.js';

/** The WHERE conditions of the filters that group Todos: the sprint and the project they belong to. */
export function groupingFilterConditions(filter: { sprint?: string; project?: string }): Array<{ sql: string; values: string[] }> {
  return [
    ...(filter.sprint ? [sprintFilterCondition(filter.sprint)] : []),
    ...(filter.project ? [projectFilterCondition(filter.project)] : []),
  ];
}
