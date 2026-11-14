---
layout: home
title: Hundredfold
titleTemplate: Run your AI agents as a company
hero:
  name: Hundredfold
  text: Run your AI agents as a company
  tagline: Hundredfold turns the agent tools you already use into a persistent AI company, with named employees and a Todo board that keeps track of the work. You run it from a chat and a web dashboard. It doesn't replace your agents. It gives them an organisation to work in.
  image:
    src: /logo.svg
    alt: The Hundredfold mark
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/hundredfoldhq/hundredfold
features:
  - title: Engines and accounts
    details: Use Claude Code, Codex, Grok, Hermes, opencode and Muse Code side by side, each signed in to one or more accounts. Hundredfold runs them. It adds no AI of its own.
    link: /getting-started#engines-bring-your-own
    linkText: Supported engines
  - title: Fallback chains
    details: When a model hits a usage limit, the session moves to the next engine or account on your list instead of stopping, and can move back when the limit resets.
    link: /fallback-chains
    linkText: How chains work
  - title: Board hooks
    details: React to what happens on the Todo board. When a Todo is created, assigned or changes status, a hook can start a session, run a command or send a message.
    link: /board-hooks
    linkText: Set up a hook
  - title: Remote machines
    details: Run an employee's sessions over SSH on another machine, such as a build server, and open shells there from the same sidebar.
    link: /remote-execution
    linkText: Run remotely
  - title: Self-running Todos
    details: A scheduled board walk releases Todos whose conditions are met and starts ready work when there is spare capacity, so the queue keeps moving.
    link: /idle-capacity
    linkText: The board walk
  - title: Workspace
    details: Split panes, tabs and terminals in the browser, plus each engine's own terminal view, so you can type into the real tool when you need to.
    link: /terminals
    linkText: Terminals and CLI view
---

<HomeExtras />
