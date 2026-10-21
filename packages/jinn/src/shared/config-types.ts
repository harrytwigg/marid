/**
 * The `config.yaml` shape. It lives beside `types.ts` rather than inside it so
 * the config schema can grow without pushing the shared type surface past its
 * size budget; `types.ts` re-exports `JinnConfig` so every existing importer is
 * unaffected.
 */
import type { TerminalConfig } from "./terminal-config.js";
import type { BoardHookConfig } from "./board-hooks-config.js";
import type { RemoteMcpConfig } from "./remote-mcp-config.js";
import type { TodoDepartmentsConfig } from "./todo-departments-config.js";
import type { AutoCompactConfig } from "./auto-compact-config.js";
import type { ContextConfig } from "./context-config.js";
import type { SessionFallbackMode } from "./session-fallback-config.js";
import type { ClaudeAccountConfig } from "./claude-accounts-config.js";
import type { FallbackChainEntry } from "./fallback-chain-wire.js";
import type { EngineName } from "./models.js";
import type { MusecodeEngineConfig } from "./musecode-config.js";
import type { FreebuffEngineConfig } from "./freebuff-config.js";
import type { RealtimeConfig, SttConfig, TalkConfig } from "./voice.js";
import type {
  ConnectorInstance,
  CronDelivery,
  DiscordConnectorConfig,
  McpGlobalConfig,
  ModelsConfig,
  SlackConnectorConfig,
  TelegramConnectorConfig,
  WebConnectorConfig,
  WhatsAppConnectorConfig,
} from "./types.js";

export interface PortalConfig {
  companyName?: string;
  companyPrefix?: string;
  portalName?: string;
  operatorName?: string;
  operatorEmoji?: string;
  language?: string;
  onboarded?: boolean;
  setupComplete?: boolean;
}

export interface JinnConfig {
  /** The instance's own record, keyed by the codename in either spelling: version, and the built-in MCP server's name. */
  jinn?: { version?: string; mcpServerName?: string };
  gateway: {
    port: number;
    host: string;
    streaming?: boolean;
    /** Expose the editable Notes feature. Defaults to false while the implementation stays dormant. */
    notesEnabled?: boolean;
    /** Opt-in unsafe local convenience: allow POST /api/files to write a custom managed path. Default false. */
    allowFileCustomPaths?: boolean;
    /** Opt-in unsafe local convenience: allow POST /api/files {open:true} to open uploaded files. Default false. */
    allowFileOpen?: boolean;
    /** Require token/cookie auth even on loopback. Network binds require auth by default. */
    authRequired?: boolean;
    /** Disable gateway auth. Refused on network binds unless insecureAllowUnauthenticatedNetwork is true. */
    authDisabled?: boolean;
    /** Explicit escape hatch for unauthenticated 0.0.0.0/LAN/Tailscale binds. */
    insecureAllowUnauthenticatedNetwork?: boolean;
    /** Nudge sessions this gateway's own restart interrupted to continue on the
     *  next boot, and a claude session whose process ended under background
     *  tasks to carry on. Default true; false leaves them for the operator. */
    resumeInterruptedSessions?: boolean;
    /** Bounded Todo recovery. Unset = classify-only: lanes and
     *  metrics, no automatic re-arm. `auto` is a reviewed production gate. */
    todoRecovery?: { mode?: "off" | "classify-only" | "auto" };
    /** Nudge an `executing` Todo's producer when nothing has run for a while, then
     *  tell whoever owns the work from above if it stays quiet. Unset = on, 15 min
     *  (60 min while the producer still counts a background shell task of its own). */
    todoQuietWatch?: { enabled?: boolean; afterMinutes?: number; backgroundTaskMinutes?: number };
    /** Closed Todo departments (JIN-1): unset = open; see shared/todo-departments-config.ts. */
    todoDepartments?: TodoDepartmentsConfig;
    /** Remote MCP connector at `/mcp`: off unless enabled; see shared/remote-mcp-config.ts. */
    remoteMcp?: RemoteMcpConfig;
    /** Opt-in: when set, POST /api/sessions reads the forwarded SSO identity
     *  from this request header (set by an auth proxy such as oauth2-proxy,
     *  Traefik forward-auth, or IAP) and persists it on the session. Accepts a
     *  single header name or a priority-ordered list. Unset = single-user
     *  no-op (sessions default to "web-user", header never read). */
    userHeader?: string | string[];
  };
  engines: {
    default: EngineName;
    claude: {
      bin: string;
      model: string;
      effortLevel?: string;
      childEffortOverride?: string;
      /** Max idle warm processes (interactive PTYs, local opencode servers) on the
       *  gateway host itself; running or viewed ones never count. Default 8. A remote
       *  host's processes do not count toward it: see {@link maxLivePtysByHost}. */
      maxLivePtys?: number;
      /** Idle cap for the interactive processes on one remote host. Keys are an
       *  employee's `remoteHost` exactly as written on the employee. A remote
       *  host not listed gets {@link maxLivePtys} for itself. Opencode servers on a
       *  remote host are bounded by `engines.opencode.server.maxIdleByHost` instead. */
      maxLivePtysByHost?: Record<string, number>;
      /** Model ids shown by default in the picker (before "More models…"). Defaults
       *  to the three latest alias families (opus/sonnet/fable). Explicit [] = none. */
      featuredModels?: string[];
      /** Auto-answer Claude Code's hardcoded safety prompts (dangerous rm on a
       *  possibly-empty variable path, the `&` background operator, suspicious
       *  Windows paths) — the ones --dangerously-skip-permissions does NOT
       *  suppress. Default true: a gateway PTY has no keyboard, so leaving them
       *  unanswered wedges the session. Set false to require a human in the
       *  CLI/xterm view; the turn then fails on the stall backstop instead. */
      autoApproveSafetyPrompts?: boolean;
      /** Targets to try instead, in order of preference, when this one cannot serve a
       *  turn: `{engine, profile?, model?}` mappings, or the legacy strings (an engine
       *  name, or `claude:<name>` for an account under `accounts` below), which stand for
       *  that target followed by its own chain. A chain may not name its own target or
       *  list one twice; two engines may name each other. Absent = no fallback, which
       *  is also what an explicit [] says. See shared/fallback-chain-wire.ts. */
      fallback?: FallbackChainEntry[];
      accounts?: Record<string, ClaudeAccountConfig>;
      /** How this engine's pinned models translate onto whichever engine stands in
       *  for it, as `<model this engine serves>: <model the substitute serves>`. A
       *  model id belongs to one provider, so an unmapped pin is dropped and the
       *  substitute runs on its own default — this is only for keeping the tier a
       *  turn was sized for, e.g. a cheap model swapping to a cheap one. */
      fallbackModelMap?: Record<string, string>;
      /** Compact a long session first: cache-cold, or past its context budget. See auto-compact-config.ts. */
      autoCompact?: AutoCompactConfig;
    };
    codex: { bin: string; model: string; effortLevel?: string; childEffortOverride?: string; fallback?: FallbackChainEntry[]; fallbackModelMap?: Record<string, string> };
    /** Antigravity (`agy`) engine. `bin` is optional — resolved dynamically
     *  (PATH + common install dirs) when absent. agy ignores model/effort flags
     *  today, so those fields are forward-looking. */
    antigravity?: { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string; fallback?: FallbackChainEntry[]; fallbackModelMap?: Record<string, string> };
    grok?: { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string; fallback?: FallbackChainEntry[]; fallbackModelMap?: Record<string, string> };
    pi?: { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string; fallback?: FallbackChainEntry[]; fallbackModelMap?: Record<string, string> };
    /** Hermes (`hermes` CLI) engine. `bin` optional — PATH-resolved. No effort. */
    hermes?: { bin?: string; model?: string; fallback?: FallbackChainEntry[]; fallbackModelMap?: Record<string, string> };
    /** opencode (`opencode` CLI) engine. `bin` optional — PATH-resolved. `model`
     *  is opencode's own `provider/model` form. No effort: `--variant` is
     *  provider-specific and opencode reports no list to validate against. */
    opencode?: {
      bin?: string;
      model?: string;
      fallback?: FallbackChainEntry[];
      fallbackModelMap?: Record<string, string>;
      /**
       * How a turn reaches opencode. `run` (the default) spawns one headless
       * `opencode run` per turn, exactly as before this option existed. `server`
       * keeps an `opencode serve` per session, sends each turn to it over its
       * HTTP API, and offers the dashboard terminal view, which is an
       * `opencode attach` client on that same server. See docs/engines-opencode.md.
       */
      mode?: OpencodeMode;
      /** Server-mode tuning; ignored in `run` mode. */
      server?: OpencodeServerConfig;
      /**
       * Default true: Marid sets `OPENCODE_DISABLE_FFF=1` on every opencode process
       * it starts (run and server, local and remote), which turns off opencode's
       * bundled fff file indexer. On a work root with many nested repos or worktrees
       * that indexer pegs a CPU (anomalyco/opencode#50719). Set false to let opencode
       * run it. false only means Marid does not set the variable: one the gateway
       * inherits from its own environment is not stripped. Drop this option once
       * opencode bundles `@ff-labs/fff-bun` >= 0.11 or #50719 is fixed.
       */
      disableFff?: boolean;
      /**
       * The longest one shell command of an opencode turn may run, in ms
       * (default 1800000, 30 min; 0 turns it off). opencode lets the model pick a
       * command's timeout with no upper bound; Marid stages a plugin that caps it
       * at this, on 1.x and 2.x, local and remote. 2.x background commands are
       * not capped. See docs/engines-opencode.md.
       */
      commandTimeoutMs?: number;
      /** meter jinn's own opencode spend against the provider's
       *  windowed allowance, since opencode publishes none to read. Absent =
       *  unmetered, exactly as before. See docs/engines-opencode.md. */
      usageLimits?: OpencodeUsageLimitsConfig;
      autoCompact?: AutoCompactConfig; // server mode only
    };
    musecode?: MusecodeEngineConfig;
    freebuff?: FreebuffEngineConfig;
  };
  /** Optional model + capability registry. When absent, synthesized from engines.<name>.model. */
  models?: ModelsConfig;
  connectors: Record<string, any> & {
    web?: WebConnectorConfig;
    slack?: SlackConnectorConfig;
    telegram?: TelegramConnectorConfig;
    discord?: DiscordConnectorConfig;
    whatsapp?: WhatsAppConnectorConfig;
    /** Named connector instances — allows multiple connectors of the same type */
    instances?: ConnectorInstance[];
  };
  logging: { file: boolean; stdout: boolean; level: string };
  mcp?: McpGlobalConfig;
  /** Installed plugins the operator has explicitly decided on. Absence is not
   *  enabled and `disabled` wins over `enabled` (src/plugins/enablement.ts);
   *  `settings[<id>]` reaches that plugin as `ctx.settings` (plugins/backend.ts). */
  plugins?: { enabled?: string[]; disabled?: string[]; settings?: Record<string, Record<string, unknown>> };
  /** Spend caps keyed by employee name: a USD cap on that employee's total spend across the
   *  current calendar month — NOT a per-session cap. At or above it, their turns are blocked. */
  budgets?: { employees?: Record<string, number> };
  sessions?: {
    interruptOnNewMessage?: boolean;
    staleChat?: {
      enabled?: boolean;
      tokenThreshold?: number;
      staleAfterMinutes?: number;
    };
    /** Max relay hops a lateral (agent-to-agent) send chain may traverse before
     *  the gateway refuses and tells the sender to escalate. Default 12; clamped
     *  to [1, 64] (still a runaway-loop bound, never unbounded). */
    lateralMaxHops?: number;
    /** What to do when Claude hits a usage/rate limit. Default: "wait" (no automatic engine switch). Set to "fallback" to opt in to switching to Codex while Claude resets. */
    rateLimitStrategy?: "wait" | "fallback";
    /** Engine to use when rateLimitStrategy="fallback". Default: "codex" */
    fallbackEngine?: "codex";
    /** What a session without its own setting does at a usage limit (session-fallback-config.ts).
     *  Default "fallback". Children of a `fallback` session get `auto-resume`;
     *  "fallback-children" restores tree-wide fallback. */
    fallbackMode?: SessionFallbackMode;
  };
  cron?: {
    defaultDelivery?: CronDelivery;
    alertChannel?: string;
    alertConnector?: string;
    /** If a cron job takes longer than this (ms), post a latency warning to the alert channel. Default: 300000 (5 min). */
    alertThresholdMs?: number;
  };
  notifications?: {
    connector?: string;  // defaults to "discord"
    channel?: string;    // Discord channel ID for admin notifications
  };
  /**
   * @deprecated Workflows were removed. The key is still accepted so an older
   * config.yaml loads and saves unchanged; nothing reads it.
   */
  workflows?: unknown;
  portal?: PortalConfig;
  context?: ContextConfig;
  /**
   * Steers agents that search the instance's knowledge. Absent leaves the
   * built-in wording untouched.
   */
  knowledge?: {
    /** Appended to the knowledge section of the prompt and to the `search_knowledge` description. */
    guidance?: string;
    /** Returned by `search_knowledge` when a search finds nothing, in place of the built-in hint. */
    missHint?: string;
  };
  stt?: SttConfig;
  /** Read-aloud TTS (`/api/tts` + Kokoro) — optional, off unless configured. */
  talk?: TalkConfig;
  /**
   * Speech-to-speech realtime provider — optional, off unless configured. A
   * sibling of `talk` rather than a child of it, because `talk`'s
   * enabled/engine/orchestratorModel fields are retired-orchestrator residue
   * slated for removal.
   */
  realtime?: RealtimeConfig;
  /**
   * Remote (SSH) execution for employees that declare `remoteHost`. Absent means
   * remote employees refuse to load at all — the fail-closed default, because
   * this ships to strangers and a remote session runs
   * `--dangerously-skip-permissions` on someone's real machine.
   */
  remote?: RemoteExecutionConfig;
  /** Operator terminals on the gateway and other machines. */
  terminal?: TerminalConfig;
  /** Reactions to Todo board events (docs/board-hooks.md). */
  hooks?: BoardHookConfig[];
}

export type OpencodeMode = "run" | "server";

/**
 * Limits for opencode server mode.
 *
 * A warm server holds a full opencode process (~650 MB on build-host) plus its
 * MCP servers, so idle ones are bounded two ways: by COUNT per host, and by
 * AGE. Servers serving a turn or watched in the terminal are never counted or
 * reaped. A warm server on the gateway host also counts toward
 * `engines.claude.maxLivePtys`, the idle cap it shares with the interactive
 * engines' local PTYs; a server on a remote host is bounded by the per-host
 * count alone.
 */
export interface OpencodeServerConfig {
  /** Idle warm servers kept per host. Default 2. */
  maxIdle?: number;
  /** Per-host override of {@link maxIdle}. Keys are an employee's `remoteHost`
   *  exactly as written on the employee, or `local` for the gateway itself. */
  maxIdleByHost?: Record<string, number>;
  /** An idle server is stopped after this long. Default 900000 (15 minutes). */
  idleTtlMs?: number;
  /** How long a starting server may take to answer its health check. Default 30000. */
  startTimeoutMs?: number;
  /** How long a healthy server may then take to bootstrap its instance — load
   *  its config and plugins, installing plugin dependencies on first use —
   *  before it is given up on and the turn runs as a plain `opencode run`.
   *  Default 120000. */
  bootstrapTimeoutMs?: number;
}

/**
 * Remote (SSH) execution settings. One block for the whole instance: every
 * remote employee shares the sandbox root, the JINN_HOME mount point, and the
 * wake policy. Per-employee variation lives on the Employee record (host, user,
 * cwd) and nowhere else.
 */
export interface RemoteExecutionConfig {
  /** The one absolute prefix on the remote host that every `remoteCwd` must
   *  resolve under. The single most proportionate guardrail for running
   *  unattended with `--dangerously-skip-permissions` on a daily-driver box: it
   *  does not stop a determined prompt from `cd ..`-ing out, but it bounds the
   *  realistic accidental blast radius. */
  root: string;
  /** Where the gateway's own JINN_HOME is sshfs-mounted on the remote host. The
   *  remote session's `$JINN_HOME` is a symlink farm over this, so knowledge,
   *  docs, org and skills are the gateway's real files rather than copies. */
  mount: string;
  /**
   * Default `CLAUDE_CONFIG_DIR` for remote sessions on these hosts — i.e. which
   * Claude Code profile they run as. An employee's own
   * `remoteClaudeConfigDir` overrides it; unset on both means the remote
   * user's default profile.
   *
   * Set this rather than pointing `claude` at a profile-manager wrapper. Those
   * wrappers typically unset every `CLAUDE_*` variable before exec, which would
   * strip the three the session depends on — including
   * `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD`, whose absence lets the "resume from
   * summary?" picker appear in front of a PTY with nobody at the keyboard.
   */
  claudeConfigDir?: string;
  /** Run ON THE GATEWAY to wake a sleeping host (smart plug, jump box, …).
   *  Takes precedence over {@link wakeMac}. */
  wakeCommand?: string;
  /** MAC address for the built-in Wake-on-LAN magic packet, used when
   *  {@link wakeCommand} is unset. */
  wakeMac?: string;
  /** Run ON THE REMOTE once it is reachable, to re-establish the JINN_HOME
   *  mount. A reboot does not bring sshfs back, so a successful wake normally
   *  lands on a dead mount without this. */
  remountCommand?: string;
  /**
   * How long {@link wakeCommand} may run before it is killed, in ms.
   * Default 300000 (5 minutes).
   *
   * Generous on purpose. A real startup path is not a fire-and-forget packet:
   * it may probe reachability, read a power state over the network, press a
   * physical ATX button and then wait for POST. Killing that partway through
   * can land between the state read and the press — no press, no wake, and a
   * turn that simply times out with nothing to show for it.
   */
  wakeTimeoutMs?: number;
  /** Total bound on waiting for an unreachable host, in ms. Default 240000.
   *  Bounded on purpose: a box that is off for the weekend must fail the turn,
   *  not pin it at "waiting" forever. */
  waitMs?: number;
  /** Interval between reachability probes, and between mount checks, while
   *  waiting, in ms. Default 10000. */
  probeIntervalMs?: number;
  /** Bound on waiting for the instance-home mount once the host answers, in ms.
   *  Default 120000. Separate from {@link waitMs}: a freshly booted host can
   *  answer ssh well before its sshfs has connected. */
  mountWaitMs?: number;
}

/**
 * `engines.opencode.usageLimits`. OpenCode Go gives each model its own
 * monthly allowance in dollars of usage, and meters it over three windows: five
 * hours at 20% of it, seven days at 50%, thirty days at 100%.
 */
export interface OpencodeUsageLimitsConfig {
  /** Monthly allowance in USD, keyed by opencode `provider/model` id. A
   *  `provider/*` key covers every model of that provider an exact key does not
   *  name. A model matching no key is not metered. */
  monthlyUsd?: Record<string, number>;
}
