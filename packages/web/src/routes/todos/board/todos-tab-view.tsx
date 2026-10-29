import { TodoBoard } from "./board-page"
import { TodosTabLocationProvider } from "./todos-tab-location"

/** The Todos board as a chat layout tab: the board itself, without the route's chrome, keeping its
 *  board and filters in the tab's own location rather than the address bar. Lazily loaded by
 *  DocView, so the chat pays for none of it until the tab opens. */
export default function TodosTabView() {
  return (
    <TodosTabLocationProvider>
      <TodoBoard embedded />
    </TodosTabLocationProvider>
  )
}
