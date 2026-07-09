/* Gorilator test-plan dashboard UI — framework-free ES module.
 * Polls /api/state every 2s; skips re-renders when the content hash is
 * unchanged or a dialog/drawer interaction is in flight. The drawer and the
 * note dialog live OUTSIDE #board, so board re-renders never disturb them. */

const COLUMNS = [
  { key: "planned", title: "Planned" },
  { key: "in_progress", title: "In progress" },
  { key: "ready", title: "Ready to test" },
  { key: "verified", title: "Verified" },
];
// rejected renders inside "in_progress" with a badge — the agent picks it up.
const COLUMN_OF = {
  planned: "planned",
  in_progress: "in_progress",
  rejected: "in_progress",
  ready: "ready",
  verified: "verified",
};
const KIND_ICON = { feature: "✨", bugfix: "🐛", optimization: "⚡", docs: "📖" };

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

let state = null;
let lastHash = "";
const hiddenLanes = new Set(JSON.parse(localStorage.getItem("dash.hiddenLanes") || "[]"));
let pendingOpen = null; // { dir, scenario, name } — waiting for a starting stack

// ---------- api ----------

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function toast(msg, ms = 3500) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

// ---------- lane hue (deterministic per worktree dir) ----------

function hueOf(dir) {
  let h = 0;
  for (let i = 0; i < dir.length; i++) h = (h * 31 + dir.charCodeAt(i)) >>> 0;
  return h % 360;
}
const tagStyle = (dir) => `background:hsl(${hueOf(dir)} 45% 72%)`;

// ---------- render ----------

function stackDotClass(wt) {
  if (wt.stack.starting && !wt.stack.up) return "dot starting";
  if (wt.stack.up && wt.stack.activeScenario) return "dot scenario";
  if (wt.stack.up) return "dot up";
  return "dot";
}

function renderLanes() {
  $("#lanes").innerHTML = state.worktrees
    .map((wt) => {
      const hidden = hiddenLanes.has(wt.dir);
      const stackBtn = wt.stack.up
        ? wt.stack.managed
          ? `<button data-action="stack-stop" data-dir="${esc(wt.dir)}">stop</button>`
          : ""
        : `<button data-action="stack-start" data-dir="${esc(wt.dir)}">start</button>`;
      const stackTitle = wt.stack.up
        ? `stack up — ${wt.stack.activeScenario ? `scenario ${wt.stack.activeScenario}` : "normal realm"} · ${wt.stack.clientUrl}`
        : "stack down";
      return `<div class="lane ${hidden ? "filtered-out" : ""}" data-action="lane-toggle" data-dir="${esc(wt.dir)}" title="${esc(stackTitle)} — click to filter">
        <span class="${stackDotClass(wt)}"></span>
        ${wt.portConflict ? '<span class="dirty" title="another worktree declares the SAME ports (launch.json) — stack status may be misattributed">⚠</span>' : ""}
        <span class="wtTag" style="${tagStyle(wt.dir)}">${esc(wt.name)}</span>
        <span class="branch">${esc(wt.branch ?? "?")}${wt.targetBranch ? ` → ${esc(wt.targetBranch)}` : ""}</span>
        ${wt.dirty ? '<span class="dirty" title="uncommitted changes">●</span>' : ""}
        ${wt.stack.up ? `<button data-action="open-game" data-dir="${esc(wt.dir)}">play</button>` : ""}
        ${stackBtn}
      </div>`;
    })
    .join("");
}

function testButton(wt, task) {
  const t = task.test;
  if (!t) return "";
  if (t.type === "scenario") {
    const label = wt.stack.up ? "▶ Test in game" : "▶ Start lab & test";
    return `<button class="test" data-action="test-scenario" data-dir="${esc(wt.dir)}" data-task="${esc(task.id)}" data-scenario="${esc(t.scenario ?? "")}">${label}</button>`;
  }
  if (t.type === "cli")
    return `<button class="test" data-action="test-cli" data-dir="${esc(wt.dir)}" data-task="${esc(task.id)}" title="${esc(t.command ?? "")}">▶ Run test</button>`;
  if (t.type === "doc")
    return `<button class="test" data-action="test-doc" data-dir="${esc(wt.dir)}" data-path="${esc(t.path ?? "")}">📖 Open</button>`;
  return "";
}

// The action buttons for a card / detail view, keyed on status so both render
// identically. verified → reopen or re-reject; ready → test + verify/reject;
// rejected → re-test (the agent owns the rework back to ready).
function cardActions(wt, task) {
  const d = `data-dir="${esc(wt.dir)}" data-task="${esc(task.id)}"`;
  if (task.status === "ready")
    return `${testButton(wt, task)}
      <button class="verify" data-action="verdict" ${d} data-result="verified">✓ Verify</button>
      <button class="reject" data-action="verdict" ${d} data-result="rejected">✗ Reject</button>`;
  if (task.status === "verified")
    return `<button class="reopen" data-action="reopen" ${d} title="send back to Ready to test">↩ Back to testing</button>
      <button class="reject" data-action="verdict" ${d} data-result="rejected" title="reject with a note — moves it to In progress for the agent">✗ Reject</button>`;
  if (task.status === "rejected") return testButton(wt, task);
  return "";
}

function card(wt, task) {
  const rejected = task.status === "rejected";
  const note =
    rejected && task.verdict?.note
      ? `<div class="rejNote"><b>✗ rejected</b> — ${esc(task.verdict.note)}</div>`
      : "";
  const steps =
    task.test?.type === "manual" && task.test.steps?.length
      ? `<ol class="steps">${task.test.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`
      : "";
  const run =
    wt.run && wt.run.taskId === task.id
      ? `<div class="runBadge">${
          wt.run.running
            ? `<span class="live">⏳ running…</span>`
            : wt.run.exitCode === 0
              ? `<span class="ok">✓ last run passed</span>`
              : `<span class="bad">✗ last run exited ${wt.run.exitCode}</span>`
        } <button data-action="open-run" data-run="${esc(wt.run.id)}" style="font-size:10px">log</button></div>`
      : "";
  const hint =
    task.test?.type === "scenario" && task.test.scenario
      ? `<div class="testHint">?scenario=${esc(task.test.scenario)}</div>`
      : task.test?.type === "cli"
        ? `<div class="testHint">${esc(task.test.command ?? "")}</div>`
        : "";
  return `<div class="card ${rejected ? "rejected" : ""}" data-action="task-open" data-dir="${esc(wt.dir)}" data-task="${esc(task.id)}" title="click for details — what changed, expected result, how to test">
    <div class="cardTop">
      <span class="wtTag" style="${tagStyle(wt.dir)}">${esc(wt.name)}</span>
      <span class="kind" title="${esc(task.kind)}">${KIND_ICON[task.kind] ?? "✨"}</span>
    </div>
    <h3>${esc(task.title)}</h3>
    ${task.details ? `<p class="details">${esc(task.details)}</p>` : ""}
    ${note}${steps}
    <div class="cardBtns">${cardActions(wt, task)}</div>
    ${run}${hint}
  </div>`;
}

// ---------- task detail dialog ----------

function howToTest(wt, task) {
  const t = task.test;
  if (!t) return "<p>no test block — ask the agent to add one</p>";
  const steps = t.steps?.length
    ? `<ol>${t.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`
    : "";
  if (t.type === "scenario")
    return `<p>Feature Lab scenario — the Test button boots this worktree's stack into it (or opens the link on a running one):</p>
      <p><code>${esc(wt.stack.clientUrl)}?scenario=${esc(t.scenario ?? "")}</code></p>${steps}`;
  if (t.type === "cli")
    return `<p>Allowlisted command — the Test button runs it here and streams the output:</p><p><code>${esc(t.command ?? "")}</code></p>${steps}`;
  if (t.type === "doc")
    return `<p>Opens straight from the worktree:</p><p><code>${esc(t.path ?? "")}</code></p>${steps}`;
  return steps || "<p>follow the steps on the card</p>";
}

function openTaskDialog(dir, taskId) {
  const wt = state?.worktrees.find((w) => w.dir === dir);
  const task = wt?.plan?.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const history = [...(task.verdictHistory ?? []), ...(task.verdict ? [task.verdict] : [])];
  const histHtml = history.length
    ? history
        .map(
          (v) =>
            `<div class="tdHist">${v.result === "verified" ? "✓" : "✗"} <b>${esc(v.result)}</b>${
              v.note ? ` — ${esc(v.note)}` : ""
            } <span class="when">${esc((v.at ?? "").replace("T", " ").slice(0, 16))}</span></div>`,
        )
        .join("")
    : "";
  $("#taskDialogTitle").textContent = task.title;
  $("#taskDialogBody").innerHTML = `
    <div class="tdMeta">
      <span class="wtTag" style="${tagStyle(wt.dir)}">${esc(wt.name)}</span>
      <span class="kind">${KIND_ICON[task.kind] ?? "✨"} ${esc(task.kind)}</span>
      <span class="tdStatus ${esc(task.status)}">${esc(task.status.replace("_", " "))}</span>
    </div>
    ${task.details ? `<div class="tdSection"><h4>What changed</h4><p>${esc(task.details)}</p></div>` : ""}
    ${task.expected ? `<div class="tdSection"><h4>Expected result</h4><p>${esc(task.expected)}</p></div>` : ""}
    <div class="tdSection"><h4>How to test</h4>${howToTest(wt, task)}</div>
    ${histHtml ? `<div class="tdSection"><h4>Verdict history</h4>${histHtml}</div>` : ""}
    <div class="cardBtns">${cardActions(wt, task)}</div>`;
  $("#taskDialog").showModal();
}

function renderBoard() {
  const board = $("#board");
  const visible = state.worktrees.filter((wt) => !hiddenLanes.has(wt.dir));
  const buckets = { planned: [], in_progress: [], ready: [], verified: [] };
  for (const wt of visible) {
    if (wt.planError) {
      buckets.planned.push(
        `<div class="card rejected"><div class="cardTop"><span class="wtTag" style="${tagStyle(wt.dir)}">${esc(wt.name)}</span></div><h3>⚠ test-plan.json unreadable</h3><p class="details">${esc(wt.planError)}</p></div>`,
      );
      continue;
    }
    for (const task of wt.plan?.tasks ?? []) {
      buckets[COLUMN_OF[task.status] ?? "planned"].push(card(wt, task));
    }
  }
  board.innerHTML = COLUMNS.map(
    ({ key, title }) => `<section class="column">
      <h2>${title} <span class="count">${buckets[key].length}</span></h2>
      ${buckets[key].join("") || `<div class="empty">${key === "planned" ? "no tasks yet — the agent authors .gorilator/test-plan.json" : "—"}</div>`}
    </section>`,
  ).join("");
}

// ---------- process dock ----------
// One chip per process the dashboard holds: managed/starting stacks and the
// latest run per worktree. Minimizing the drawer never touches the process —
// chips reopen its log (stack logs are file-backed, runs replay their ring).

function dockChips() {
  const chips = [];
  for (const wt of state?.worktrees ?? []) {
    if (wt.stack.managed || wt.stack.starting) {
      const active = !$("#drawer").hidden && drawer.kind === "stack" && drawer.id === wt.dir;
      const dot = wt.stack.up ? "dot up" : "dot live";
      chips.push(`<button class="chip ${active ? "active" : ""}" data-action="dock-stack" data-dir="${esc(wt.dir)}"
        title="dev stack — click to ${active ? "minimize" : "show"} its log">
        <span class="${dot}"></span><span class="wtTag" style="${tagStyle(wt.dir)}">${esc(wt.name)}</span>
        <span class="chipLabel">${wt.stack.activeScenario ? `⛰ ${esc(wt.stack.activeScenario)}` : "⛰ stack"}${wt.stack.up ? "" : " — starting…"}</span>
      </button>`);
    }
    if (wt.run) {
      const active = !$("#drawer").hidden && drawer.kind === "run" && drawer.id === wt.run.id;
      const dot = wt.run.running ? "dot live" : wt.run.exitCode === 0 ? "dot ok" : "dot bad";
      const status = wt.run.running ? "" : wt.run.exitCode === 0 ? " ✓" : ` ✗ ${wt.run.exitCode}`;
      chips.push(`<button class="chip ${active ? "active" : ""}" data-action="dock-run" data-run="${esc(wt.run.id)}" data-cmd="${esc(wt.run.command)}"
        title="${esc(wt.run.command)} — click to ${active ? "minimize" : "show"} its log">
        <span class="${dot}"></span><span class="wtTag" style="${tagStyle(wt.dir)}">${esc(wt.name)}</span>
        <span class="chipLabel">${esc(wt.run.command)}${status}</span>
      </button>`);
    }
  }
  return chips;
}

function renderDock() {
  const chips = dockChips();
  const dock = $("#dock");
  dock.hidden = chips.length === 0;
  dock.innerHTML = chips.length ? `<span id="dockLabel">processes</span>${chips.join("")}` : "";
}

function render() {
  renderLanes();
  renderBoard();
  renderDock();
}

// ---------- polling ----------

async function refresh() {
  try {
    const next = await api("/api/state");
    state = next;
    if (pendingOpen) tryPendingOpen();
    if (next.hash === lastHash) return;
    if ($("#noteDialog").open) return; // don't yank the DOM while the user types
    lastHash = next.hash;
    render();
  } catch (err) {
    $("#brandSub").textContent = `dashboard server unreachable — ${err.message}`;
  }
}

function tryPendingOpen() {
  const wt = state.worktrees.find((w) => w.dir === pendingOpen.dir);
  if (!wt) return;
  if (wt.stack.up) {
    const url = pendingOpen.scenario
      ? `${wt.stack.clientUrl}?scenario=${encodeURIComponent(pendingOpen.scenario)}`
      : wt.stack.clientUrl;
    const req = pendingOpen;
    pendingOpen = null;
    toast(`stack up — opening ${req.scenario ? `scenario ${req.scenario}` : "the game"}`);
    window.open(url, "_blank");
  } else if (Date.now() - pendingOpen.since > 120_000) {
    pendingOpen = null;
    toast("stack didn't come up in 2 minutes — check its log from the lane");
  }
}

// ---------- log drawer ----------

const drawer = { kind: null, id: null, from: 0, timer: 0, gen: 0 };

function openDrawer(kind, id, title) {
  drawer.gen++; // invalidate any in-flight poll for the previous focus
  drawer.kind = kind;
  drawer.id = id;
  drawer.from = 0;
  $("#drawerTitle").textContent = title;
  $("#drawerLog").textContent = "";
  $("#drawerKill").hidden = false;
  $("#drawer").hidden = false;
  clearInterval(drawer.timer);
  drawer.timer = setInterval(pollDrawer, 600);
  pollDrawer();
  renderDock(); // highlight the focused chip
}

function minimizeDrawer() {
  drawer.gen++;
  $("#drawer").hidden = true; // the process keeps running — its dock chip stays
  clearInterval(drawer.timer);
  renderDock();
}

async function pollDrawer() {
  if ($("#drawer").hidden) return clearInterval(drawer.timer);
  const gen = drawer.gen;
  try {
    const q =
      drawer.kind === "run"
        ? `id=${encodeURIComponent(drawer.id)}`
        : `dir=${encodeURIComponent(drawer.id)}`;
    const data = await api(`/api/${drawer.kind}/log?${q}&from=${drawer.from}`);
    // The user may have switched chips while this request was in flight —
    // its offset and lines belong to the previous focus; discard.
    if (gen !== drawer.gen) return;
    if (data.dropped && drawer.from > 0) $("#drawerLog").textContent += "…(older output dropped)\n";
    if (data.lines.length) {
      const el = $("#drawerLog");
      const pinned = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
      el.textContent += `${data.lines.join("\n")}\n`;
      if (pinned) el.scrollTop = el.scrollHeight;
    }
    drawer.from = data.next;
    if (drawer.kind === "run" && data.done) {
      $("#drawerKill").hidden = true;
      $("#drawerTitle").textContent = `${data.command} — exited ${data.exitCode}`;
    }
    if (drawer.kind === "stack") {
      // pid is null once the stack exits / is unmanaged — stop is meaningless then
      $("#drawerKill").hidden = data.pid == null;
    }
  } catch (err) {
    if (gen !== drawer.gen) return;
    if (String(err.message ?? err).includes("unknown run")) {
      // pruned by the server (it keeps the last 5 finished runs per worktree)
      clearInterval(drawer.timer);
      $("#drawerKill").hidden = true;
      const t = $("#drawerTitle");
      if (!t.textContent.includes("log gone")) t.textContent += " — log gone (pruned)";
    }
    /* otherwise transient — next tick retries */
  }
}

// ---------- actions ----------

async function onAction(el) {
  const { action, dir, task, scenario, result, path, run } = el.dataset;
  // Acting from inside the task dialog: close it so the drawer/game/toast is visible.
  if ($("#taskDialog").open && action !== "task-open" && action !== "verdict") {
    $("#taskDialog").close();
  }
  try {
    if (action === "task-open") {
      openTaskDialog(dir, task);
    } else if (action === "lane-toggle") {
      if (hiddenLanes.has(dir)) hiddenLanes.delete(dir);
      else hiddenLanes.add(dir);
      localStorage.setItem("dash.hiddenLanes", JSON.stringify([...hiddenLanes]));
      lastHash = "";
      render();
    } else if (action === "stack-start") {
      await api("/api/stack/start", { dir });
      toast("starting dev stack… (watch the lane dot)");
      openDrawer("stack", dir, `dev stack — ${dir.split("/").pop()}`);
    } else if (action === "stack-stop") {
      await api("/api/stack/stop", { dir });
      toast("stopping stack…");
    } else if (action === "open-game") {
      const wt = state.worktrees.find((w) => w.dir === dir);
      if (wt) window.open(wt.stack.clientUrl, "_blank");
    } else if (action === "test-scenario") {
      const wt = state.worktrees.find((w) => w.dir === dir);
      if (!scenario) return toast("this task has no scenario name");
      if (wt.stack.up && wt.stack.activeScenario === scenario) {
        window.open(`${wt.stack.clientUrl}?scenario=${encodeURIComponent(scenario)}`, "_blank");
      } else {
        await api("/api/stack/start", { dir, scenario });
        pendingOpen = { dir, scenario, since: Date.now() };
        toast(`${wt.stack.up ? "switching" : "booting"} the lab (${scenario})… the game opens when it's up`);
        openDrawer("stack", dir, `scenario stack — ${scenario}`);
      }
    } else if (action === "test-cli") {
      const started = await api("/api/run", { dir, taskId: task });
      openDrawer("run", started.id, "running…");
    } else if (action === "test-doc") {
      window.open(
        `/api/file?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(path)}`,
        "_blank",
      );
    } else if (action === "open-run") {
      openDrawer("run", run, "run log");
    } else if (action === "dock-run") {
      const focused = !$("#drawer").hidden && drawer.kind === "run" && drawer.id === run;
      if (focused) minimizeDrawer();
      else openDrawer("run", run, el.dataset.cmd || "run log");
    } else if (action === "dock-stack") {
      const focused = !$("#drawer").hidden && drawer.kind === "stack" && drawer.id === dir;
      if (focused) minimizeDrawer();
      else openDrawer("stack", dir, `dev stack — ${dir.split("/").pop()}`);
    } else if (action === "reopen") {
      await api("/api/task/reopen", { dir, taskId: task });
      toast("↩ back to Ready to test");
      lastHash = "";
      refresh();
    } else if (action === "verdict") {
      if (result === "verified") {
        await api("/api/task/verdict", { dir, taskId: task, result: "verified" });
        toast("✓ verified — nice");
      } else {
        const note = await askNote();
        if (note === null) return;
        await api("/api/task/verdict", { dir, taskId: task, result: "rejected", note });
        toast("✗ rejected — the agent will see your note");
      }
      if ($("#taskDialog").open) $("#taskDialog").close();
      lastHash = "";
      refresh();
    }
  } catch (err) {
    toast(String(err.message ?? err), 6000);
  }
}

function askNote() {
  return new Promise((resolve) => {
    const dialog = $("#noteDialog");
    $("#noteText").value = "";
    // Button-driven resolution (not the dialog "close" event — unreliable in embedded browsers).
    // `onclick` assignment so repeat invocations replace, never stack, handlers.
    const done = (ok) => {
      const note = $("#noteText").value.trim();
      if (ok && !note) return $("#noteText").focus(); // a rejection needs a note — keep the dialog open
      dialog.close();
      resolve(ok ? note : null);
    };
    $("#noteOk").onclick = (e) => {
      e.preventDefault();
      done(true);
    };
    $("#noteCancel").onclick = (e) => {
      e.preventDefault();
      done(false);
    };
    dialog.oncancel = () => done(false); // Esc key
    dialog.showModal();
  });
}

// ---------- wiring ----------

document.body.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el) onAction(el);
});
$("#drawerClose").addEventListener("click", minimizeDrawer);
$("#drawerKill").addEventListener("click", async () => {
  try {
    if (drawer.kind === "run") {
      await api("/api/run/kill", { id: drawer.id });
      toast("run stopped");
    } else if (drawer.kind === "stack") {
      await api("/api/stack/stop", { dir: drawer.id });
      toast("stopping stack…");
    }
  } catch (err) {
    toast(String(err.message ?? err), 6000);
  }
});
// New-worktree dialog (button-driven, like askNote — the dialog "close" event
// is unreliable in embedded browsers).
$("#newWorktree").addEventListener("click", () => {
  $("#wtName").value = "";
  $("#wtBrief").value = "";
  $("#wtDialog").showModal();
  $("#wtName").focus();
});
$("#wtCancel").addEventListener("click", () => $("#wtDialog").close());
$("#wtForm").addEventListener("submit", (e) => {
  e.preventDefault(); // Enter in the name field = Create, never a page reload
  $("#wtOk").click();
});
$("#wtOk").addEventListener("click", async () => {
  const name = $("#wtName").value.trim();
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) return toast("worktree name: a-z, 0-9, -, _", 4000);
  const brief = $("#wtBrief").value.trim();
  try {
    const started = await api("/api/worktree/create", { name, brief });
    $("#wtDialog").close();
    openDrawer("run", started.id, `creating worktree ${name}…`);
    toast("creating the worktree — the connect command prints at the end of the log");
  } catch (err) {
    toast(String(err.message ?? err), 6000);
  }
});

// task detail dialog chrome
$("#taskClose").addEventListener("click", () => $("#taskDialog").close());
$("#taskDialog").addEventListener("click", (e) => {
  if (e.target === $("#taskDialog")) $("#taskDialog").close(); // backdrop click
});
refresh();
setInterval(refresh, 2000);
