import type { GatewayEmit } from "@jinn/gateway-events";
import { loadJobs } from "../cron/jobs.js";
import { reloadScheduler } from "../cron/scheduler.js";
import { disposeUnservableBackends } from "../plugins/backend.js";
import { scanPlugins } from "../plugins/discovery.js";
import { isPluginEnabled } from "../plugins/enablement.js";
import { reconcilePluginWatchers } from "../plugins/watcher-supervisor.js";
import { logger } from "../shared/logger.js";
import type { JinnConfig } from "../shared/types.js";
import { setDepartmentChangeListener } from "./department-registry.js";
import type { WatcherCallbacks } from "./watcher.js";

/** The two reloads that only the server can perform, since they own state it holds. */
export interface WatchDependencies {
  reloadConfig: () => void;
  /** The config as it stands after `reloadConfig`, for the callbacks that have to
   *  act on what changed rather than only announce it. */
  getConfig: () => Pick<JinnConfig, "plugins">;
  reloadOrg: () => void;
  emit: GatewayEmit;
}

/** What the gateway does when a watched path changes. Each callback re-reads the
 *  thing that changed and tells connected clients, so an edit on disk takes effect
 *  without a restart. */
export function gatewayWatchCallbacks({ reloadConfig, getConfig, reloadOrg, emit }: WatchDependencies): WatcherCallbacks {
  // A department file edited, refused or deleted changes its scope badge and panel, so
  // clients refetch the department list.
  setDepartmentChangeListener((slug) => emit("company:changed", { entity: "department", action: "changed", id: slug }));
  return {
    onConfigReload: () => {
      reloadConfig();
      // config.yaml is what turns a plugin off, so this is the edge a disabled
      // plugin has to lose its loaded backend on. Waiting for a request instead
      // means a disable and a re-enable with nothing in between never drops it.
      disposeUnservableBackends((id) => isPluginEnabled(id, getConfig()));
      // And the same edge a disabled plugin's watcher has to stop on. Not
      // awaited: reconciling imports plugin modules, and a config reload does
      // not wait on third-party code.
      void reconcilePluginWatchers(getConfig);
    },
    onCronReload: () => {
      const updatedJobs = loadJobs();
      const { scheduled, skipped } = reloadScheduler(updatedJobs);
      logger.info(`Cron jobs reloaded (${scheduled} scheduled${skipped > 0 ? `, ${skipped} invalid skipped` : ""})`);
      emit("cron:reloaded", {});
    },
    onOrgChange: reloadOrg,
    onSkillsChange: () => {
      logger.info("Skills changed, notifying clients");
      emit("skills:changed", {});
    },
    onPluginsChange: () => {
      // Rescanning here rather than only on request is what surfaces a broken
      // manifest in the log at the moment it is saved, instead of the next time
      // somebody opens the settings page.
      void scanPlugins()
        .then((plugins) => {
          logger.info(`Plugins rescanned (${plugins.length} installed)`);
          emit("plugins:changed", {});
          // An edit to a plugin's server.js is a new incarnation: the watcher the
          // old one started is stopped before the new one is asked to start.
          return reconcilePluginWatchers(getConfig);
        })
        .catch((err) => logger.error(`Plugin rescan failed: ${err instanceof Error ? err.message : err}`));
    },
  };
}
