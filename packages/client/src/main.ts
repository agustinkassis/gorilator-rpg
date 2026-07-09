import { ArcRotateCamera, Color4, Engine, HemisphericLight, Scene, SceneLoader, Vector3 } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import { createScene } from "./scene/createScene";
import { applyOrthoSize } from "./scene/camera";
import { compareVer } from "./util/version";
import { CharacterFactory } from "./entities/CharacterFactory";
import { preloadBanana } from "./entities/models/banana";
import { preloadBerserkerPotion } from "./entities/models/berserkerPotion";
import { loadHouse } from "./entities/models/house";
import { PropManager } from "./dev/PropManager";
import { CharacterManager } from "./dev/CharacterManager";
import { EntityCreator } from "./dev/EntityCreator";
import { AnimationTester } from "./dev/AnimationTester";
// Dev Mode editor + component labels + the editor's NIP-98 save shim. These are
// referenced only behind the build-time `DEV_TOOLS` constant below, so a production
// build (DEV_TOOLS === false) tree-shakes ALL of this code — and its heavy subtree
// (LibraryExplorer, EntityCreator, importers) — out of the bundle entirely. Verified
// by build: a prod bundle contains none of the editor's code or strings.
import { DevMode } from "./dev/DevMode";
import { DeveloperLabels } from "./dev/DeveloperLabels";
import { installDevEditorAuth } from "./dev/devEditorAuth";
import { PropImporter } from "./ui/propImporter";
import { HUD } from "./ui/hud";
import { HealthGlobe } from "./ui/healthGlobe";
import { XpBar } from "./ui/xpBar";
import { StaminaBar } from "./ui/staminaBar";
import { HungerBar } from "./ui/hungerBar";
import { CharacterSheet } from "./ui/characterSheet";
import { PlayerBadge } from "./ui/playerBadge";
import { PlayerMenu } from "./ui/playerMenu";
import { InventoryUI } from "./ui/inventory";
import { HotkeyBar } from "./ui/hotkeyBar";
import { Minimap } from "./ui/minimap";
import { ChatLog } from "./ui/chat";
import { CharacterDebugWindow } from "./ui/characterDebug";
import { DebugStats } from "./ui/debugStats";
import { Game } from "./game/Game";
import { AudioManager } from "./audio/AudioManager";
import { AudioControls } from "./ui/audioControls";
import { TopBar } from "./ui/topBar";
import { GameMenu, loadStoredShadowMode } from "./ui/gameMenu";
import { NetworkClient, type NetHandlers } from "./net/NetworkClient";
import {
  signNostrAuth,
  establishNostrIdentity,
  type NostrAuthPayload,
  type NostrIdentity,
} from "./net/nostr";
import { loadSession, clearSession } from "./net/nostrSession";
import { restoreBunkerClient, installBunkerSigner } from "./net/nip46";
import { setActiveSession, getActiveIdentity, clearActiveSession } from "./net/nostrSigner";
import { preloadMouseCursors, setupClickToMove } from "./input/ClickToMove";
import { setupSprint } from "./input/Sprint";
import { SplashScreen } from "./ui/splash";
import { TOWER_PROP_NAME } from "@rpg/shared";
import { PerfTracker } from "./perf/PerfTracker";
import { attachBabylonProbes } from "./perf/babylonProbes";
import { PerfOverlay } from "./perf/overlay";
import { buildResourceBreakdown, buildRenderProfile } from "./perf/breakdown";
import { clientPluginHost, loadClientPlugins } from "./plugins/host";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const respawnOverlay = document.getElementById("respawnOverlay") as HTMLDivElement;
const respawnCountdownEl = document.getElementById("respawnCountdown") as HTMLDivElement;
const realmOverlay = document.getElementById("realmOverlay") as HTMLDivElement;
const realmCountdownEl = document.getElementById("realmCountdown") as HTMLDivElement;
const PERF_FPS_LIMIT_STORAGE_KEY = "gorilator.perf.fpsLimit";
const PERF_FPS_LIMIT_MAX = 240;

function normalizePerfFpsLimit(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(PERF_FPS_LIMIT_MAX, Math.round(n));
}

function loadStoredPerfFpsLimit(): number {
  try {
    return normalizePerfFpsLimit(localStorage.getItem(PERF_FPS_LIMIT_STORAGE_KEY));
  } catch {
    return 0;
  }
}

function storePerfFpsLimit(limit: number) {
  try {
    localStorage.setItem(PERF_FPS_LIMIT_STORAGE_KEY, String(limit));
  } catch {
    /* ignore */
  }
}

/** Re-render the footer version popup, optionally flagging packages whose remote
 *  (latest release) version is newer than the local build. Reassigned by
 *  wireVersionPanel; called again once /api/update reports remote versions.
 *  Declared BEFORE wireVersionPanel runs so its assignment isn't a TDZ access. */
let renderVersionPanel: (remote?: Record<string, string>) => void = () => {};

// Tiny always-on version tag (bottom-right). __APP_VERSION__ is replaced at build
// time by Vite with the root app package version (see vite.config.ts).
const versionEl = document.getElementById("versionTag");
if (versionEl) {
  // In a developer build (Vite dev server / `GORILATOR_DEV` `gorilator serve`)
  // tag the version with a small DEV badge so it's obvious this isn't a release.
  if (import.meta.env.DEV) {
    versionEl.classList.add("isDev");
    versionEl.innerHTML = `<span class="devBadge">DEV</span>v${__APP_VERSION__}`;
    versionEl.title = "Developer build (live dev server)";
  } else {
    versionEl.textContent = `v${__APP_VERSION__}`;
  }
  wireVersionPanel(versionEl);
}

/** Click the footer version tag to toggle a small popup listing every workspace
 *  package version (injected at build time as __PKG_VERSIONS__). An ⬆ appears
 *  next to any package the latest release has a newer version of. */
function wireVersionPanel(tag: HTMLElement): void {
  const panel = document.getElementById("versionPanel");
  if (!panel) return;
  const versions = __PKG_VERSIONS__ ?? {};
  renderVersionPanel = (remote: Record<string, string> = {}) => {
    panel.innerHTML =
      `<div class="vpTitle">Package versions</div>` +
      Object.entries(versions)
        .map(([label, v]) => {
          const r = remote[label];
          const icon =
            r && compareVer(r, v) > 0
              ? ` <span class="vpUpd" style="color:#f5c542" title="v${r} available">⬆</span>`
              : "";
          return `<div class="vpRow"><span class="vpName">${label}</span><span class="vpVer">v${v}${icon}</span></div>`;
        })
        .join("");
  };
  renderVersionPanel();
  const close = () => {
    panel.hidden = true;
    document.removeEventListener("pointerdown", onOutside, true);
  };
  const onOutside = (e: PointerEvent) => {
    if (!panel.contains(e.target as Node) && e.target !== tag) close();
  };
  tag.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel.hidden) {
      panel.hidden = false;
      document.addEventListener("pointerdown", onOutside, true);
    } else {
      close();
    }
  });
}
const worktreeEl = document.getElementById("worktreeTag");
const worktreePanelEl = document.getElementById("worktreePanel") as HTMLDivElement | null;
interface WorktreeCommit {
  hash: string;
  subject: string;
  age: string;
  conflict?: boolean;
  conflictReason?: string;
}
interface WorktreeChange {
  status: string;
  path: string;
  label: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}
interface WorktreeMeta {
  root: string;
  id: string;
  name: string;
  defaultLabel: string;
  label: string;
  fullLabel: string;
  branch: string;
  targetBranch: string;
  pendingBase: string;
  branches: string[];
  isMain: boolean;
  isLinked: boolean;
  hasTargetUpdates: boolean;
  pendingCommits: WorktreeCommit[];
  incomingCommits: WorktreeCommit[];
  commits: WorktreeCommit[];
  changes: WorktreeChange[];
}
interface WorktreeFilePayload {
  path: string;
  content: string;
  baseContent: string;
  kind: string;
  mime: string;
  editable: boolean;
  language: string;
}
let worktreeMeta: Partial<WorktreeMeta> = {};
let worktreePanelOpen = false;
let worktreeChangesOpen = false;
let worktreeGroupChangesByPackage = readWorktreeGroupChangesPreference();
let worktreeMergePreviewIndex: number | null = null;
let worktreeIncomingMergePreviewIndex: number | null = null;
let worktreeMergeBusy = false;
let worktreeMergeMessage = "";
let fileExplorerPath = "";
let fileExplorerBase = "";
let fileExplorerContent = "";
let fileExplorerKind = "";
let fileExplorerMime = "";
let fileExplorerEditable = false;
let fileExplorerLanguage = "";
let fileExplorerSelection: [number, number] | null = null;
let fileExplorerRenderTimer: number | undefined;
let fileExplorerModelDispose: (() => void) | null = null;

function setWorktreeMeta(meta: Partial<WorktreeMeta>) {
  if (!worktreeEl) return;
  if (meta.incomingCommits && worktreeIncomingMergePreviewIndex !== null && worktreeIncomingMergePreviewIndex >= meta.incomingCommits.length) {
    worktreeIncomingMergePreviewIndex = null;
  }
  worktreeMeta = {
    ...worktreeMeta,
    ...meta,
    pendingCommits: meta.pendingCommits ?? worktreeMeta.pendingCommits ?? [],
    incomingCommits: meta.incomingCommits ?? worktreeMeta.incomingCommits ?? [],
    commits: meta.commits ?? worktreeMeta.commits ?? [],
    changes: meta.changes ?? worktreeMeta.changes ?? [],
    branches: meta.branches ?? worktreeMeta.branches ?? [],
  };
  const label = meta.label ?? "";
  const fullLabel = meta.fullLabel ?? label;
  worktreeEl.textContent = label;
  worktreeEl.title = fullLabel;
  worktreeEl.dataset.fullLabel = fullLabel;
  worktreeEl.dataset.name = meta.name ?? "";
  worktreeEl.dataset.root = meta.root ?? "";
  worktreeEl.dataset.branch = meta.branch ?? "";
  worktreeEl.dataset.targetBranch = meta.targetBranch ?? "";
  worktreeEl.classList.toggle("dirty", (meta.changes?.length ?? 0) > 0);
  worktreeEl.hidden = label === "";
  renderWorktreePanel();
}

function maybePromptForWorktreeName(meta: Partial<WorktreeMeta>) {
  if (!worktreeEl || !meta.root || !meta.isLinked || meta.name || meta.isMain) return;
  const key = `gorilator.worktreeTag.prompted:${meta.root}`;
  try {
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, "1");
  } catch {
    return;
  }
  window.setTimeout(() => {
    if (!worktreeEl.dataset.name) void editWorktreeName();
  }, 700);
}

async function saveWorktreeName(name: string): Promise<WorktreeMeta> {
  const res = await fetch("/__worktree", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as WorktreeMeta;
}

async function saveWorktreeTargetBranch(targetBranch: string): Promise<WorktreeMeta> {
  const res = await fetch("/__worktree", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetBranch }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as WorktreeMeta;
}

async function editWorktreeName() {
  if (!worktreeEl) return;
  const current = worktreeEl.dataset.name ?? "";
  const next = window.prompt("Name this worktree", current);
  if (next === null) return;
  try {
    setWorktreeMeta(await saveWorktreeName(next));
  } catch (err) {
    console.warn("Could not save worktree name", err);
    window.alert("Could not save worktree name.");
  }
}

async function loadWorktreeMeta() {
  const res = await fetch("/__worktree");
  if (!res.ok) return undefined;
  const meta = (await res.json()) as WorktreeMeta;
  setWorktreeMeta(meta);
  return meta;
}

async function mergeWorktreeIntoTarget(commit: string): Promise<WorktreeMeta> {
  const res = await fetch("/__worktree/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commit }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as WorktreeMeta;
}

async function mergeTargetIntoWorktree(commit?: string): Promise<WorktreeMeta> {
  const res = await fetch(
    "/__worktree/target-merge",
    commit
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commit }),
        }
      : { method: "POST" },
  );
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as WorktreeMeta;
}

async function loadWorktreeFile(path: string): Promise<WorktreeFilePayload> {
  const res = await fetch(`/__worktree/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as WorktreeFilePayload;
}

async function saveWorktreeFile(path: string, content: string): Promise<WorktreeFilePayload> {
  const res = await fetch("/__worktree/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as WorktreeFilePayload;
}

function createWorktreeNode<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function copyTextWithTextarea(text: string): boolean {
  const textarea = createWorktreeNode("textarea") as HTMLTextAreaElement;
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

async function copyTextToClipboard(text: string) {
  if (copyTextWithTextarea(text)) return;
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
  else throw new Error("copy command failed");
}

function renderWorktreePanelPreservingScroll() {
  const panel = worktreePanelEl;
  if (!panel) {
    renderWorktreePanel();
    return;
  }
  const scrollTop = panel.scrollTop;
  const scrollLeft = panel.scrollLeft;
  renderWorktreePanel();
  panel.scrollTop = scrollTop;
  panel.scrollLeft = scrollLeft;
  window.requestAnimationFrame(() => {
    panel.scrollTop = scrollTop;
    panel.scrollLeft = scrollLeft;
  });
}

function readWorktreeGroupChangesPreference(): boolean {
  try {
    return window.localStorage.getItem("gorilator.worktreeLog.groupChangesByPackage") !== "0";
  } catch {
    return true;
  }
}

function saveWorktreeGroupChangesPreference(enabled: boolean) {
  try {
    window.localStorage.setItem("gorilator.worktreeLog.groupChangesByPackage", enabled ? "1" : "0");
  } catch {
    // Storage can be unavailable in private contexts; the in-memory toggle still works.
  }
}

function worktreePackageCategory(path: string): string {
  const parts = path.split("/");
  if (parts[0] === "packages" && parts[1]) return parts[1];
  if (parts[0] === "apps" && parts[1]) return parts[1];
  return parts[0] || "root";
}

function packageSortRank(name: string): number {
  const order = ["server", "client", "cli", "shared"];
  const index = order.indexOf(name);
  return index === -1 ? order.length : index;
}

function groupedWorktreeChanges(changes: WorktreeChange[]): Array<{ category: string; changes: WorktreeChange[] }> {
  const groups = new Map<string, WorktreeChange[]>();
  for (const change of changes) {
    const category = worktreePackageCategory(change.path);
    const group = groups.get(category);
    if (group) group.push(change);
    else groups.set(category, [change]);
  }
  return Array.from(groups.entries())
    .map(([category, groupedChanges]) => ({ category, changes: groupedChanges }))
    .sort((a, b) => {
      const rank = packageSortRank(a.category) - packageSortRank(b.category);
      return rank || a.category.localeCompare(b.category);
    });
}

function renderWorktreeChangeRow(change: WorktreeChange): HTMLDivElement {
  const row = createWorktreeNode("div", "wtChangeRow file");
  row.append(
    createWorktreeNode("span", "wtChangeStatus", change.status.trim() || "M"),
    createWorktreeNode("span", "wtChangePath", change.path),
    createWorktreeNode("span", "wtChangeLabel", change.label),
  );
  row.title = "Open file explorer";
  row.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openFileExplorer(change.path);
  });
  return row;
}

function setWorktreeMergePreview(index: number | null) {
  worktreeMergePreviewIndex = index;
  const rows = worktreePanelEl?.querySelectorAll<HTMLElement>(".wtPendingRow") ?? [];
  for (const row of rows) {
    const rowIndex = Number(row.dataset.mergeIndex);
    const selected = index !== null && Number.isFinite(rowIndex) && rowIndex === index;
    row.classList.toggle("mergePreview", selected);
    row.classList.toggle("mergeHover", selected);
  }
}

function setWorktreeIncomingMergePreview(index: number | null) {
  worktreeIncomingMergePreviewIndex = index;
  const rows = worktreePanelEl?.querySelectorAll<HTMLElement>(".wtIncomingRow") ?? [];
  for (const row of rows) {
    const rowIndex = Number(row.dataset.mergeIndex);
    const selected = !row.classList.contains("conflict") && index !== null && Number.isFinite(rowIndex) && rowIndex <= index;
    const hovered = selected && rowIndex === index;
    row.classList.toggle("mergePreview", selected);
    row.classList.toggle("mergeHover", hovered);
  }
}

type DiffRow = { type: "same" | "add" | "remove"; text: string; oldLine: number | null; newLine: number | null };

function splitEditorLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function buildFileDiffRows(base: string, next: string): DiffRow[] {
  const oldLines = splitEditorLines(base);
  const newLines = splitEditorLines(next);
  if (oldLines.length * newLines.length > 120000) {
    return [
      { type: "remove", text: `${oldLines.length} base lines`, oldLine: 1, newLine: null },
      { type: "add", text: `${newLines.length} edited lines`, oldLine: null, newLine: 1 },
    ];
  }
  const dp = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      rows.push({ type: "same", text: oldLines[i], oldLine: oldNo++, newLine: newNo++ });
      i++;
      j++;
    } else if (j < newLines.length && (i === oldLines.length || dp[i][j + 1] >= dp[i + 1][j])) {
      rows.push({ type: "add", text: newLines[j], oldLine: null, newLine: newNo++ });
      j++;
    } else if (i < oldLines.length) {
      rows.push({ type: "remove", text: oldLines[i], oldLine: oldNo++, newLine: null });
      i++;
    }
  }
  return rows;
}

function isJsonExplorerFile(): boolean {
  return fileExplorerKind === "json" || fileExplorerPath.toLowerCase().endsWith(".json");
}

function fileExplorerRawUrl(path = fileExplorerPath): string {
  return `/__worktree/raw?path=${encodeURIComponent(path)}&v=${Date.now()}`;
}

function formatFileExplorerText(text: string): string {
  return JSON.stringify(JSON.parse(text), null, 2);
}

function disposeFileExplorerModel() {
  if (!fileExplorerModelDispose) return;
  fileExplorerModelDispose();
  fileExplorerModelDispose = null;
}

function closeFileExplorer() {
  const modal = document.getElementById("jsonEditorModal");
  if (modal) modal.hidden = true;
  disposeFileExplorerModel();
  fileExplorerPath = "";
  fileExplorerBase = "";
  fileExplorerContent = "";
  fileExplorerKind = "";
  fileExplorerMime = "";
  fileExplorerEditable = false;
  fileExplorerLanguage = "";
  fileExplorerSelection = null;
  window.clearTimeout(fileExplorerRenderTimer);
}

function mountFileExplorerModel(canvas: HTMLCanvasElement, url: string) {
  disposeFileExplorerModel();
  const previewEngine = new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: true }, true);
  const previewScene = new Scene(previewEngine);
  previewScene.clearColor = new Color4(0.025, 0.022, 0.03, 1);

  const camera = new ArcRotateCamera("fileExplorerModelCamera", Math.PI * 0.25, Math.PI * 0.34, 5, Vector3.Zero(), previewScene);
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 0.4;
  camera.upperRadiusLimit = 80;
  camera.wheelPrecision = 45;
  camera.panningSensibility = 85;
  const light = new HemisphericLight("fileExplorerModelLight", new Vector3(0.3, 1, 0.4), previewScene);
  light.intensity = 0.92;

  const handleResize = () => previewEngine.resize();
  window.addEventListener("resize", handleResize);
  previewEngine.runRenderLoop(() => previewScene.render());

  const extension = fileExplorerPath.toLowerCase().endsWith(".gltf") ? ".gltf" : ".glb";
  void SceneLoader.ImportMeshAsync("", "", url, previewScene, undefined, extension)
    .then((result) => {
      let min = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
      let max = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
      for (const mesh of result.meshes) {
        if (mesh.getTotalVertices() <= 0) continue;
        const bounds = mesh.getHierarchyBoundingVectors(true);
        min = Vector3.Minimize(min, bounds.min);
        max = Vector3.Maximize(max, bounds.max);
      }
      if (!Number.isFinite(min.x) || !Number.isFinite(max.x)) return;
      const center = min.add(max).scale(0.5);
      const radius = Math.max(max.subtract(min).length() * 0.62, 1.8);
      camera.setTarget(center);
      camera.radius = radius;
      camera.lowerRadiusLimit = Math.max(radius * 0.18, 0.25);
      camera.upperRadiusLimit = Math.max(radius * 4, 6);
    })
    .catch((err) => {
      const error = createWorktreeNode("div", "filePreviewError", err instanceof Error ? err.message : "Could not load model");
      canvas.parentElement?.append(error);
    });

  fileExplorerModelDispose = () => {
    window.removeEventListener("resize", handleResize);
    previewEngine.stopRenderLoop();
    previewScene.dispose();
    previewEngine.dispose();
  };
}

function renderFileExplorer(status = "") {
  const modal = document.getElementById("jsonEditorModal") as HTMLDivElement | null;
  if (!modal || !fileExplorerPath) return;
  disposeFileExplorerModel();
  modal.replaceChildren();
  modal.hidden = false;

  let valid = true;
  let validation = status;
  let statusClass = "ok";
  if (status && /could not|failed|invalid|error/i.test(status)) statusClass = "bad";
  if (fileExplorerEditable && isJsonExplorerFile()) {
    try {
      JSON.parse(fileExplorerContent);
      if (!validation) validation = "Valid JSON";
    } catch (err) {
      valid = false;
      statusClass = "bad";
      validation = err instanceof Error ? err.message : "Invalid JSON";
    }
  } else if (fileExplorerEditable) {
    validation ||= `Editable ${fileExplorerLanguage.toUpperCase() || "TEXT"}`;
  } else if (fileExplorerKind === "unsupported") {
    valid = false;
    statusClass = "bad";
    validation ||= "Preview unavailable";
  } else {
    validation ||= `${fileExplorerKind.toUpperCase()} preview`;
  }

  const shell = createWorktreeNode("div", "fileExplorerShell");
  const head = createWorktreeNode("div", "fileExplorerHead");
  const titleWrap = createWorktreeNode("div", "fileExplorerTitleWrap");
  titleWrap.append(
    createWorktreeNode("div", "fileExplorerTitle", fileExplorerPath),
    createWorktreeNode("div", `fileExplorerStatus ${statusClass}`, validation),
  );

  const actions = createWorktreeNode("div", "fileExplorerActions");
  if (fileExplorerEditable && isJsonExplorerFile()) {
    const formatBtn = createWorktreeNode("button", "fileExplorerBtn", "Format");
    formatBtn.type = "button";
    formatBtn.disabled = !valid;
    formatBtn.addEventListener("click", () => {
      try {
        fileExplorerContent = formatFileExplorerText(fileExplorerContent);
        renderFileExplorer("Formatted");
      } catch {
        renderFileExplorer();
      }
    });
    actions.append(formatBtn);
  }
  if (fileExplorerEditable) {
    const saveBtn = createWorktreeNode("button", "fileExplorerBtn primary", "Save");
    saveBtn.type = "button";
    saveBtn.disabled = !valid;
    saveBtn.addEventListener("click", () => {
      saveBtn.disabled = true;
      void saveWorktreeFile(fileExplorerPath, fileExplorerContent)
        .then((file) => {
          fileExplorerContent = file.content;
          fileExplorerBase = file.baseContent;
          fileExplorerKind = file.kind;
          fileExplorerMime = file.mime;
          fileExplorerEditable = file.editable;
          fileExplorerLanguage = file.language;
          void loadWorktreeMeta();
          renderFileExplorer("Saved");
        })
        .catch((err) => renderFileExplorer(err instanceof Error ? err.message : "Could not save file"));
    });
    actions.append(saveBtn);
  }
  const rawLink = createWorktreeNode("a", "fileExplorerBtn", "Open raw") as HTMLAnchorElement;
  rawLink.href = fileExplorerRawUrl();
  rawLink.target = "_blank";
  rawLink.rel = "noreferrer";
  const closeBtn = createWorktreeNode("button", "fileExplorerBtn", "Close");
  closeBtn.type = "button";
  closeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeFileExplorer();
  });
  actions.append(rawLink, closeBtn);
  head.append(titleWrap, actions);

  const body = createWorktreeNode("div", fileExplorerEditable ? "fileExplorerBody editable" : "fileExplorerBody preview");
  let textarea: HTMLTextAreaElement | null = null;
  let modelCanvas: HTMLCanvasElement | null = null;

  if (fileExplorerEditable) {
    const editorPane = createWorktreeNode("div", "fileExplorerPane");
    editorPane.append(createWorktreeNode("div", "fileExplorerPaneTitle", `${fileExplorerLanguage || "text"} editor`));
    textarea = createWorktreeNode("textarea", "fileExplorerText") as HTMLTextAreaElement;
    textarea.spellcheck = false;
    textarea.value = fileExplorerContent;
    textarea.addEventListener("input", () => {
      fileExplorerContent = textarea?.value ?? "";
      fileExplorerSelection = [
        textarea?.selectionStart ?? fileExplorerContent.length,
        textarea?.selectionEnd ?? fileExplorerContent.length,
      ];
      window.clearTimeout(fileExplorerRenderTimer);
      fileExplorerRenderTimer = window.setTimeout(() => renderFileExplorer(), 120);
    });
    editorPane.append(textarea);

    const diffPane = createWorktreeNode("div", "fileExplorerPane");
    diffPane.append(createWorktreeNode("div", "fileExplorerPaneTitle", "Diff"));
    const diff = createWorktreeNode("div", "fileDiff");
    const rows = buildFileDiffRows(fileExplorerBase, fileExplorerContent);
    for (const row of rows.slice(0, 1200)) {
      const line = createWorktreeNode("div", `fileDiffLine ${row.type}`);
      line.append(
        createWorktreeNode("span", "fileDiffNum", row.oldLine === null ? "" : String(row.oldLine)),
        createWorktreeNode("span", "fileDiffNum", row.newLine === null ? "" : String(row.newLine)),
        createWorktreeNode("span", "fileDiffMark", row.type === "add" ? "+" : row.type === "remove" ? "-" : " "),
        createWorktreeNode("span", "fileDiffText", row.text || " "),
      );
      diff.append(line);
    }
    if (rows.length > 1200) diff.append(createWorktreeNode("div", "fileDiffMore", `${rows.length - 1200} more diff lines hidden`));
    diffPane.append(diff);
    body.append(editorPane, diffPane);
  } else {
    const previewPane = createWorktreeNode("div", "filePreviewPane");
    previewPane.append(createWorktreeNode("div", "fileExplorerPaneTitle", `${fileExplorerKind || "file"} preview`));
    const rawUrl = fileExplorerRawUrl();
    if (fileExplorerKind === "image") {
      const image = createWorktreeNode("img", "filePreviewImage") as HTMLImageElement;
      image.src = rawUrl;
      image.alt = fileExplorerPath;
      previewPane.append(image);
    } else if (fileExplorerKind === "audio") {
      const audioPreview = createWorktreeNode("audio", "filePreviewPlayer") as HTMLAudioElement;
      audioPreview.controls = true;
      audioPreview.src = rawUrl;
      previewPane.append(audioPreview);
    } else if (fileExplorerKind === "video") {
      const videoPreview = createWorktreeNode("video", "filePreviewVideo") as HTMLVideoElement;
      videoPreview.controls = true;
      videoPreview.src = rawUrl;
      previewPane.append(videoPreview);
    } else if (fileExplorerKind === "model") {
      const canvasWrap = createWorktreeNode("div", "filePreviewModelWrap");
      modelCanvas = createWorktreeNode("canvas", "filePreviewModelCanvas") as HTMLCanvasElement;
      canvasWrap.append(modelCanvas);
      previewPane.append(canvasWrap);
    } else {
      previewPane.append(createWorktreeNode("div", "filePreviewUnsupported", `No preview is available for ${fileExplorerMime || "this file"}.`));
    }
    body.append(previewPane);
  }

  shell.append(head, body);
  modal.append(shell);
  if (modelCanvas) mountFileExplorerModel(modelCanvas, fileExplorerRawUrl());
  if (textarea) {
    textarea.focus();
    if (fileExplorerSelection) {
      const [start, end] = fileExplorerSelection;
      textarea.setSelectionRange(Math.min(start, textarea.value.length), Math.min(end, textarea.value.length));
    }
  }
}

function openFileExplorer(path: string) {
  void loadWorktreeFile(path)
    .then((file) => {
      fileExplorerPath = file.path;
      fileExplorerBase = file.baseContent;
      fileExplorerContent = file.content;
      fileExplorerKind = file.kind;
      fileExplorerMime = file.mime;
      fileExplorerEditable = file.editable;
      fileExplorerLanguage = file.language;
      fileExplorerSelection = null;
      renderFileExplorer();
    })
    .catch((err) => window.alert(err instanceof Error ? err.message : "Could not open file"));
}

function renderWorktreePanel() {
  if (!worktreePanelEl || !worktreeEl) return;
  const label = worktreeMeta.label ?? "";
  const pendingCommits = worktreeMeta.pendingCommits ?? [];
  const incomingCommits = worktreeMeta.incomingCommits ?? [];
  const commits = worktreeMeta.commits ?? [];
  const changes = worktreeMeta.changes ?? [];
  const branch = worktreeMeta.branch || "detached";
  const targetBranch = worktreeMeta.targetBranch || "main";
  const pendingBase = worktreeMeta.pendingBase || targetBranch;
  const branches = Array.from(new Set(["main", targetBranch, ...(worktreeMeta.branches ?? [])])).filter(Boolean);
  const canMergeTarget = Boolean(worktreeMeta.branch) && branch !== targetBranch;
  const hasTargetUpdates = worktreeMeta.hasTargetUpdates ?? incomingCommits.length > 0;
  const canUpdateFromTarget = canMergeTarget && hasTargetUpdates;
  if (!label) {
    worktreePanelEl.hidden = true;
    return;
  }

  worktreePanelEl.replaceChildren();
  const head = createWorktreeNode("div", "wtPanelHead");
  const titleWrap = createWorktreeNode("div", "wtPanelTitleWrap");
  titleWrap.append(
    createWorktreeNode("div", "wtPanelTitle", label),
    createWorktreeNode("div", "wtPanelMeta", worktreeMeta.fullLabel ?? label),
  );
  const editBtn = createWorktreeNode("button", "wtPanelEdit", "Name");
  editBtn.type = "button";
  editBtn.hidden = Boolean(worktreeMeta.isMain);
  editBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    void editWorktreeName();
  });
  head.append(titleWrap, editBtn);

  const branchBar = createWorktreeNode("div", "wtBranchBar");
  const currentBranchEl = createWorktreeNode("div", "wtBranchCurrent");
  const canCopyBranch = Boolean(worktreeMeta.root);
  const currentBranchLine = createWorktreeNode("div", "wtBranchValueLine");
  currentBranchLine.append(createWorktreeNode("span", "wtBranchValue", branch));
  const copyBranchBtn = createWorktreeNode("button", "wtBranchCopy") as HTMLButtonElement;
  copyBranchBtn.type = "button";
  copyBranchBtn.disabled = !canCopyBranch;
  copyBranchBtn.title = canCopyBranch ? `Copy ${branch}` : "Loading branch";
  copyBranchBtn.setAttribute("aria-label", canCopyBranch ? `Copy branch ${branch}` : "Loading branch");
  copyBranchBtn.append(createWorktreeNode("span", "wtBranchCopyIcon"));
  copyBranchBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!canCopyBranch) return;
    void copyTextToClipboard(branch)
      .then(() => {
        copyBranchBtn.classList.add("copied");
        copyBranchBtn.title = "Copied";
        window.setTimeout(() => {
          copyBranchBtn.classList.remove("copied");
          copyBranchBtn.title = `Copy ${branch}`;
        }, 900);
      })
      .catch((err) => {
        console.warn("Could not copy branch", err);
        copyBranchBtn.title = "Could not copy";
      });
  });
  currentBranchLine.append(copyBranchBtn);
  currentBranchEl.append(createWorktreeNode("span", "wtBranchLabel", "Current"), currentBranchLine);
  const targetWrap = createWorktreeNode("label", "wtTargetWrap");
  const targetLabel = createWorktreeNode("span", "wtBranchLabel", "Target");
  const targetSelect = createWorktreeNode("select", "wtTargetSelect");
  targetSelect.setAttribute("aria-label", "Target branch");
  targetSelect.disabled = worktreeMergeBusy;
  for (const optionBranch of branches) {
    const option = createWorktreeNode("option", "", optionBranch);
    option.value = optionBranch;
    option.selected = optionBranch === targetBranch;
    targetSelect.append(option);
  }
  targetSelect.addEventListener("change", (ev) => {
    ev.stopPropagation();
    const next = targetSelect.value || "main";
    targetSelect.disabled = true;
    void saveWorktreeTargetBranch(next)
      .then((meta) => setWorktreeMeta(meta))
      .catch((err) => {
        console.warn("Could not save target branch", err);
        window.alert("Could not save target branch.");
      })
      .finally(() => {
        targetSelect.disabled = false;
      });
  });
  targetWrap.append(targetLabel, targetSelect);
  const bringTargetWrap = createWorktreeNode("div", "wtBringTargetWrap");
  const bringTargetLabel = createWorktreeNode("span", "wtBranchLabel", "Update");
  const bringTargetBtn = createWorktreeNode(
    "button",
    "wtBringTargetBtn",
    worktreeMergeBusy ? "Working" : canUpdateFromTarget ? "Update" : "Up to date",
  );
  bringTargetBtn.type = "button";
  bringTargetBtn.disabled = worktreeMergeBusy || !canUpdateFromTarget;
  bringTargetBtn.title = canUpdateFromTarget
    ? `Merge ${targetBranch} into ${branch}`
    : branch === targetBranch
      ? "Current branch already matches target"
      : !hasTargetUpdates
        ? `${branch} already includes ${targetBranch}`
        : "No current branch to update";
  bringTargetBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!canUpdateFromTarget) return;
    worktreeMergeBusy = true;
    worktreeMergeMessage = `Merging ${targetBranch} into ${branch}...`;
    renderWorktreePanel();
    void mergeTargetIntoWorktree()
      .then((meta) => {
        worktreeMergeMessage = `Merged ${meta.targetBranch || targetBranch} into ${meta.branch || branch}`;
        setWorktreeMeta(meta);
      })
      .catch((err) => {
        worktreeMergeMessage = err instanceof Error ? err.message : "Target merge failed";
        renderWorktreePanel();
      })
      .finally(() => {
        worktreeMergeBusy = false;
        renderWorktreePanel();
      });
  });
  bringTargetWrap.append(bringTargetLabel, bringTargetBtn);
  branchBar.append(currentBranchEl, targetWrap, bringTargetWrap);

  const pendingSection = createWorktreeNode("div", "wtPending");
  const pendingHead = createWorktreeNode("div", "wtSectionLine");
  pendingHead.append(
    createWorktreeNode("span", "wtSectionTitle", `Pending into ${targetBranch}`),
    createWorktreeNode(
      "span",
      pendingCommits.length ? "wtSectionPill dirty" : "wtSectionPill",
      `${pendingCommits.length} commit${pendingCommits.length === 1 ? "" : "s"}`,
    ),
  );
  pendingSection.append(
    pendingHead,
    createWorktreeNode("div", "wtSectionMeta", pendingBase ? `Compared with ${pendingBase}` : "Target branch not found locally"),
  );
  if (!pendingCommits.length) {
    pendingSection.append(createWorktreeNode("div", "wtEmpty", `No pending commits into ${targetBranch}.`));
  } else {
    pendingCommits.forEach((commit, index) => {
      const hasConflict = Boolean(commit.conflict);
      const previewed = worktreeMergePreviewIndex === index;
      const hovered = worktreeMergePreviewIndex === index;
      const rowClass = `${previewed ? "wtCommitRow wtPendingRow mergePreview" : "wtCommitRow wtPendingRow"}${hasConflict ? " conflict" : ""}`;
      const row = createWorktreeNode("div", rowClass);
      row.dataset.mergeIndex = String(index);
      row.classList.toggle("mergeHover", hovered);
      row.append(
        createWorktreeNode("span", "wtCommitHash", commit.hash),
        createWorktreeNode("span", "wtCommitSubject", commit.subject),
        createWorktreeNode("span", "wtCommitAge", commit.age),
      );

      const mergeBtn = createWorktreeNode(
        "button",
        hasConflict ? "wtMergeBtn conflict" : hovered ? "wtMergeBtn preview" : "wtMergeBtn",
        hasConflict ? "Conflict" : worktreeMergeBusy ? "Merging" : "Merge into target",
      );
      mergeBtn.type = "button";
      mergeBtn.title = hasConflict ? (commit.conflictReason ?? `Cannot merge ${commit.hash} into ${targetBranch}`) : `Merge ${commit.hash} into ${targetBranch}`;
      mergeBtn.disabled = worktreeMergeBusy || hasConflict;
      mergeBtn.addEventListener("mouseenter", () => {
        if (hasConflict) return;
        setWorktreeMergePreview(index);
      });
      mergeBtn.addEventListener("mouseleave", () => {
        if (hasConflict) return;
        setWorktreeMergePreview(null);
      });
      mergeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (hasConflict) return;
        worktreeMergeBusy = true;
        worktreeMergeMessage = `Merging ${commit.hash} into ${targetBranch}...`;
        renderWorktreePanel();
        void mergeWorktreeIntoTarget(commit.hash)
          .then((meta) => {
            worktreeMergePreviewIndex = null;
            worktreeMergeMessage = `Merged ${commit.hash} into ${meta.targetBranch || targetBranch}`;
            setWorktreeMeta(meta);
          })
          .catch((err) => {
            worktreeMergeMessage = err instanceof Error ? err.message : "Merge failed";
            renderWorktreePanel();
          })
          .finally(() => {
            worktreeMergeBusy = false;
            renderWorktreePanel();
          });
      });
      const action = createWorktreeNode("span", "wtMergeAction wtPendingAction");
      action.append(mergeBtn);
      row.append(action);
      pendingSection.append(row);
    });
  }
  if (worktreeMergeMessage) pendingSection.append(createWorktreeNode("div", "wtMergeStatus", worktreeMergeMessage));

  const changesHead = createWorktreeNode("div", "wtChangesHead");
  const changesBtn = createWorktreeNode("button", "wtChangesToggle");
  changesBtn.type = "button";
  changesBtn.setAttribute("aria-expanded", String(worktreeChangesOpen));
  const changeCount = changes.length;
  changesBtn.append(
    createWorktreeNode("span", "wtSectionTitle", "Current changes"),
    createWorktreeNode(
      "span",
      changeCount ? "wtSectionPill dirty" : "wtSectionPill",
      changeCount === 0 ? "clean" : `${changeCount} file${changeCount === 1 ? "" : "s"}`,
    ),
  );
  changesBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    worktreeChangesOpen = !worktreeChangesOpen;
    renderWorktreePanel();
  });
  const packageToggle = createWorktreeNode("label", "wtPackageToggle");
  packageToggle.title = "Group current changes by package";
  const packageToggleInput = createWorktreeNode("input") as HTMLInputElement;
  packageToggleInput.type = "checkbox";
  packageToggleInput.checked = worktreeGroupChangesByPackage;
  packageToggleInput.addEventListener("click", (ev) => ev.stopPropagation());
  packageToggleInput.addEventListener("change", (ev) => {
    ev.stopPropagation();
    worktreeGroupChangesByPackage = packageToggleInput.checked;
    saveWorktreeGroupChangesPreference(worktreeGroupChangesByPackage);
    renderWorktreePanelPreservingScroll();
  });
  packageToggle.append(
    packageToggleInput,
    createWorktreeNode("span", "wtPackageToggleTrack"),
    createWorktreeNode("span", "wtPackageToggleText", "Packages"),
  );
  changesHead.append(changesBtn, packageToggle);

  const changesList = createWorktreeNode("div", "wtChangesList");
  changesList.hidden = !worktreeChangesOpen;
  if (!changes.length) {
    changesList.append(createWorktreeNode("div", "wtEmpty", "No unstaged or uncommitted files."));
  } else if (worktreeGroupChangesByPackage) {
    for (const group of groupedWorktreeChanges(changes)) {
      const groupEl = createWorktreeNode("div", "wtChangeGroup");
      const groupHead = createWorktreeNode("div", "wtChangeGroupHead");
      groupHead.append(
        createWorktreeNode("span", "wtChangeGroupName", group.category),
        createWorktreeNode("span", "wtChangeGroupCount", `${group.changes.length} file${group.changes.length === 1 ? "" : "s"}`),
      );
      groupEl.append(groupHead);
      for (const change of group.changes) groupEl.append(renderWorktreeChangeRow(change));
      changesList.append(groupEl);
    }
  } else {
    for (const change of changes) {
      changesList.append(renderWorktreeChangeRow(change));
    }
  }

  const incomingSection = createWorktreeNode("div", "wtIncoming");
  const incomingHead = createWorktreeNode("div", "wtSectionLine");
  incomingHead.append(
    createWorktreeNode("span", "wtSectionTitle", `From ${targetBranch}`),
    createWorktreeNode(
      "span",
      incomingCommits.length ? "wtSectionPill dirty" : "wtSectionPill",
      `${incomingCommits.length} commit${incomingCommits.length === 1 ? "" : "s"}`,
    ),
  );
  incomingSection.append(
    incomingHead,
    createWorktreeNode("div", "wtSectionMeta", `Merge target history into ${branch}; newer rows include older commits.`),
  );
  if (!incomingCommits.length) {
    incomingSection.append(createWorktreeNode("div", "wtEmpty", `No target commits to merge from ${targetBranch}.`));
  } else {
    incomingCommits.forEach((commit, index) => {
      const hasConflict = Boolean(commit.conflict);
      const previewed = !hasConflict && worktreeIncomingMergePreviewIndex !== null && index <= worktreeIncomingMergePreviewIndex;
      const hovered = !hasConflict && worktreeIncomingMergePreviewIndex === index;
      const rowClass = `${previewed ? "wtCommitRow wtIncomingRow mergePreview" : "wtCommitRow wtIncomingRow"}${hovered ? " mergeHover" : ""}${hasConflict ? " conflict" : ""}`;
      const row = createWorktreeNode("div", rowClass);
      row.dataset.mergeIndex = String(index);
      row.append(
        createWorktreeNode("span", "wtCommitHash", commit.hash),
        createWorktreeNode("span", "wtCommitSubject", commit.subject),
        createWorktreeNode("span", "wtCommitAge", commit.age),
      );

      const mergeBtn = createWorktreeNode(
        "button",
        hasConflict ? "wtMergeBtn conflict" : "wtMergeBtn",
        hasConflict ? "Conflict" : worktreeMergeBusy ? "Merging" : "Merge In",
      );
      mergeBtn.type = "button";
      mergeBtn.title = hasConflict
        ? (commit.conflictReason ?? `Cannot merge ${targetBranch} history through ${commit.hash}`)
        : `Merge ${targetBranch} history through ${commit.hash} into ${branch}`;
      mergeBtn.disabled = worktreeMergeBusy || hasConflict;
      mergeBtn.addEventListener("mouseenter", () => {
        if (hasConflict) return;
        setWorktreeIncomingMergePreview(index);
      });
      mergeBtn.addEventListener("mouseleave", () => {
        if (hasConflict) return;
        setWorktreeIncomingMergePreview(null);
      });
      mergeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (hasConflict) return;
        worktreeMergeBusy = true;
        worktreeMergeMessage = `Merging ${targetBranch} through ${commit.hash} into ${branch}...`;
        renderWorktreePanel();
        void mergeTargetIntoWorktree(commit.hash)
          .then((meta) => {
            worktreeIncomingMergePreviewIndex = null;
            worktreeMergeMessage = `Merged ${meta.targetBranch || targetBranch} through ${commit.hash} into ${meta.branch || branch}`;
            setWorktreeMeta(meta);
          })
          .catch((err) => {
            worktreeMergeMessage = err instanceof Error ? err.message : "Target merge failed";
            renderWorktreePanel();
          })
          .finally(() => {
            worktreeMergeBusy = false;
            renderWorktreePanel();
          });
      });
      const mergeLabel = createWorktreeNode("span", "wtMergeLabel", "Merge In");
      const action = createWorktreeNode("span", "wtMergeAction wtIncomingAction");
      action.append(mergeBtn);
      if (!hasConflict) action.append(mergeLabel);
      row.append(action);
      incomingSection.append(row);
    });
  }

  const commitsSection = createWorktreeNode("div", "wtCommits");
  commitsSection.append(createWorktreeNode("div", "wtSectionTitle", "Recent commits"));
  if (!commits.length) {
    commitsSection.append(createWorktreeNode("div", "wtEmpty", "No commits found."));
  } else {
    for (const commit of commits) {
      const row = createWorktreeNode("div", "wtCommitRow");
      row.append(
        createWorktreeNode("span", "wtCommitHash", commit.hash),
        createWorktreeNode("span", "wtCommitSubject", commit.subject),
        createWorktreeNode("span", "wtCommitAge", commit.age),
      );
      commitsSection.append(row);
    }
  }

  worktreePanelEl.append(head, branchBar, pendingSection, changesHead, changesList, incomingSection, commitsSection);
  worktreePanelEl.hidden = !worktreePanelOpen;
}

function setWorktreePanelOpen(open: boolean) {
  if (!worktreePanelEl || !worktreeEl) return;
  worktreePanelOpen = open;
  worktreePanelEl.hidden = !open;
  worktreeEl.classList.toggle("open", open);
  worktreeEl.setAttribute("aria-expanded", String(open));
  if (open) void loadWorktreeMeta().catch((err) => console.warn("Could not refresh worktree log", err));
}

if (worktreeEl) {
  setWorktreeMeta({ label: __WORKTREE_LABEL__, fullLabel: __WORKTREE_FULL_LABEL__ });
  if (import.meta.env.DEV && __WORKTREE_LABEL__) {
    worktreeEl.tabIndex = 0;
    worktreeEl.setAttribute("role", "button");
    worktreeEl.setAttribute("aria-label", "Open worktree log");
    worktreeEl.setAttribute("aria-expanded", "false");
    worktreeEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setWorktreePanelOpen(!worktreePanelOpen);
    });
    worktreeEl.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      setWorktreePanelOpen(!worktreePanelOpen);
    });
    worktreePanelEl?.addEventListener("click", (ev) => ev.stopPropagation());
    document.addEventListener("click", () => setWorktreePanelOpen(false));
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        setWorktreePanelOpen(false);
        closeFileExplorer();
      }
    });
    document.getElementById("jsonEditorModal")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (ev.target === ev.currentTarget) closeFileExplorer();
    });
    void loadWorktreeMeta()
      .then((meta: WorktreeMeta | undefined) => {
        if (!meta) return;
        maybePromptForWorktreeName(meta);
      })
      .catch((err) => console.warn("Could not load worktree name", err));
  }
}

// DEV-only: `?mocknostr=gen|nsec1…|<hex>` installs a fake NIP-07 signer so the
// Nostr login flow can be tested without a browser extension. Installed up-front
// (before the splash) so window.nostr is ready when "Login with Nostr" is clicked.
// Suppressed when VITE_NO_MOCK_NOSTR=1 (a CLI-managed "dev mode" server sets this)
// so a reachable dev server can't be used to impersonate any npub.
if (import.meta.env.DEV && import.meta.env.VITE_NO_MOCK_NOSTR !== "1") {
  const mockArg = new URLSearchParams(location.search).get("mocknostr");
  if (mockArg) void import("./net/nostrMock").then((m) => m.installMockSigner(mockArg));
}

const engine = new Engine(canvas, true, { stencil: true }, true);
const shadowMode = loadStoredShadowMode();
const { scene, camera, ground, shadows } = createScene(engine, { shadowMode });

const factory = new CharacterFactory(scene);
const hud = new HUD(scene);
const globe = new HealthGlobe();
const xpBar = new XpBar();
const staminaBar = new StaminaBar();
const hungerBar = new HungerBar();
const characterSheet = new CharacterSheet();
const playerBadge = new PlayerBadge();
const topBar = new TopBar(); // top HUD (La Crypta HP + wave); hidden on the splash via CSS
const game = new Game(camera, factory, hud, shadows);
const debugStats = new DebugStats(engine, scene);
// Sound system: spatial SFX + music. Unlocks itself on the first user gesture
// (the splash "ENTER" click), so it's safe to build up-front.
const audio = new AudioManager();
game.setAudio(audio);
void audio.ready.then(() => audio.startSplashMusic());
const net = new NetworkClient();

/** Logout: leave the room, drop the signer + saved session, return to splash. */
async function doLogout(): Promise<void> {
  try {
    await net.leave();
  } catch {
    /* ignore */
  }
  clearActiveSession();
  clearSession();
  if (typeof window !== "undefined") delete window.nostr;
  location.reload(); // cold reset to the splash (storage cleared → no auto-restore)
}

// The bottom-left player badge opens a profile / logout menu.
new PlayerMenu({
  getIdentity: () => getActiveIdentity(),
  getPlayer: () => {
    const me = game.localId ? net.room?.state.players.get(game.localId) : undefined;
    return me
      ? {
          name: me.name,
          level: me.level,
          picture: me.picture,
          nostrVerified: me.nostrVerified,
          attack: me.attack,
          armor: me.armor,
          hp: me.hp,
          maxHp: me.maxHp,
        }
      : null;
  },
  onLogout: () => void doLogout(),
  landingBase: import.meta.env.VITE_LANDING_URL as string | undefined,
});

// Performance tracking: Babylon probes feed the tracker each frame (FPS, draw
// calls, meshes, triangles always; CPU+GPU frame time + heap while the overlay or
// a benchmark is active). Toggle the on-screen HUD with F3 or `?perf`; drive it
// from the console via window.__perf (see docs/performance.md).
const perf = new PerfTracker();
let currentClientFps = engine.getFps();
const perfProbes = attachBabylonProbes(engine, scene, perf, { fps: () => currentClientFps });
const perfMode = new URLSearchParams(location.search).has("perf");
let perfFpsLimit = perfMode ? loadStoredPerfFpsLimit() : 0;
const perfOverlay = new PerfOverlay(
  perf,
  perfProbes,
  net.httpBase(),
  perfMode
    ? {
        get: () => perfFpsLimit,
        set: (limit) => {
          perfFpsLimit = normalizePerfFpsLimit(limit);
          storePerfFpsLimit(perfFpsLimit);
        },
      }
    : undefined,
);
// "What's heavy" drill-down + FPS-dip culprit capture: render load + elements come
// from the live scene, entities from the game's per-category counts; reasons are the
// perf spans (incl. the scene.render sub-phases). The render profile pairs those
// with the probe's engine sub-phase timings for a deep, saveable snapshot.
perf.setBreakdownProvider(() => buildResourceBreakdown(scene, game.debugStats(), perf.latest()));
perf.setRenderProfileProvider(() => buildRenderProfile(scene, perfProbes.renderPhases(), perf.latest(), perf.meta));
(window as Window & { __perf?: unknown }).__perf = perf;
if (perfMode) perfOverlay.toggle();

// Client plugins: item models, per-frame systems, dev panels. Discovered via
// /plugins/manifest.json (pluginBundler); quietly a no-op when none exist.
void loadClientPlugins();

const inventory = new InventoryUI(
  (from, to) => net.sendInventoryMove(from, to),
  (slot) => net.sendUseItem(slot),
);
const hotkeyBar = new HotkeyBar((slot) => net.sendUseItem(slot));
const minimap = new Minimap(net); // top-left radar + hold TAB / Map button for the big map
const chat = new ChatLog((text) => net.sendChat(text)); // Enter to chat (right-side log)
// Dev tools (in-game editor + component labels) compile in for a local Vite dev
// server (import.meta.env.DEV) OR a deployed dev-tools build (VITE_DEV_TOOLS=1 —
// the `gorilator` dev server). On the deployed build the editor is admin-gated below.
const DEV_TOOLS = import.meta.env.DEV || import.meta.env.VITE_DEV_TOOLS === "1";
const developerLabels = DEV_TOOLS ? new DeveloperLabels(scene) : null;
// Esc menu: resume, hotkeys, sound/graphics settings, login-with-Nostr, kill-yourself, exit.
new GameMenu({
  net,
  audio,
  engine,
  shadows,
  isNostrVerified: () => !!(game.localId && net.room?.state.players.get(game.localId)?.nostrVerified),
  isAdmin: () => !!(game.localId && net.room?.state.players.get(game.localId)?.isAdmin),
  developerLabels: developerLabels
    ? {
        isEnabled: () => developerLabels.isEnabled(),
        setEnabled: (on) => developerLabels.setEnabled(on),
      }
    : undefined,
});

// Imported-prop registry (loads props.json into the world). In dev builds it also
// backs Dev Mode, the in-game world editor (toggle with the button or ` backtick).
const propManager = new PropManager(scene, shadows);
game.setStructureProps(propManager); // destroyed structures hide their prop visual
// Placed custom characters (imported Meshy zips) — loads npcs.json + renders them.
const characterManager = new CharacterManager(scene, shadows);
minimap.setProps(propManager); // so the map can icon imported trees/rocks/concrete props
const devMode = DEV_TOOLS ? new DevMode(scene, ground, net, propManager) : null;
devMode?.setCharacterManager(characterManager); // placed characters are selectable/draggable in Dev Mode
devMode?.setGame(game); // library explorer can select + camera-focus world entities
devMode?.setInventoryUI(inventory); // Dev Mode: click an inventory slot to set its item/qty
// Deployed dev server (a VITE_DEV_TOOLS build, NOT a local Vite dev): the page is
// public, so gate the editor behind the local player's admin status and sign its
// `/__*` saves with NIP-98 (the server also enforces admin on every write).
if (devMode && !import.meta.env.DEV && import.meta.env.VITE_DEV_TOOLS === "1") {
  devMode.setAdminGate(() => !!(game.localId && net.room?.state.players.get(game.localId)?.isAdmin));
  installDevEditorAuth();
}
if (developerLabels)
  devMode?.setDeveloperLabels({
    isEnabled: () => developerLabels.isEnabled(),
    setEnabled: (on) => developerLabels.setEnabled(on),
  });

setupClickToMove({
  scene,
  ground,
  net,
  pickTargetAt: game.pickTargetAt,
  onMoveTo: (point) => {
    // No click marker while paused (ghost free-roam in Dev Mode).
    if ((net.room?.state.timeScale ?? 1) > 0) hud.showClickMarker(point);
  },
  onSelectTarget: (id) => game.flashSelectTarget(id), // flash the picked target white
  // a banana/stone is thrown by holding its assigned hotkey (Q/W/E/R)
  throwItemForKey: (key) => hotkeyBar.throwItemForKey(key),
  dev: devMode
    ? {
        isActive: devMode.isActive,
        pointerDown: devMode.pointerDown,
        pointerMove: devMode.pointerMove,
        pointerUp: devMode.pointerUp,
      }
    : undefined,
});

// Hold SPACE to sprint (server drains stamina + applies the speed boost).
setupSprint(net);

// A pool of loading quips (funny, gaming, faintly self-aware). Six distinct ones
// are picked at random on each load and spread across the boot bar, so the splash
// reads differently every time.
const SPLASH_BOOT_QUIPS = [
  "loading the cold open",
  "polishing the boss entrance",
  "arming buttons, no mercy",
  "teaching the gorilla to flex",
  "negotiating with the physics engine",
  "bribing the frame rate",
  "convincing bananas they're weapons",
  "warming the bass for impact",
  "untangling the spaghetti code (don't look)",
  "asking the gorilla to look dangerous",
  "feeding the goblins their morning rage",
  "calibrating maximum primate",
  "rendering muscles nobody asked for",
  "summoning the arena from the void",
  "double-checking gravity still works",
  "stretching before the grind",
  "loading 400 polygons of pure attitude",
  "pretending the lag is intentional",
  "sharpening the difficulty curve",
  "waking the boss, gently",
  "counting the bananas, twice",
  "training goblins to miss dramatically",
  "applying war paint to the UI",
  "tuning the roar to eleven",
  "hiding the loading bar's anxiety",
  "rolling for initiative",
  "buffering pure chaos",
  "compiling questionable life choices",
  "opening the arena gates",
  "last second vanity check",
] as const;

// The six boot-bar thresholds the picked quips snap to as it fills 0 → 100.
const SPLASH_BOOT_STOPS = [0, 16, 34, 52, 70, 88] as const;

/** Shuffle the quip pool and pin the first six to the boot-bar stops, so each
 *  load shows six different lines from the pool. */
function pickSplashBootTasks(): { pct: number; label: string }[] {
  const pool = [...SPLASH_BOOT_QUIPS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return SPLASH_BOOT_STOPS.map((pct, i) => ({ pct, label: pool[i] }));
}

const SPLASH_BOOT_TASKS = pickSplashBootTasks();

let splashBootShown = 4;
let splashBootTarget = 4;
let splashBootOverrideLabel = "";
let splashBootLabelTimer: number | undefined;

function splashBootLabelFor(pct: number): string {
  let label = SPLASH_BOOT_TASKS[0].label;
  for (const task of SPLASH_BOOT_TASKS) {
    if (pct >= task.pct) label = task.label;
  }
  return label;
}

function renderSplashBoot(): void {
  const bar = document.getElementById("splashBootBar") as HTMLElement | null;
  const label = document.getElementById("splashBootLabel") as HTMLElement | null;
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, splashBootShown))}%`;
  if (label) label.textContent = splashBootOverrideLabel || splashBootLabelFor(splashBootShown);
}

const splashBootTicker = window.setInterval(() => {
  if (!document.body.classList.contains("splashBooting")) {
    window.clearInterval(splashBootTicker);
    return;
  }
  if (splashBootShown < splashBootTarget) {
    splashBootShown += Math.max(0.35, (splashBootTarget - splashBootShown) * 0.14);
  } else if (splashBootTarget < 90) {
    splashBootTarget += 0.28;
    splashBootShown += 0.08;
  }
  renderSplashBoot();
}, 60);

function setSplashBootProgress(pct: number, label?: string): void {
  const next = Math.max(0, Math.min(100, pct));
  const previousTarget = splashBootTarget;
  if (next >= splashBootTarget) {
    splashBootTarget = next;
  }
  if (label && next >= previousTarget) {
    splashBootOverrideLabel = label;
    if (splashBootLabelTimer !== undefined) window.clearTimeout(splashBootLabelTimer);
    splashBootLabelTimer = window.setTimeout(() => {
      splashBootOverrideLabel = "";
      renderSplashBoot();
    }, next >= 100 ? 1800 : 920);
  }
  renderSplashBoot();
}

async function revealSplashWhenReady(splash: SplashScreen, audioReady: Promise<void>): Promise<void> {
  const minimumDisplay = new Promise((resolve) => window.setTimeout(resolve, 760));
  try {
    const heroReady = splash.ready.then(() => {
      setSplashBootProgress(72);
    });
    const soundReady = audioReady.then(() => {
      setSplashBootProgress(84);
    });
    await Promise.all([heroReady, soundReady]);
  } finally {
    splashBootOverrideLabel = "";
    setSplashBootProgress(94);
    await minimumDisplay;
    setSplashBootProgress(100);
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    document.body.classList.remove("splashBooting");
    window.setTimeout(() => document.getElementById("splashBoot")?.remove(), 320);
  }
}

// The intro / character-select splash. It renders its own hero scene on this
// same engine while the player picks a name; the main render loop below draws it
// instead of the game world until `splash.active` flips during the launch.
const splash = new SplashScreen(engine, { onBootProgress: setSplashBootProgress });
setSplashBootProgress(24);
const splashReady = revealSplashWhenReady(splash, audio.ready);
// Surface a daemon "update available" banner on the splash (best-effort, silent
// when offline / up to date). Fed by the server's /api/update auto-check.
void splash.showUpdateBanner(net.httpBase());
// Flag any out-of-date packages in the footer version popup with an ⬆.
void fetch(`${net.httpBase()}/api/update`, { cache: "no-store" })
  .then((r) => (r.ok ? (r.json() as Promise<{ latest?: { packages?: Record<string, string> } | null }>) : null))
  .then((s) => {
    if (s?.latest?.packages) renderVersionPanel(s.latest.packages);
  })
  .catch(() => {
    /* offline / not configured — leave the list unflagged */
  });

// homeMaxHp is kept so the home bar can still read "fallen" after the house is
// removed from state on collapse.
let homeMaxHp = 0;
let lastAnnouncedWave: number | null = null;
let activeMusicWave: number | null = null;

interface AssetTask {
  label: string;
  weight: number;
  promise: Promise<void>;
}

function buildAssetPreload(): { done: Promise<void>; setJoining(): void } {
  let completed = 0;
  let settled = 0;
  let mode: "background" | "joining" | "ready" = "background";
  const tasks: AssetTask[] = [
    {
      label: "gorilla rigs",
      weight: 5,
      promise: factory.preload(),
    },
    {
      label: "throwables",
      weight: 1,
      promise: preloadBanana(scene),
    },
    {
      label: "berserker flask",
      weight: 1,
      promise: preloadBerserkerPotion(scene),
    },
    {
      label: "audio banks",
      weight: 1,
      promise: audio.ready,
    },
    {
      label: "mouse cursors",
      weight: 1,
      promise: preloadMouseCursors(),
    },
    {
      label: "La Crypta house",
      weight: 4,
      promise: loadHouse(scene, shadows).then((house) => {
        game.setHouseModel(house);
      }),
    },
    {
      label: "world props",
      weight: 2,
      promise: propManager.loadAll().then(() => {
        const tower = propManager.all().find((p) => p.def.name === TOWER_PROP_NAME);
        if (tower) game.setHealingTowerPosition(tower.def.x, tower.def.z);
      }),
    },
    {
      label: "placed characters",
      weight: 2,
      promise: characterManager.loadAll({ placements: false }),
    },
  ];
  const total = tasks.reduce((sum, task) => sum + task.weight, 0);
  const setProgress = (status: string, nextMode: "background" | "joining" | "ready" = mode) => {
    const pct = Math.min(100, Math.round((completed / total) * 100));
    splash.setAssetProgress(pct, status, nextMode);
  };

  setProgress("warming up assets");

  const done = Promise.all(
    tasks.map((task) =>
      task.promise
        .catch((err) => {
          console.warn(`[assets] ${task.label} preload failed`, err);
        })
        .finally(() => {
          completed += task.weight;
          settled += 1;
          const done = settled === tasks.length;
          setProgress(done ? "assets ready" : `loaded ${task.label}`, done ? "ready" : "background");
        }),
    ),
  ).then(() => undefined);

  return {
    done,
    setJoining() {
      mode = "joining";
      setProgress("finishing world load");
    },
  };
}

/** Wait briefly for a signer (`window.nostr`) to appear, returning its pubkey. */
async function pollForPubkey(timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (window.nostr) {
      try {
        return await window.nostr.getPublicKey();
      } catch {
        return null;
      }
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

/** A logged-in splash state from a cached session, without re-fetching relays. */
function identityFromCache(s: { pubkey: string; npub: string; meta: NostrIdentity["meta"] }): NostrIdentity {
  return { pubkey: s.pubkey, npub: s.npub, meta: s.meta };
}

/**
 * On startup, restore a persisted Nostr session: re-establish/verify the signer
 * (NIP-07 extension present & same pubkey, or bunker reachable) and show the
 * logged-in state on the splash. The player still clicks JOIN (which signs a
 * fresh auth). Never throws — a failed restore just leaves an anonymous splash.
 */
async function restoreSession(): Promise<void> {
  const saved = loadSession();
  if (!saved) return;
  // `?mocknostr=` (dev) owns window.nostr and must not be overwritten by a bunker.
  const mockActive =
    import.meta.env.DEV &&
    import.meta.env.VITE_NO_MOCK_NOSTR !== "1" &&
    !!new URLSearchParams(location.search).get("mocknostr");

  try {
    if (saved.method === "nip07") {
      const pk = await pollForPubkey(2000);
      if (pk && pk === saved.pubkey) {
        const id = await establishNostrIdentity(); // one fresh identity for both
        splash.restoreNostr(id);
        setActiveSession(id, null);
      } else if (pk && pk !== saved.pubkey) {
        clearSession(); // extension switched accounts → don't restore the wrong key
      } else {
        // No signer right now — show the cached identity; JOIN will surface the
        // "reconnect your signer" error if it's still missing then.
        splash.restoreNostr(identityFromCache(saved));
        setActiveSession(identityFromCache(saved), null);
      }
      return;
    }

    if (saved.method === "bunker") {
      if (mockActive) return; // mock wins this session
      const client = restoreBunkerClient(saved.bunker, (url) => window.open(url, "_blank", "noopener"));
      client.start();
      installBunkerSigner(client); // JOIN signs through it (lazily reconnects if asleep)
      const alive = await client.ping().then(() => true).catch(() => false);
      if (alive) {
        const id = await establishNostrIdentity().catch(() => null);
        // Re-verify the signer still controls the stored npub (mirrors nip07).
        if (id && id.pubkey !== saved.pubkey) {
          client.close();
          if (typeof window !== "undefined") delete window.nostr;
          clearSession();
          return;
        }
        const identity = id ?? identityFromCache(saved);
        splash.restoreNostr(identity);
        setActiveSession(identity, client);
      } else {
        // Signer asleep — show cached identity; JOIN re-signs through the shim.
        splash.restoreNostr(identityFromCache(saved));
        setActiveSession(identityFromCache(saved), client);
      }
    }
  } catch (err) {
    console.warn("[nostr] session restore failed", err);
  }
}

async function start() {
  // First reveal the splash only after its own scene/hero assets are ready. After
  // that, the full game asset preload can run in the background while the player
  // chooses how to enter.
  await splashReady;
  // Restore a saved Nostr login (re-verify the signer) — non-blocking so the
  // splash shows immediately and flips to logged-in once verified.
  void restoreSession();
  const preload = buildAssetPreload();

  const handlers: NetHandlers = {
    onConnected: (id) => {
      game.setLocalId(id);
      statusEl.textContent = "connected";
      lastAnnouncedWave = null;
    },
    onPlayerAdd: (p, id) => {
      game.addPlayer(p, id);
    },
    onPlayerChange: (p, id) => game.changePlayer(p, id),
    onPlayerRemove: (id) => game.removePlayer(id),
    onEnemyAdd: (e, id) => game.addEnemy(e, id),
    onEnemyChange: (e, id) => game.changeEnemy(e, id),
    onEnemyRemove: (id) => game.removeEnemy(id),
    onPotionAdd: (p, id) => game.addPotion(p, id),
    onPotionChange: (p, id) => game.changePotion(p, id),
    onPotionRemove: (id) => game.removePotion(id),
    onTreeAdd: (t, id) => game.addTree(t, id),
    onTreeChange: (t, id) => game.changeTree(t, id),
    onTreeRemove: (id) => game.removeTree(id),
    onLogAdd: (l, id) => game.addLog(l, id),
    onLogChange: (l, id) => game.changeLog(l, id),
    onLogRemove: (id) => game.removeLog(id),
    onRockAdd: (r, id) => game.addRock(r, id),
    onRockChange: (r, id) => game.changeRock(r, id),
    onRockRemove: (id) => game.removeRock(id),
    onStoneAdd: (s, id) => game.addStone(s, id),
    onStoneChange: (s, id) => game.changeStone(s, id),
    onStoneRemove: (id) => game.removeStone(id),
    onBananaAdd: (b, id) => game.addBanana(b, id),
    onBananaChange: (b, id) => game.changeBanana(b, id),
    onBananaRemove: (id) => game.removeBanana(id),
    onItemAdd: (item, id) => game.addItem(item, id),
    onItemChange: (item, id) => game.changeItem(item, id),
    onItemRemove: (id) => game.removeItem(id),
    onHouseAdd: (h, id) => game.addHouse(h, id),
    onHouseChange: (h, id) => game.changeHouse(h, id),
    onHouseRemove: (id) => game.removeHouse(id),
    onStructureAdd: (s, id) => game.addStructure(s, id),
    onStructureChange: (s, id) => game.changeStructure(s, id),
    onStructureRemove: (id) => game.removeStructure(id),
    onBananaThrow: (ev) => game.showBananaThrow(ev),
    onDamage: (ev) => game.onDamage(ev),
    onKill: (ev) => game.onKill(ev),
    onHeal: (ev) => game.onHeal(ev),
    onFood: (ev) => {
      if (ev.playerId === game.localId) hungerBar.animateFood(ev.fromHunger, ev.toHunger, ev.durationMs);
    },
    onXp: (ev) => game.onXp(ev),
    onChat: (ev) => {
      game.showChatBubble(ev.playerId, ev.text); // bubble over the speaker
      // Nostr senders carry an avatar + verified flag on their synced Player —
      // pass them so the log shows their picture and gives the line more room.
      const sender = net.room?.state.players.get(ev.playerId);
      chat.add(ev.name, ev.text, ev.playerId === game.localId, {
        picture: sender?.picture ?? "",
        nostrVerified: sender?.nostrVerified ?? false,
      }); // log on the right
    },
    onInventory: (slots) => {
      inventory.setInventory(slots);
      hotkeyBar.setInventory(slots);
    },
    // Feature Lab: pin the scenario's tweak knobs in the Dev Mode gameplay panel.
    onScenario: (info) => devMode?.setScenario(info),
    onWipe: (ev) => topBar.flashDefeat(ev.wave, ev.persist), // La Crypta fell → defeat flash (state sync carries the reset)
    onError: (message) => {
      statusEl.textContent = message;
      console.warn("[net]", message);
    },
  };

  const params = new URLSearchParams(location.search);
  // Feature Lab (#66): ?scenario=<name> auto-joins single-player. The join
  // option also selects the scenario for a freshly created room on open dev
  // servers (`pnpm scenario` pins it via env anyway). `autojoin` lets labs name
  // the guest player in their printed ready URL.
  const scenarioName = params.get("scenario")?.trim() || "";
  const autoJoinName = params.get("autojoin")?.trim().slice(0, 24) || "";
  let autoJoinUsed = false;

  while (true) {
    // Wait for the player to commit: a name, and optionally a verified Nostr id.
    // Progress persistence is fully server-side now: the server signs/owns each
    // Nostr player's save (kind 30078) and recovers it on join — the client only
    // proves the pubkey. A duplicate login is kicked by the server (the takeover
    // close code, handled in NetworkClient.onLeave).
    const creds =
      (scenarioName || autoJoinName) && !autoJoinUsed
        ? { name: autoJoinName || "dev" }
        : await splash.awaitCredentials();
    autoJoinUsed = true;

    // Make sure every known asset task has settled before we reveal the world. A
    // preload failure isn't fatal — the model builders fall back gracefully — so
    // this waits for completion without stranding the player on a missing GLB.
    preload.setJoining();
    await preload.done;
    splash.setAssetProgress(100, "joining realm", "joining");

    // Nostr players sign a FRESH kind-22242 auth here (the challenge must be
    // <300s old), so a restored/persisted identity never reuses a stale one. The
    // signer (extension / mock / bunker) may prompt or be offline → handle apart.
    let nostrPayload: NostrAuthPayload | undefined;
    if (creds.nostr) {
      try {
        splash.setAssetProgress(100, "signing in…", "joining");
        const auth = await signNostrAuth();
        nostrPayload = { auth, profile: creds.nostr.profile };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        splash.showJoinError(`couldn't sign in with your Nostr signer — ${msg}`);
        continue;
      }
    }

    try {
      await net.connect(handlers, {
        name: creds.name,
        // Only the signed auth + profile go to the server; it owns the save.
        nostr: nostrPayload,
        scenario: scenarioName || undefined,
      });

      // Runtime lab switch: joining an EXISTING room doesn't re-stage — if the
      // server is running a different scenario than the URL asks for, request a
      // room recycle (dev_scenario). Our onLeave reloads into the fresh lab.
      if (scenarioName) {
        void fetch(`${net.httpBase()}/api/status`)
          .then((res) => res.json() as Promise<{ activeScenario?: string | null }>)
          .then((status) => {
            if ((status.activeScenario ?? null) !== scenarioName) net.switchScenario(scenarioName);
          })
          .catch(() => {}); // status probe is best-effort — a cold room staged us already
      }
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : String(err);
      const visibleMsg = /nostr/i.test(msg)
        ? msg
        : `offline — ${msg}`;
      statusEl.textContent = visibleMsg;
      splash.showJoinError(visibleMsg);
      continue;
    }

    splash.setAssetProgress(100, "realm ready", "ready");

    // Cinematic hand-off: the splash hero snaps into its attack animation, the camera
    // punches in, and a white flash masks the cut into the live game world.
    await splash.playLaunch(undefined, () => audio.splashRoar());
    audio.stopSplashMusic();
    splash.dispose();

    // The world is live: show the music/mute widget and start the ambient bed.
    new AudioControls(audio);
    audio.startMusic();
    return;
  }
}

start().catch((err) => {
  console.error(err);
  statusEl.textContent = "offline — is the server running? (pnpm dev)";
});

// Dev-only hook: poke at the running game from the browser console (window.__rpg).
if (import.meta.env.DEV) {
  // Entity creator: the stepped Library wizard (details → model → stats) that
  // authors a character / structure / item without placing it on the map.
  const entityCreator = new EntityCreator({
    onAdded: (type) => devMode?.revealLibraryTab(type),
  });

  (window as Window & { __rpg?: unknown }).__rpg = { engine, scene, net, game, audio, playerBadge, propManager, characterManager, entityCreator, devMode, debugStats };

  // Standalone model inspector (button bottom-right, or press C).
  new CharacterDebugWindow();

  // Model importer: upload a .glb, place/resize/rotate/name it, concrete or not,
  // and persist it to the codebase (button bottom-right, or press M).
  const propImporter = new PropImporter(scene, shadows, () => {
    const me = game.localId ? net.room?.state.players.get(game.localId) : undefined;
    return me ? { x: me.x, z: me.z } : null;
  });
  const animationTester = new AnimationTester({
    getClips: () => game.animationTestClips(),
    playClip: (state) => game.playAnimationTestClip(state),
    clearClip: () => game.clearAnimationTestClip(),
  });
  devMode?.setAnimationTester(animationTester);
  devMode?.setEntityCreator(entityCreator); // Library "＋ Add" opens the wizard
  devMode?.onVisibilityChange((on) => {
    document.body.classList.toggle("devMode", on);
    entityCreator.setVisible(on);
    propImporter.setVisible(on);
    animationTester.setVisible(on);
    game.setDamageFxSuppressed(on); // no red flash / shake / low-HP vignette while editing
  });
}

let lastClientFrameAt = performance.now();
engine.runRenderLoop(() => {
  const now = performance.now();
  if (perfFpsLimit > 0 && now - lastClientFrameAt < 1000 / perfFpsLimit) return;

  const frameStartedAt = debugStats.beginFrame();
  const elapsedMs = frameStartedAt - lastClientFrameAt;
  const dt = Math.min(elapsedMs / 1000, 0.1);
  lastClientFrameAt = frameStartedAt;
  currentClientFps = elapsedMs > 0 ? 1000 / elapsedMs : engine.getFps();

  // While the intro is up, draw the hero scene instead of the game world. The
  // launch flips `active` (under the white flash) to hand off to the game.
  if (splash.active) {
    debugStats.setScene(splash.scene);
    splash.update(dt);
    const renderStartedAt = performance.now();
    splash.scene.render();
    const frameEndedAt = performance.now();
    perf.setFrameMetrics({
      fps: currentClientFps,
      frameMs: frameEndedAt - frameStartedAt,
      gpuMs: null,
      drawCalls: 0,
      activeMeshes: splash.scene.getActiveMeshes().length,
      triangles: Math.round(splash.scene.getActiveIndices() / 3),
    });
    perf.tick();
    debugStats.endFrame(frameStartedAt, renderStartedAt);
    return;
  }
  debugStats.setScene(scene);

  // Dev Mode time control: mirror the server's simulation speed so the world
  // looks paused/slowed/sped on the client too (frozen positions + animations).
  const timeScale = net.room?.state.timeScale ?? 1;
  const paused = timeScale === 0;
  scene.animationsEnabled = !paused; // freeze skeletal animations when paused
  game.setGhost(paused); // local player goes translucent + floats while paused
  perf.span("game.update", () => game.update(dt * timeScale)); // the world stays frozen at pause…
  if (paused) game.updateGhost(dt); // …but the ghost free-roams + camera follows at real dt
  perf.span("minimap", () => minimap.update()); // redraws only while TAB is held
  // Plugin frame systems — each in its own span (F3 shows plugin:<name>) and
  // try/caught so a plugin can't kill the render loop.
  for (const s of clientPluginHost.frameSystems) {
    perf.span(`plugin:${s.name}`, () => {
      try {
        s.fn(dt);
      } catch (err) {
        console.error(`[plugins] frame system "${s.name}" failed:`, err);
      }
    });
  }

  const hp = game.localHp();
  if (hp) globe.set(hp.hp, hp.maxHp);

  // XP bar + character sheet + identity badge read straight off the synced local player
  const me = game.localId ? net.room?.state.players.get(game.localId) : undefined;
  if (me) {
    xpBar.set(me.level, me.xp);
    staminaBar.set(me.stamina, me.maxStamina);
    hungerBar.set(me.hunger, me.maxHunger);
    playerBadge.set({
      name: me.name,
      level: me.level,
      picture: me.picture,
      nostrVerified: me.nostrVerified,
    });
    characterSheet.set({
      name: me.name,
      level: me.level,
      xp: me.xp,
      hp: me.hp,
      maxHp: me.maxHp,
      attack: me.attack,
      armor: me.armor,
      critChance: me.critChance,
      moveSpeed: me.moveSpeed,
      throwPower: me.throwPower,
    });
  }

  // Keep the audio listener on the player so spatial SFX pan + attenuate correctly.
  audio.updateListener(camera, me ? { x: me.x, z: me.z } : null);

  // TopBar: event realms show the home HP + wave state. Open sandbox realms
  // have no event objective, so show a stable realm status instead of a
  // permanent "fallen" siege bar.
  const st = net.room?.state;
  if (topBar && st) {
    const sandbox = !st.eventId && st.houses.size === 0 && homeMaxHp <= 0;
    topBar.setVisible(true);
    let home: { hp: number; maxHp: number; alive: boolean } | undefined;
    st.houses.forEach((h) => {
      if (!home) home = h;
    });
    if (home) {
      homeMaxHp = home.maxHp;
      topBar.setHouse(home.hp, home.maxHp, home.alive);
    } else if (sandbox && st.restartTimerMs <= 0) {
      homeMaxHp = 0;
      topBar.setSandbox();
    } else if (!st.wavesEnabled && st.restartTimerMs <= 0) {
      homeMaxHp = 0;
      topBar.setSandbox();
    } else if (homeMaxHp > 0) {
      topBar.setHouse(0, homeMaxHp, false);
    }
    const wave = st.waveNumber;
    topBar.setWave(wave, st.waveTimerMs);
    if (wave > 0 && st.waveActive && activeMusicWave !== wave) {
      audio.startWaveMusic();
      activeMusicWave = wave;
    } else if (activeMusicWave !== null && (!st.waveActive || wave < activeMusicWave)) {
      audio.startMusic(true); // restart the normal theme from the beginning
      activeMusicWave = null;
    }
    if (lastAnnouncedWave === null) {
      lastAnnouncedWave = wave;
    } else if (wave > lastAnnouncedWave) {
      topBar.flashWave(wave);
      lastAnnouncedWave = wave;
    } else if (wave < lastAnnouncedWave) {
      lastAnnouncedWave = wave;
    }
  }

  // Realm-over intermission (La Crypta fell): the whole-screen "next realm in N"
  // countdown takes priority over the per-player respawn overlay.
  const restartMs = net.room?.state.restartTimerMs ?? 0;
  if (restartMs > 0) {
    realmOverlay.style.display = "flex";
    realmCountdownEl.textContent = String(Math.ceil(restartMs / 1000));
    if (respawnOverlay.style.display !== "none") respawnOverlay.style.display = "none";
  } else {
    if (realmOverlay.style.display !== "none") realmOverlay.style.display = "none";
    const respawnIn = game.respawnCountdown();
    if (respawnIn === null) {
      if (respawnOverlay.style.display !== "none") respawnOverlay.style.display = "none";
    } else {
      respawnOverlay.style.display = "flex";
      respawnCountdownEl.textContent = `Respawning in ${Math.ceil(respawnIn)}`;
    }
  }

  debugStats.setGameStats(game.debugStats());
  const renderStartedAt = performance.now();
  perf.span("scene.render", () => scene.render());
  debugStats.endFrame(frameStartedAt, renderStartedAt);
});

window.addEventListener("resize", () => {
  engine.resize();
  applyOrthoSize(camera);
});

// HMR guard: main.ts builds singletons (engine + render loop, the Colyseus room,
// DOM UI, audio) that can't hot-swap. Without this, an edit that bubbles up to
// main.ts re-executes the module ON TOP of the live instance — stacked render
// loops, duplicate UI, ghost websockets (the "HMR stacks main.ts" gotcha).
// dispose() tears the old world down before Vite re-runs the entry / full-reloads.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    try {
      engine.stopRenderLoop();
      void net.room?.leave();
      engine.dispose();
    } catch {
      /* tearing down a half-built world is best-effort */
    }
  });
}
