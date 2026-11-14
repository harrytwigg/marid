/**
 * The dashboard half of the reference plugin.
 *
 * Plain ESM, loaded straight off disk with no build step. JSX is available in a
 * disk plugin — the gateway compiles a client half that turns out to hold any —
 * and this one is written without it on purpose: a file that is already ESM is
 * served byte for byte, so what runs here is exactly what is on disk. Elements
 * are built by calling `jsx()` and `jsxs()` from the SDK. `jsx` takes one child,
 * `jsxs` takes an array of them.
 *
 * The three imports below are the complete list a disk plugin may write:
 * `@hundredfold/plugin-sdk`, `react`, and `react/jsx-runtime`. Anything else is
 * rejected by the loader with a named error, and React in particular has to come
 * from here rather than from a copy of its own, or every hook would throw.
 */
import {
  AREAS,
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  Input,
  React,
  ScrollArea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  host,
  jsx,
  jsxs,
} from '@hundredfold/plugin-sdk'

/** The badge variant each state reads as, so a plugin's chip and the app's own
 *  say the same thing the same way. */
const STATE_VARIANT = {
  pending: 'warning',
  approved: 'success',
  rejected: 'destructive',
}

/** A menu row is a tap target, and the default row height sits just under the
 *  34px one needs on a phone. */
const MENU_ITEM_STYLE = { minHeight: 34 }

export default {
  id: 'inbox-demo',
  name: 'Inbox Demo',

  register(ctx) {
    /**
     * The message list, kept live.
     *
     * `ctx.backend` calls this plugin's own routes; it takes a path relative to
     * the mount and supplies the plugin id itself, so one plugin can never call
     * another's. `ctx.events` is the same idea for the event stream: it opens
     * this plugin's channel and hands back an unsubscribe, which is exactly what
     * an effect wants to return.
     */
    function useMessages() {
      const [messages, setMessages] = React.useState([])

      const refresh = React.useCallback(async () => {
        const response = await ctx.backend('/messages')
        if (!response.ok) return
        const body = await response.json()
        setMessages(Array.isArray(body.messages) ? body.messages : [])
      }, [])

      React.useEffect(() => {
        void refresh()
        // Every event the backend emits is a reason to re-read: an arrival from
        // the watcher, and a decision made in another tab alike.
        return ctx.events(() => void refresh())
      }, [refresh])

      return { messages, refresh }
    }

    async function decide(id, verdict) {
      await ctx.backend(`/${verdict}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      // The object form of notify: a title with the detail under it, landing on
      // the same stack `host.notify('…')` writes to.
      host.notify({
        title: `Message ${verdict}d`,
        description: `${id} is out of the pending queue.`,
        level: verdict === 'reject' ? 'warning' : 'info',
      })
    }

    function DecideButton({ label, tint, onPress }) {
      return jsx('button', {
        type: 'button',
        onClick: onPress,
        // Tokens only, and no border at rest: a soft tinted fill is how the app
        // separates a control from its surface.
        style: {
          height: 34,
          padding: '0 14px',
          border: 'none',
          borderRadius: 'var(--radius-md)',
          background: `color-mix(in srgb, ${tint} 12%, transparent)`,
          color: tint,
          font: 'inherit',
          fontSize: 'var(--text-footnote)',
          fontWeight: 'var(--weight-medium)',
          cursor: 'pointer',
        },
        children: label,
      })
    }

    function MessageRow({ message }) {
      return jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          minHeight: 56,
          padding: '0 var(--space-3)',
        },
        children: [
          jsxs('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
            children: [
              jsx('span', {
                style: {
                  fontSize: 'var(--text-subheadline)',
                  fontWeight: 'var(--weight-medium)',
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
                children: message.subject,
              }),
              jsx(Badge, { variant: STATE_VARIANT[message.state], children: message.state }),
            ],
          }),
          message.state === 'pending' &&
            jsxs('div', {
              style: { display: 'flex', gap: 'var(--space-2)' },
              children: [
                jsx(DecideButton, {
                  label: 'Approve',
                  tint: 'var(--system-green)',
                  onPress: () => void decide(message.id, 'approve'),
                }),
                jsx(DecideButton, {
                  label: 'Reject',
                  tint: 'var(--system-red)',
                  onPress: () => void decide(message.id, 'reject'),
                }),
              ],
            }),
        ],
      })
    }

    /** The header's overflow menu: one row narrows the list, the other explains
     *  where messages come from with a notice. */
    function ActionsMenu({ pendingOnly, onTogglePending }) {
      return jsxs(DropdownMenu, {
        children: [
          jsx(DropdownMenuTrigger, {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              height: 34,
              padding: '0 12px',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              background: 'var(--fill-tertiary)',
              color: 'var(--text-secondary)',
              font: 'inherit',
              fontSize: 'var(--text-footnote)',
              cursor: 'pointer',
            },
            children: 'Actions',
          }),
          jsxs(DropdownMenuContent, {
            align: 'end',
            children: [
              jsx(DropdownMenuItem, {
                style: MENU_ITEM_STYLE,
                onSelect: onTogglePending,
                children: pendingOnly ? 'Show every message' : 'Show only pending',
              }),
              jsx(DropdownMenuItem, {
                style: MENU_ITEM_STYLE,
                onSelect: () =>
                  host.notify({
                    title: 'Inbox is watched',
                    description: 'New files in the watched directory arrive here on their own.',
                  }),
                children: 'How this works',
              }),
            ],
          }),
        ],
      })
    }

    function InboxPage() {
      const { messages } = useMessages()
      const [query, setQuery] = React.useState('')
      const [pendingOnly, setPendingOnly] = React.useState(false)

      const visible = messages.filter(
        (message) =>
          (!pendingOnly || message.state === 'pending') &&
          message.subject.toLowerCase().includes(query.trim().toLowerCase()),
      )

      return jsxs('div', {
        style: { maxWidth: 840, margin: '0 auto', padding: 'var(--space-6) var(--space-5)' },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' },
            children: [
              // A glyph named rather than imported: the loader resolves the SDK,
              // React and the JSX runtime, and no icon library.
              jsx(Icon, { name: 'inbox', size: 20 }),
              jsx('h1', {
                style: {
                  flex: 1,
                  fontFamily: 'var(--font-display)',
                  fontSize: 'var(--text-title1)',
                  fontWeight: 700,
                  color: 'var(--text-primary)',
                },
                children: 'Inbox Demo',
              }),
              jsx(ActionsMenu, {
                pendingOnly,
                onTogglePending: () => setPendingOnly((only) => !only),
              }),
            ],
          }),
          jsxs(Tooltip, {
            children: [
              jsx(TooltipTrigger, {
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  minHeight: 34,
                  padding: 0,
                  border: 'none',
                  background: 'none',
                  color: 'var(--text-tertiary)',
                  font: 'inherit',
                  fontSize: 'var(--text-footnote)',
                  cursor: 'default',
                },
                children: `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`,
              }),
              jsx(TooltipContent, {
                children: 'Drop a file in the watched inbox to add one.',
              }),
            ],
          }),
          jsx(Input, {
            value: query,
            onChange: (event) => setQuery(event.target.value),
            placeholder: 'Filter by subject',
            style: { marginTop: 'var(--space-4)' },
          }),
          jsx(ScrollArea, {
            style: {
              marginTop: 'var(--space-4)',
              maxHeight: 360,
              borderRadius: 'var(--radius-xl)',
              background: 'var(--bg-secondary)',
              boxShadow: 'var(--shadow-card)',
              padding: 'var(--space-1)',
            },
            // The third argument to jsx() is the key, which is how a no-build
            // plugin writes what `key={...}` would have written.
            children: visible.map((message) => jsx(MessageRow, { message }, message.id)),
          }),
        ],
      })
    }

    /** The status bar chip. Nothing pending is nothing to say, so it renders
     *  nothing rather than a zero. */
    function PendingChip() {
      const { messages } = useMessages()
      const pending = messages.filter((message) => message.state === 'pending').length
      if (pending === 0) return null

      return jsx('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          height: 34,
          padding: '0 10px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--fill-tertiary)',
          fontSize: 'var(--text-caption2)',
          color: 'var(--text-secondary)',
        },
        children: `${pending} pending`,
      })
    }

    // All three v1 surfaces, registered in one batch so unloading takes them
    // down together. The ids are local: the host namespaces them under this
    // plugin, which is why two plugins can both contribute a "page".
    ctx.contributeMany([
      {
        id: 'page',
        area: AREAS.routes,
        data: { path: '/inbox-demo' },
        render: () => jsx(InboxPage, {}),
      },
      {
        id: 'nav',
        area: AREAS.sidebarNav,
        // A name out of the SDK's icon set. A row that names none, or one the
        // set does not carry, gets the host's fallback glyph instead.
        data: { href: '/inbox-demo', label: 'Inbox Demo', icon: 'inbox' },
      },
      {
        id: 'chip',
        area: AREAS.statusBarRight,
        render: () => jsx(PendingChip, {}),
      },
    ])
  },
}
