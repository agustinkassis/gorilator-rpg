import {
  PLUGIN_API_VERSION,
  type ClientPlugin,
  type ClientPluginContext,
  type DevPanelSpec,
  type PluginItemDef,
  type PluginManifest,
} from "@rpg/shared";
import { registerExtraItemDefs } from "../items/itemRegistry";

/**
 * Client-side plugin host. Plugins are discovered through /plugins/manifest.json
 * (served by the pluginBundler vite plugin in dev, emitted as an asset in build);
 * each enabled manifest's `client` entry is dynamic-imported and given a context.
 *
 * Frame systems run inside perf spans (`plugin:<name>`) from the main render
 * loop; item models merge into the item registry; dev panels mount into a small
 * dev-only drawer (independent of the full Dev Mode editor).
 */
class ClientPluginHost {
  readonly frameSystems: Array<{ name: string; fn: (dt: number) => void }> = [];
  readonly devPanels: DevPanelSpec[] = [];
  readonly loadedPlugins: PluginManifest[] = [];
}

export const clientPluginHost = new ClientPluginHost();

function contextFor(manifest: PluginManifest): ClientPluginContext {
  const tag = `[plugin:${manifest.name}]`;
  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest,
    registerItemModel: (def: PluginItemDef) => {
      registerExtraItemDefs([def]);
      console.log(`${tag} item model "${def.id}" registered`);
    },
    registerFrameSystem: (name, fn) => {
      clientPluginHost.frameSystems.push({ name: `${manifest.name}:${name}`, fn });
    },
    registerDevPanel: (spec) => {
      clientPluginHost.devPanels.push(spec);
      mountDevDrawer();
    },
    log: (msg) => console.log(`${tag} ${msg}`),
  };
}

interface PluginsManifestResponse {
  plugins: Array<{ manifest: PluginManifest; clientUrl?: string }>;
}

/** Fetch the manifest list and set up every plugin with a client entry. Safe to
 *  call when no bundler/plugins exist — resolves quietly on 404. */
export async function loadClientPlugins(): Promise<void> {
  let listing: PluginsManifestResponse | null = null;
  try {
    const res = await fetch("/plugins/manifest.json", { cache: "no-store" });
    if (!res.ok) return;
    listing = (await res.json()) as PluginsManifestResponse;
  } catch {
    return; // no plugin host (e.g. plain static deploy) — fine
  }
  for (const entry of listing?.plugins ?? []) {
    const { manifest, clientUrl } = entry;
    try {
      if (!clientUrl) {
        clientPluginHost.loadedPlugins.push(manifest);
        continue;
      }
      const mod = (await import(/* @vite-ignore */ clientUrl)) as { default?: ClientPlugin };
      if (typeof mod.default?.setup !== "function") {
        console.warn(`[plugins] ${manifest.name}: client entry has no default setup() — skipped`);
        continue;
      }
      await mod.default.setup(contextFor(manifest));
      clientPluginHost.loadedPlugins.push(manifest);
      console.log(`[plugins] ${manifest.name}@${manifest.version} client loaded`);
    } catch (err) {
      console.error(`[plugins] ${manifest.name} client failed to load — skipped`, err);
    }
  }
}

// ---- minimal dev drawer for registered plugin panels (dev builds only) ----

let drawer: HTMLElement | null = null;

function mountDevDrawer(): void {
  if (!import.meta.env.DEV || drawer) return;
  drawer = document.createElement("div");
  drawer.style.cssText =
    "position:fixed; right:8px; bottom:48px; z-index:60; font:12px system-ui,sans-serif;";
  const btn = document.createElement("button");
  btn.textContent = "🔌 plugins";
  btn.style.cssText =
    "background:#1b1f2a; color:#cfd6e4; border:1px solid #394357; border-radius:6px; padding:4px 8px; cursor:pointer;";
  const body = document.createElement("div");
  body.style.cssText =
    "display:none; margin-top:6px; width:280px; max-height:50vh; overflow:auto; background:#141821ee;" +
    "border:1px solid #394357; border-radius:8px; padding:8px; color:#cfd6e4;";
  btn.addEventListener("click", () => {
    const open = body.style.display === "none";
    body.style.display = open ? "block" : "none";
    if (open && body.childElementCount === 0) {
      for (const spec of clientPluginHost.devPanels) {
        const section = document.createElement("div");
        const title = document.createElement("div");
        title.textContent = spec.title;
        title.style.cssText = "font-weight:bold; margin:6px 0 4px;";
        const host = document.createElement("div");
        section.append(title, host);
        body.appendChild(section);
        try {
          spec.mount(host);
        } catch (err) {
          console.error(`[plugins] dev panel "${spec.id}" failed to mount:`, err);
        }
      }
    }
  });
  drawer.append(btn, body);
  document.body.appendChild(drawer);
}
