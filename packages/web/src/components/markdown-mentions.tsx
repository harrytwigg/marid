import { useMemo, type ComponentProps } from "react";
import type ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { TodoMention } from "./todo-mention";
import { rehypeTodoMentions, TODO_MENTION_TAG } from "@/lib/markdown-todo-mentions";
import { EMPLOYEE_MENTION_TAG, rehypeEmployeeMentions } from "@/lib/markdown-employee-mentions";
import { mentionRoster } from "@/lib/mentions";
import type { Employee } from "@/lib/api";

/* The two kinds of mention MarkdownView can render — a Todo id and an `@name` —
 * as the rehype plugins that find them and the components that draw them. */

type RehypePlugins = NonNullable<ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>;

// `components` is typed over HTML tag names and the mention elements are not
// among them, which is the whole of what the casts buy; every other entry
// stays checked.
const TODO_MENTION_COMPONENT = {
  [TODO_MENTION_TAG]: ({ id }: { id?: string }) => <TodoMention id={id ?? ""} />,
} as Components;

/** The chip an `@name` in a comment becomes: the roster employee's display name,
 *  with the handle as its title. */
function employeeMentionComponent(roster: Map<string, Employee>): Components {
  return {
    [EMPLOYEE_MENTION_TAG]: ({ name }: { name?: string }) => (
      <span
        data-testid="employee-mention"
        title={`@${name ?? ""}`}
        className="whitespace-nowrap rounded-[6px] bg-[var(--accent-fill)] px-1 font-medium text-[var(--accent)]"
      >
        {roster.get(name ?? "")?.displayName ?? name}
      </span>
    ),
  } as Components;
}

/** Plugins and components for the mentions a document asks for: Todo ids when
 *  `todoIds`, `@name` chips when `employees` is given. */
export function useMarkdownMentions(
  todoIds: boolean,
  employees: Map<string, Employee> | undefined,
): { rehypePlugins: RehypePlugins; components: Components } {
  const roster = useMemo(
    () => (employees ? new Map(mentionRoster(employees.values()).map((e) => [e.name.toLowerCase(), e])) : null),
    [employees],
  );
  const rehypePlugins = useMemo(() => {
    const plugins: RehypePlugins = [];
    if (todoIds) plugins.push(rehypeTodoMentions);
    if (roster) plugins.push([rehypeEmployeeMentions, { isRoster: (name: string) => roster.has(name) }]);
    return plugins;
  }, [todoIds, roster]);
  const components = useMemo(
    (): Components => ({
      ...(todoIds ? TODO_MENTION_COMPONENT : {}),
      ...(roster ? employeeMentionComponent(roster) : {}),
    }),
    [todoIds, roster],
  );
  return { rehypePlugins, components };
}
