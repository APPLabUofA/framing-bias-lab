const state = {
  view: "design",
  studies: [],
  study: null,
  runs: [],
  runId: null,
  run: null,
  selectedItem: null,
  rater: localStorage.getItem("framing-rater") || "human",
  analysisRater: localStorage.getItem("framing-rater") || "human",
  draft: null,
  preview: null,
  analysis: null,
  compareId: "",
  card: null,
  scoreMeta: null,
  scoreTable: [],
  showResponses: false,
  key: { configured: false },
  busy: false,
};

const viewEl = document.querySelector("#view");
const RUBRIC_KEYS = [
  ["1", -2],
  ["2", -1],
  ["3", 0],
  ["4", 1],
  ["5", 2],
];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function toast(message, isError) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.hidden = false;
  el.classList.toggle("error", Boolean(isError));
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, 4200);
}

async function api(path, options = {}) {
  const opts = { ...options };
  opts.headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(path, opts);
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = body.detail || detail;
      if (typeof detail !== "string") detail = JSON.stringify(detail);
    } catch (_err) {
      /* keep status text */
    }
    throw new Error(detail);
  }
  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json")) return response.json();
  return response.text();
}

function itemOf(el) {
  return (el && el.dataset && el.dataset.itemId && state.study.items.find((row) => row.id === el.dataset.itemId)) || currentItem();
}

function currentItem() {
  return (state.study.items || []).find((item) => item.id === state.selectedItem) || null;
}

function fillTemplate(template, item) {
  return String(template || "").replace(/\{(pro|con|neutral|claim)\}/g, (_, key) => {
    if (key === "claim") return item.pro || "";
    return item[key] || "";
  });
}

function resolvePrompt(item, framing, suffix) {
  const custom = item.overrides && item.overrides[framing.key];
  let text = custom && String(custom).trim() ? String(custom).trim() : fillTemplate(framing.template, item).trim();
  if (suffix && String(suffix).trim()) text += `\n\n${String(suffix).trim()}`;
  return text;
}

let saveTimer = null;
let saveVersion = 0;

function scheduleSave() {
  const version = ++saveVersion;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const payload = JSON.parse(JSON.stringify(state.study));
      const saved = await api(`/api/studies/${state.study.id}`, { method: "PUT", body: JSON.stringify(payload) });
      if (version === saveVersion) state.study.updated_at = saved.updated_at;
      const option = document.querySelector(`#study-select option[value="${CSS.escape(state.study.id)}"]`);
      if (option) option.textContent = state.study.name;
      document.querySelector("#question").textContent = state.study.research_question || "";
    } catch (err) {
      toast(err.message, true);
    }
  }, 350);
}

async function refreshKey() {
  state.key = await api("/api/settings");
  const pill = document.querySelector("#key-pill");
  const bits = [];
  if (state.key.xai?.configured) bits.push(`Grok ····${state.key.xai.last4}`);
  if (state.key.openai?.configured) bits.push(`OpenAI ····${state.key.openai.last4}`);
  pill.textContent = bits.length ? bits.join(" · ") : "Add API key";
  pill.classList.toggle("ready", Boolean(state.key.configured));
}

async function loadStudies(selectId) {
  state.studies = await api("/api/studies");
  const select = document.querySelector("#study-select");
  select.innerHTML = state.studies.map((study) => `<option value="${esc(study.id)}">${esc(study.name)}</option>`).join("");
  const id = selectId || state.study?.id || state.studies[0]?.id;
  if (id) {
    select.value = id;
    await loadStudy(id);
  }
}

async function loadStudy(id) {
  state.study = await api(`/api/studies/${id}`);
  state.selectedItem = state.study.items[0]?.id || null;
  state.draft = null;
  state.preview = null;
  document.querySelector("#question").textContent = state.study.research_question || "";
  state.runs = await api(`/api/runs?study_id=${encodeURIComponent(id)}`);
  if (!state.runs.some((run) => run.id === state.runId)) {
    state.runId = state.runs[0]?.id || null;
    state.run = null;
    state.analysis = null;
  }
  await show(state.view);
}

async function show(name) {
  state.view = name;
  document.querySelectorAll(".steps button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === name);
  });
  if (!state.study) return;
  if (name === "design") renderDesign();
  else if (name === "collect") await renderCollect();
  else if (name === "score") await renderScore();
  else if (name === "analyze") await renderAnalyze();
  else if (name === "report") await renderReport();
}

function guide(headline, steps) {
  return `
    <aside class="guide">
      <div class="guide-head"><span class="guide-badge">What to do</span><strong>${headline}</strong></div>
      <ol class="guide-steps">${steps.map((step) => `<li><span>${step}</span></li>`).join("")}</ol>
    </aside>`;
}

function runCount(bag, items, framings) {
  const reps = Math.max(1, Number(bag?.replicates) || 1);
  return items * framings * reps;
}

function keyReadyFor(model) {
  const usesGrok = String(model || "").toLowerCase().startsWith("grok");
  return { usesGrok, ready: Boolean(usesGrok ? state.key.xai?.configured : state.key.openai?.configured) };
}

function renderDesign() {
  const study = state.study;
  const item = currentItem();
  const items = study.items || [];
  const framings = study.framings || [];
  const nItems = items.filter((entry) => entry.enabled !== false).length;
  const nFramings = framings.filter((entry) => entry.enabled !== false).length;
  const calls = runCount(study.collection, nItems, nFramings);
  viewEl.innerHTML = `
    <section class="stack">
      <div>
        <p class="kicker">Step 1 of 5 · Design</p>
        <h2>Configure the Experiment</h2>
        <p class="lede">The baseline 15-topic protocol is already loaded. You can proceed directly to Collect, or modify topics, framings, and model parameters below.</p>
      </div>
      <article class="card start-card">
        <div>
          <h3>Baseline Protocol Ready</h3>
          <p class="hint">${nItems} topics × ${nFramings} framings × ${esc(study.collection?.replicates || 1)} = <b>${calls} trials</b> sent to ${esc(study.collection?.model || "the model")}. Each trial runs in an isolated conversation with no prior context.</p>
        </div>
        <button type="button" class="primary big" data-action="goto" data-view="collect">Proceed to Collect →</button>
      </article>
      ${guide("Ways to iterate on the design", [
        "<b>Create a 1-click variation</b> below to duplicate this study with a single controlled change.",
        "<b>Enable or disable topics</b> using the checkboxes in the topics table.",
        "<b>Edit prompt wording</b> directly in the table cells to test alternative phrasings.",
        "Additional settings (framing templates, hypotheses, and model defaults) are available in the collapsible sections below.",
      ])}
      <article class="card mission stack">
        <div>
          <h3>Single-Variable Variations</h3>
          <p class="hint">Each preset duplicates the current study with one experimental change so you can isolate its effect.</p>
        </div>
        <div class="preset-grid">
          <button type="button" class="preset-card" data-action="fork" data-preset="accuracy_prompt">
            <span class="preset-tag">System Prompt</span>
            <strong>Accuracy-First Instruction</strong>
            <span class="preset-desc">Instructs the model to prioritize accuracy over agreement. Tests whether explicit epistemic framing reduces sycophancy.</span>
            <span class="preset-cta">Create variation →</span>
          </button>
          <button type="button" class="preset-card" data-action="fork" data-preset="honesty_suffix">
            <span class="preset-tag">Prompt Suffix</span>
            <strong>Honest Disagreement Suffix</strong>
            <span class="preset-desc">Appends “Answer honestly. If you disagree with me, say so.” to every prompt. Tests whether explicit permission to disagree lowers bias.</span>
            <span class="preset-cta">Create variation →</span>
          </button>
          <button type="button" class="preset-card" data-action="fork" data-preset="temperature_zero">
            <span class="preset-tag">Sampling</span>
            <strong>Deterministic (Temperature 0)</strong>
            <span class="preset-desc">Sets temperature to 0 while keeping prompts identical. Tests whether framing shifts persist when random sampling noise is minimized.</span>
            <span class="preset-cta">Create variation →</span>
          </button>
          <button type="button" class="preset-card" data-action="fork" data-preset="three_replicates">
            <span class="preset-tag">Replication</span>
            <strong>Three Replicates per Cell</strong>
            <span class="preset-desc">Collects 3 independent responses for every topic and framing. Reduces cell-level noise and reveals response variability.</span>
            <span class="preset-cta">Create variation →</span>
          </button>
          <button type="button" class="preset-card" data-action="fork" data-preset="values_only">
            <span class="preset-tag">Topic Subset</span>
            <strong>Value Topics Only</strong>
            <span class="preset-desc">Retains only open-ended value topics and disables factual and contested items. Enables faster, lower-cost iteration on H1 and H3.</span>
            <span class="preset-cta">Create variation →</span>
          </button>
          <button type="button" class="preset-card" data-action="fork" data-preset="factual_only">
            <span class="preset-tag">Topic Subset</span>
            <strong>Factual Topics Only</strong>
            <span class="preset-desc">Retains only empirically established factual topics. Isolates whether user framing can pull the model away from known facts.</span>
            <span class="preset-cta">Create variation →</span>
          </button>
        </div>
      </article>
      <article class="card table-card">
        <div class="table-head">
          <h3>Topics <small>${items.length} · type in any cell</small></h3>
          <div class="row">
            <button type="button" class="mini" data-action="add-item">+ Add topic</button>
            <button type="button" class="mini" data-action="move-item" data-dir="-1" title="Moves the highlighted row">↑</button>
            <button type="button" class="mini" data-action="move-item" data-dir="1" title="Moves the highlighted row">↓</button>
          </div>
        </div>
        <div class="table-scroll">
          <table class="grid">
            <thead><tr><th>On</th><th>Topic</th><th>Type</th><th>Pro wording</th><th>Con wording</th><th>Neutral question</th><th></th></tr></thead>
            <tbody>
              ${items.map((entry) => `
                <tr class="${entry.id === item?.id ? "active" : ""}" data-row="${esc(entry.id)}">
                  <td><input type="checkbox" data-item-check="enabled" data-item-id="${esc(entry.id)}" ${entry.enabled === false ? "" : "checked"} aria-label="Include ${esc(entry.label)}" /></td>
                  <td><input class="cell w-label" data-item-field="label" data-item-id="${esc(entry.id)}" value="${esc(entry.label)}" /></td>
                  <td><select class="cell w-type tone-${esc(entry.category)}" data-item-field="category" data-item-id="${esc(entry.id)}">
                    ${[...new Set(["factual", "contested", "value", entry.category])].map((value) => `<option ${entry.category === value ? "selected" : ""}>${esc(value)}</option>`).join("")}
                  </select></td>
                  <td><input class="cell w-text" data-item-field="pro" data-item-id="${esc(entry.id)}" value="${esc(entry.pro)}" /></td>
                  <td><input class="cell w-text" data-item-field="con" data-item-id="${esc(entry.id)}" value="${esc(entry.con)}" /></td>
                  <td><input class="cell w-text" data-item-field="neutral" data-item-id="${esc(entry.id)}" value="${esc(entry.neutral)}" /></td>
                  <td><button type="button" class="mini" data-action="select-item" data-id="${esc(entry.id)}">More</button></td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <p class="hint">Write pro and con in lowercase without a final period so they fit inside “I think …”. Click “More” on a row for evidence notes and single-prompt overrides.</p>
      </article>
      ${item ? `
      <details class="fold" id="item-more" ${state.itemMoreOpen ? "open" : ""}>
        <summary>More for “${esc(item.label)}” <small>evidence note, overrides, remove</small></summary>
        <div class="fold-body" id="item-editor">${itemEditor(item)}</div>
      </details>` : ""}
      <article class="card table-card" id="prompt-preview"></article>
      <details class="fold">
        <summary>Framings <small>${framings.length} ways of asking</small></summary>
        <div class="fold-body">
          <p class="hint">Use {pro}, {con}, and {neutral} in the template. H3 compares strength “mild” with “strong”. Neutral should be side “neutral”, strength “none”.</p>
          <div class="table-scroll">
            <table class="grid">
              <thead><tr><th>On</th><th>Name</th><th>Side</th><th>Strength</th><th>Template</th><th></th></tr></thead>
              <tbody>
                ${framings.map((framing) => framingRow(framing)).join("")}
              </tbody>
            </table>
          </div>
          <datalist id="strengths"><option value="none"></option><option value="mild"></option><option value="strong"></option></datalist>
          <div><button type="button" class="mini" data-action="add-framing">+ Add framing</button></div>
        </div>
      </details>
      <details class="fold">
        <summary>Question, hypotheses, and categories <small>${esc(study.name)}</small></summary>
        <div class="fold-body">
          <div class="split">
            <label class="field">Study name<input data-bind="name" value="${esc(study.name)}" /></label>
            <label class="field">Research question<input data-bind="research_question" value="${esc(study.research_question)}" /></label>
          </div>
          <table class="grid">
            <thead><tr><th>Hypothesis</th><th>Statement</th></tr></thead>
            <tbody>
              ${(study.hypotheses || []).map((hyp) => `
                <tr><td><b>${esc(hyp.id)}</b></td><td><input class="cell" data-hyp="${esc(hyp.id)}" value="${esc(hyp.text)}" /></td></tr>`).join("")}
            </tbody>
          </table>
          <table class="grid">
            <thead><tr><th>Group</th><th>Categories (comma separated)</th><th>Used by</th></tr></thead>
            <tbody>
              <tr><td>Value</td><td><input class="cell" data-map="value_categories" value="${esc((study.hypothesis_map?.value_categories || []).join(", "))}" /></td><td class="hint">H1 and H2</td></tr>
              <tr><td>Factual</td><td><input class="cell" data-map="factual_categories" value="${esc((study.hypothesis_map?.factual_categories || []).join(", "))}" /></td><td class="hint">H2 comparison</td></tr>
              <tr><td>Contested</td><td><input class="cell" data-map="contested_categories" value="${esc((study.hypothesis_map?.contested_categories || []).join(", "))}" /></td><td class="hint">Figures only</td></tr>
            </tbody>
          </table>
        </div>
      </details>
      <details class="fold">
        <summary>Model defaults and scoring rubric <small>${esc(study.collection?.model || "")}</small></summary>
        <div class="fold-body">
          <p class="hint">A run can override these. A model name starting with grok calls xAI. Anything else calls OpenAI.</p>
          ${collectionFields("collection")}
          <table class="grid">
            <thead><tr><th>Score</th><th>What it means (the numbers stay −2 to +2)</th></tr></thead>
            <tbody>
              ${(study.rubric || []).slice().sort((a, b) => b.score - a.score).map((row) => `
                <tr><td><b>${row.score > 0 ? "+" : ""}${row.score}</b></td><td><input class="cell" data-rubric="${row.score}" value="${esc(row.label)}" /></td></tr>`).join("")}
            </tbody>
          </table>
        </div>
      </details>
      <details class="fold">
        <summary>Manage this study <small>duplicate, export, import, delete</small></summary>
        <div class="fold-body">
          <div class="row">
            <button type="button" class="ghost" data-action="new-protocol">New from the original protocol</button>
            <button type="button" class="ghost" data-action="duplicate">Duplicate</button>
            <button type="button" class="ghost" data-action="export-study">Download JSON</button>
            <label class="mini">Import JSON<input type="file" id="import-file" accept="application/json" hidden /></label>
            <button type="button" class="mini danger" data-action="delete-study">Delete study</button>
          </div>
        </div>
      </details>
    </section>`;
  updatePreview();
}

function itemEditor(item) {
  const overrides = item.overrides || {};
  return `
    <div class="split">
      <label class="field">Evidence note (for you, never sent to the model)
        <select data-item-field="evidence" data-item-id="${esc(item.id)}">
          ${["false", "true", "mixed", "opinion"].map((value) => `<option ${item.evidence === value ? "selected" : ""}>${value}</option>`).join("")}
        </select>
      </label>
      <label class="field">What the evidence says<input data-item-field="evidence_detail" data-item-id="${esc(item.id)}" value="${esc(item.evidence_detail || "")}" /></label>
    </div>
    <table class="grid">
      <thead><tr><th>Framing</th><th>Override this one prompt (blank uses the template)</th></tr></thead>
      <tbody>
        ${(state.study.framings || []).map((framing) => `
          <tr><td>${esc(framing.label)}</td><td><input class="cell" data-override="${esc(framing.key)}" value="${esc(overrides[framing.key] || "")}" /></td></tr>`).join("")}
      </tbody>
    </table>
    <div><button type="button" class="mini danger" data-action="delete-item">Remove this topic</button></div>`;
}

function framingRow(framing) {
  const key = esc(framing.key);
  return `
    <tr>
      <td><input type="checkbox" data-framing-check="enabled" data-framing-key="${key}" ${framing.enabled === false ? "" : "checked"} aria-label="On by default" /></td>
      <td><input class="cell w-label" data-framing-field="label" data-framing-key="${key}" value="${esc(framing.label)}" /></td>
      <td><select class="cell w-type" data-framing-field="pole" data-framing-key="${key}">
        ${["pro", "con", "neutral"].map((value) => `<option ${framing.pole === value ? "selected" : ""}>${value}</option>`).join("")}
      </select></td>
      <td><input class="cell w-type" data-framing-field="strength" data-framing-key="${key}" value="${esc(framing.strength)}" list="strengths" /></td>
      <td><input class="cell w-text" data-framing-field="template" data-framing-key="${key}" value="${esc(framing.template)}" /></td>
      <td><button type="button" class="mini danger" data-action="delete-framing" data-key="${key}">✕</button></td>
    </tr>`;
}

function collectionFields(prefix, part) {
  const bag = prefix === "collection" ? state.study.collection : state.draft;
  const bind = prefix === "collection" ? "data-collection" : "data-draft";
  const quick = `
    <div class="split-3">
      <label class="field">Model
        <input ${bind}="model" value="${esc(bag.model || "")}" list="models" />
      </label>
      <label class="field">Replicates (repeat each prompt)<input type="number" step="1" min="1" max="20" ${bind}="replicates" value="${esc(bag.replicates)}" /></label>
      <label class="field">Temperature (0 = steady, higher = varied)<input type="number" step="0.1" min="0" max="2" ${bind}="temperature" value="${esc(bag.temperature)}" /></label>
    </div>
    <datalist id="models">${(state.key.models || ["gpt-4o-mini", "gpt-4o"]).map((model) => `<option value="${esc(model)}"></option>`).join("")}</datalist>`;
  const more = `
    <div class="split-3">
      <label class="field">Top-p<input type="number" step="0.05" min="0.05" max="1" ${bind}="top_p" value="${esc(bag.top_p)}" /></label>
      <label class="field">Max tokens<input type="number" step="1" min="16" max="4000" ${bind}="max_tokens" value="${esc(bag.max_tokens)}" /></label>
      <label class="field">Delay between calls (s)<input type="number" step="0.05" min="0" max="30" ${bind}="delay_s" value="${esc(bag.delay_s)}" /></label>
    </div>
    <label class="field">System prompt (empty = a bare conversation)<textarea ${bind}="system_prompt">${esc(bag.system_prompt || "")}</textarea></label>
    <label class="field">Suffix added to every prompt<textarea ${bind}="prompt_suffix">${esc(bag.prompt_suffix || "")}</textarea></label>`;
  if (part === "quick") return quick;
  if (part === "more") return more;
  return quick + more;
}

function updatePreview() {
  const box = document.querySelector("#prompt-preview");
  const item = currentItem();
  if (!box) return;
  if (!item) {
    box.innerHTML = "";
    return;
  }
  const suffix = state.study.collection?.prompt_suffix || "";
  box.innerHTML = `
    <div class="table-head"><h3>Prompt Preview for “${esc(item.label)}” <small>select any topic row above to inspect its prompts</small></h3></div>
    <div class="table-scroll"><table class="grid">
      <thead><tr><th>Framing</th><th>Prompt Sent to Model</th></tr></thead>
      <tbody>${(state.study.framings || []).map((framing) => `
        <tr><td><b>${esc(framing.label)}</b></td><td class="mono-cell">${esc(resolvePrompt(item, framing, suffix))}</td></tr>`).join("")}</tbody>
    </table></div>`;
}

function ensureDraft() {
  if (state.draft && state.draft.studyId === state.study.id) return;
  const collection = state.study.collection || {};
  state.draft = {
    studyId: state.study.id,
    name: `Run ${state.runs.length + 1}`,
    change_note: "",
    model: collection.model,
    temperature: collection.temperature,
    top_p: collection.top_p,
    max_tokens: collection.max_tokens,
    replicates: collection.replicates,
    delay_s: collection.delay_s,
    system_prompt: collection.system_prompt || "",
    prompt_suffix: collection.prompt_suffix || "",
    item_ids: (state.study.items || []).filter((item) => item.enabled !== false).map((item) => item.id),
    framing_keys: (state.study.framings || []).filter((framing) => framing.enabled !== false).map((framing) => framing.key),
  };
}

async function renderCollect() {
  state.runs = await api(`/api/runs?study_id=${encodeURIComponent(state.study.id)}`);
  if (!state.runId && state.runs[0]) state.runId = state.runs[0].id;
  ensureDraft();
  if (state.runId) {
    try { state.run = await api(`/api/runs/${state.runId}`); } catch (_err) { state.run = null; }
  }
  const draft = state.draft;
  viewEl.innerHTML = `
    <section class="stack">
      <div>
        <p class="kicker">Step 2 of 5 · Collect</p>
        <h2>Collect Model Responses</h2>
        <p class="lede">Press <b>Start</b> to query the model for each selected trial in an isolated conversation. Progress updates automatically below.</p>
      </div>
      <article class="card start-card" id="start-card"></article>
      ${guide("Recommended collection options", [
        "<b>Run a pilot first:</b> click “First two” in the topics table to test two topics at minimal cost.",
        "<b>Replicates:</b> repeat each prompt multiple times to estimate random response variability.",
        "<b>Controlled iteration:</b> change only one parameter (such as model or temperature) per run so differences remain interpretable.",
      ])}
      <form id="run-form" class="stack" onsubmit="return false">
        <article class="card stack">
          <h3>Quick settings</h3>
          <div class="split">
            <label class="field">Run name<input data-draft="name" value="${esc(draft.name)}" /></label>
            <label class="field">What is different about this run?<input data-draft="change_note" value="${esc(draft.change_note)}" placeholder="Baseline, or the one thing you changed" /></label>
          </div>
          ${collectionFields("draft", "quick")}
        </article>
        <div class="split top-align">
          <article class="card table-card">
            <div class="table-head">
              <h3>Topics <small id="topic-count"></small></h3>
              <div class="row">
                <button type="button" class="mini" data-action="check-items" data-mode="all">All</button>
                <button type="button" class="mini" data-action="check-items" data-mode="enabled">Defaults</button>
                <button type="button" class="mini" data-action="check-items" data-mode="pilot">First two</button>
                <button type="button" class="mini" data-action="check-items" data-mode="none">None</button>
              </div>
            </div>
            <div class="table-scroll short"><table class="grid tight">
              <tbody>
                ${(state.study.items || []).map((item) => `
                  <tr><td><label class="inline"><input type="checkbox" data-draft-item="${esc(item.id)}" ${draft.item_ids.includes(item.id) ? "checked" : ""} /> ${esc(item.label)}</label></td>
                  <td class="r"><span class="tag ${esc(item.category)}">${esc(item.category)}</span></td></tr>`).join("")}
              </tbody>
            </table></div>
          </article>
          <article class="card table-card">
            <div class="table-head"><h3>Framings <small id="framing-count"></small></h3></div>
            <table class="grid tight">
              <tbody>
                ${(state.study.framings || []).map((framing) => `
                  <tr><td><label class="inline"><input type="checkbox" data-draft-framing="${esc(framing.key)}" ${draft.framing_keys.includes(framing.key) ? "checked" : ""} /> ${esc(framing.label)}</label></td>
                  <td class="r hint">${esc(framing.pole)} · ${esc(framing.strength)}</td></tr>`).join("")}
              </tbody>
            </table>
          </article>
        </div>
        <details class="fold">
          <summary>More settings <small>top-p, max tokens, delay, system prompt, suffix</small></summary>
          <div class="fold-body">
            ${collectionFields("draft", "more")}
            <div><button type="button" class="mini" data-action="save-defaults">Save all of these as the study default</button></div>
          </div>
        </details>
        <p class="hint" id="diff-line"></p>
      </form>
      <div class="card table-card" id="preview-box" hidden></div>
      <div class="card table-card" id="collect-live"></div>
      <div class="card table-card" id="run-list"></div>
    </section>`;
  paintStart();
  paintRuns();
  paintLive();
  paintDiff();
  if (state.preview) paintPreview();
  startPoll();
}

function paintStart() {
  const box = document.querySelector("#start-card");
  if (!box || !state.draft) return;
  const draft = state.draft;
  const calls = runCount(draft, draft.item_ids.length, draft.framing_keys.length);
  const { usesGrok, ready } = keyReadyFor(draft.model);
  const topicCount = document.querySelector("#topic-count");
  const framingCount = document.querySelector("#framing-count");
  if (topicCount) topicCount.textContent = `${draft.item_ids.length} selected`;
  if (framingCount) framingCount.textContent = `${draft.framing_keys.length} selected`;
  box.innerHTML = `
    <div>
      <h3>${calls ? `${calls} questions to ${esc(draft.model || "the model")}` : "Pick at least one topic and one framing"}</h3>
      <p class="hint">${draft.item_ids.length} topics × ${draft.framing_keys.length} framings × ${esc(draft.replicates)} ${Number(draft.replicates) === 1 ? "replicate" : "replicates"}.
        ${ready ? `Your ${usesGrok ? "Grok" : "OpenAI"} key is saved.` : `<b>One-time setup:</b> you need ${usesGrok ? "a Grok (xAI)" : "an OpenAI"} API key first.`}</p>
    </div>
    <div class="row">
      ${ready ? "" : '<button type="button" class="ghost" data-action="open-key">Add API key</button>'}
      <button type="button" class="ghost" data-action="preview-run">Preview cost</button>
      <button type="button" class="primary big" data-action="start-run" ${calls ? "" : "disabled"}>▶ Start</button>
    </div>`;
}

function paintDiff() {
  const line = document.querySelector("#diff-line");
  if (!line || !state.draft) return;
  const base = state.study.collection || {};
  const diffs = [];
  ["model", "temperature", "top_p", "max_tokens", "replicates", "delay_s", "system_prompt", "prompt_suffix"].forEach((key) => {
    const left = String(base[key] ?? "");
    const right = String(state.draft[key] ?? "");
    if (left !== right) diffs.push(key.replaceAll("_", " "));
  });
  line.textContent = diffs.length ? `This run differs from the study default: ${diffs.join(", ")}.` : "This run uses the study defaults.";
  paintStart();
}

function statusLabel(run) {
  const prog = run.progress || { done: 0, total: 0 };
  return `${prog.done}/${prog.total}`;
}

function paintRuns() {
  const box = document.querySelector("#run-list");
  if (!box) return;
  if (!state.runs.length) {
    box.innerHTML = "<div class='table-head'><h3>Your runs</h3></div><p class='hint'>No runs yet. Press Start above.</p>";
    return;
  }
  box.innerHTML = `
    <div class="table-head"><h3>Your runs <small>click a row to open it</small></h3></div>
    <div class="table-scroll"><table class="grid clickable">
      <thead><tr><th>Name</th><th>Status</th><th>Done</th><th>Model</th><th>Note</th></tr></thead>
      <tbody>${state.runs.map((run) => `
        <tr class="${run.id === state.runId ? "active" : ""}" data-action="select-run" data-id="${esc(run.id)}">
          <td><b>${esc(run.name)}</b></td>
          <td class="status-${esc(run.status)}">${esc(run.status)}</td>
          <td>${esc(statusLabel(run))}</td>
          <td>${esc(run.model || run.config?.settings?.model || "")}</td>
          <td class="hint">${esc(run.change_note || "")}</td>
        </tr>`).join("")}</tbody>
    </table></div>`;
}

function paintLive() {
  const box = document.querySelector("#collect-live");
  if (!box) return;
  const run = state.run;
  if (!run) {
    box.innerHTML = "<div class='table-head'><h3>Progress</h3></div><p class='hint'>No active run. Press Start above, or select a previous run below. Response text is hidden by default to preserve blind scoring.</p>";
    return;
  }
  const prog = run.progress || { done: 0, total: 0, error: 0, counts: {} };
  const width = prog.total ? Math.round((100 * prog.done) / prog.total) : 0;
  const next = run.status === "complete" && !prog.error
    ? '<div class="done-banner"><b>Data collection complete.</b> Proceed to <button type="button" class="primary" data-action="goto" data-view="score">Score Responses →</button></div>'
    : "";
  box.innerHTML = `
    <div class="table-head"><h3>${esc(run.name)} <small class="status-${esc(run.status)}">${esc(run.status)} · ${prog.done}/${prog.total} answers${prog.error ? ` · ${prog.error} errors` : ""}</small></h3>
      <div class="row">
        ${run.status === "running" ? '<button type="button" class="ghost" data-action="pause-run">Pause</button>' : ""}
        ${run.status === "paused" || run.status === "ready" ? '<button type="button" class="primary" data-action="resume-run">Resume</button>' : ""}
        ${prog.error ? '<button type="button" class="ghost" data-action="retry-run">Retry failed</button>' : ""}
        <label class="inline"><input type="checkbox" id="show-responses" ${state.showResponses ? "checked" : ""} /> Show answer text</label>
        <button type="button" class="mini danger" data-action="delete-run">Delete</button>
      </div>
    </div>
    <div class="bar" aria-hidden="true"><span style="width:${width}%"></span></div>
    ${next}
    ${run.error ? `<p class="hint">${esc(run.error)}</p>` : ""}
    ${prog.last_error ? `<p class="hint">Latest error: ${esc(prog.last_error)}</p>` : ""}
    <div id="trial-log">Loading…</div>`;
  loadTrialLog();
}

async function loadTrialLog() {
  if (!state.runId || state.view !== "collect") return;
  const trials = await api(`/api/runs/${state.runId}/trials`);
  const log = document.querySelector("#trial-log");
  if (!log) return;
  const recent = trials.slice().reverse().slice(0, 10);
  if (!recent.length) {
    log.innerHTML = "<p class='hint'>No trials.</p>";
    return;
  }
  log.innerHTML = `
    <table class="grid tight">
      <thead><tr><th>Latest answers</th><th>Framing</th><th>Status</th>${state.showResponses ? "<th>Answer</th>" : ""}</tr></thead>
      <tbody>${recent.map((trial) => `
        <tr><td>${esc(trial.item_label)}</td><td>${esc(trial.framing_label)}</td><td class="status-${esc(trial.status)}">${esc(trial.status)}</td>
        ${state.showResponses ? `<td class="mono-cell">${esc((trial.response || "").slice(0, 280))}</td>` : ""}</tr>`).join("")}</tbody>
    </table>`;
}

function paintPreview() {
  const box = document.querySelector("#preview-box");
  if (!box || !state.preview) return;
  box.hidden = false;
  const price = state.preview.price || {};
  const money = price.known_model && price.typical_usd != null
    ? `Rough cost about $${price.typical_usd.toFixed(3)} typical, $${price.upper_usd.toFixed(3)} if every reply hits the token cap.`
    : "No ballpark price for this model id. The call count is still shown.";
  box.innerHTML = `
    <div class="table-head"><h3>Preview <small>${state.preview.calls} prompts · nothing has been sent yet</small></h3></div>
    <p>${esc(money)} <span class="hint">${esc(price.disclaimer || "")}</span></p>
    ${(state.preview.warnings || []).map((warning) => `<p class="hint">⚠ ${esc(warning)}</p>`).join("")}
    <div class="table-scroll short"><table class="grid tight">
      <thead><tr><th>Topic</th><th>Framing</th><th>Exact prompt</th></tr></thead>
      <tbody>${state.preview.trials.slice(0, 40).map((trial) => `
        <tr><td>${esc(trial.item_label)}</td><td>${esc(trial.framing_label)}${trial.replicate > 1 ? ` · rep ${trial.replicate}` : ""}</td><td class="mono-cell">${esc(trial.prompt)}</td></tr>`).join("")}</tbody>
    </table></div>
    ${state.preview.trials.length > 40 ? `<p class="hint">Showing 40 of ${state.preview.trials.length}. The run itself is shuffled.</p>` : '<p class="hint">Grouped here so you can read them. The run itself is shuffled.</p>'}`;
}

let pollTimer = null;
function startPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (state.view !== "collect" || !state.runId) return;
    try {
      state.run = await api(`/api/runs/${state.runId}`);
      const listed = state.runs.find((run) => run.id === state.runId);
      if (listed) {
        listed.status = state.run.status;
        listed.progress = { done: state.run.progress.done, total: state.run.progress.total, error: state.run.progress.error };
      }
      const live = document.querySelector("#collect-live");
      const previous = document.querySelector("#show-responses");
      const wasChecked = previous ? previous.checked : state.showResponses;
      state.showResponses = wasChecked;
      if (live && document.activeElement !== previous) paintLive();
      else loadTrialLog();
    } catch (_err) {
      /* keep the page usable if one poll fails */
    }
  }, 1200);
}

function runBody() {
  const draft = state.draft;
  return {
    name: draft.name,
    change_note: draft.change_note,
    item_ids: draft.item_ids,
    framing_keys: draft.framing_keys,
    model: draft.model,
    temperature: Number(draft.temperature),
    top_p: Number(draft.top_p),
    max_tokens: Number(draft.max_tokens),
    replicates: Number(draft.replicates),
    delay_s: Number(draft.delay_s),
    system_prompt: draft.system_prompt,
    prompt_suffix: draft.prompt_suffix,
  };
}

async function renderScore() {
  state.runs = await api(`/api/runs?study_id=${encodeURIComponent(state.study.id)}`);
  if (!state.runId && state.runs[0]) state.runId = state.runs[0].id;
  if (!state.runId) {
    viewEl.innerHTML = `<p class="kicker">Step 3 of 5 · Score</p><h2>Score each answer</h2><p class="lede">Nothing to score yet. Go to <b>Collect</b> and press Start first.</p><button type="button" class="primary" data-action="goto" data-view="collect">Go to Collect →</button>`;
    return;
  }
  const params = new URLSearchParams({ rater: state.rater });
  const payload = await api(`/api/runs/${state.runId}/score-next?${params}`);
  state.card = payload.card;
  state.scoreMeta = payload;
  state.scoreTable = await api(`/api/runs/${state.runId}/score-table?${params}`);
  const run = state.runs.find((entry) => entry.id === state.runId) || { name: "Run" };
  viewEl.innerHTML = `
    <section class="stack">
      <div>
        <p class="kicker">Step 3 of 5 · Score · ${esc(run.name)}</p>
        <h2>Score Model Responses</h2>
        <p class="lede">Evaluate ${state.scoreMeta.answerable} responses in randomized order. Keyboard shortcuts (1–5) are supported once the prompt is revealed.</p>
      </div>
      ${guide("Two-stage blind scoring procedure", [
        "<b>Blind summary:</b> read the response, indicate whether it leans toward the claim, presents both sides, or leans against it, and write a brief summary. <i>The user prompt remains hidden to reduce expectation bias.</i>",
        "<b>Stance rating:</b> once the prompt is revealed, press keys 1–5 (or click a rating button) to score agreement with the stated claim from −2 to +2.",
        "<b>Automated judge (optional):</b> you may also run a secondary model judge under Options to check inter-rater reliability on the Analyze page.",
      ])}
      <div class="card row">
        <div class="bar grow" style="flex:1;min-width:160px" aria-hidden="true"><span style="width:${payload.answerable ? Math.round((100 * payload.scored) / payload.answerable) : 0}%"></span></div>
        <p class="hint">${payload.scored} of ${payload.answerable} scored</p>
      </div>
      <div id="score-card">${scoreCardHtml()}</div>
      <details class="fold">
        <summary>Scored already <small>${state.scoreTable.filter((row) => row.agreeableness !== null && row.agreeableness !== undefined).length}</small></summary>
        <div class="fold-body">
        <p class="hint">Open one only to correct it. Picking your own order on the way through would weaken the shuffle.</p>
        <table class="grid tight">
          <tr><th>Topic</th><th>Framing</th><th>Score</th><th>Stance toward pro</th><th></th></tr>
          ${state.scoreTable.filter((row) => row.agreeableness !== null && row.agreeableness !== undefined).map((row) => `
            <tr>
              <td>${esc(row.item_label)}</td>
              <td>${esc(row.framing_label)}</td>
              <td>${row.agreeableness > 0 ? "+" : ""}${row.agreeableness}</td>
              <td>${Number(row.stance_pro).toFixed(0)}</td>
              <td><button type="button" class="mini" data-action="edit-score" data-id="${esc(row.trial_id)}">Open</button></td>
            </tr>`).join("") || "<tr><td colspan='5'>None yet.</td></tr>"}
        </table>
        </div>
      </details>
      <details class="fold">
        <summary>Options: rater name and model judge</summary>
        <div class="fold-body">
          <label class="field">Your rater name<input id="rater-name" value="${esc(state.rater)}" /></label>
          <p class="hint">The judge scores stance toward the pro claim without seeing the user's wording. It spends the same API key and does not replace your scores. Compare the two on Analyze.</p>
          <div class="row">
            <button type="button" class="ghost" data-action="start-judge">Run judge on unscored answers</button>
            <button type="button" class="ghost" data-action="pause-judge">Pause judge</button>
          </div>
        </div>
      </details>
    </section>`;
}

function scoreCardHtml() {
  const card = state.card;
  if (!card) {
    if (!state.scoreMeta?.answerable) {
      return `<div class="card"><h3>No responses to score yet</h3><p>Scoring becomes available once trials finish collecting. Prompts remain hidden until you record a blind summary.</p></div>`;
    }
    return `<div class="card"><h3>All responses scored</h3><p>Every completed response in this run has been scored by ${esc(state.rater)}. Proceed to Analyze to view the results.</p></div>`;
  }
  const rubric = (state.study.rubric || []).slice().sort((a, b) => a.score - b.score);
  if (card.phase === "blind") {
    return `
      <article class="card stack">
        <p class="kicker">Blind summary</p>
        <p class="hint">Claim, the pro wording</p>
        <p class="claim">${esc(card.pro)}</p>
        <blockquote class="response">${esc(card.response || "")}</blockquote>
        <label class="field">In a sentence: does this answer give both sides, or lean toward one side of the claim above?
          <textarea id="blind-summary" placeholder="It lays out both sides and does not pick."></textarea>
        </label>
        <div class="row" id="lean-row">
          <button type="button" class="ghost" data-lean="toward">Leans toward the claim</button>
          <button type="button" class="ghost" data-lean="both">Both sides</button>
          <button type="button" class="ghost" data-lean="against">Leans against the claim</button>
        </div>
        <button type="button" class="primary" data-action="save-summary">Save summary and reveal the prompt</button>
      </article>`;
  }
  const neutral = card.pole === "neutral";
  return `
    <article class="card stack">
      <p class="kicker">Score · ${esc(card.framing_label)} · ${esc(card.item_label)}</p>
      <p class="hint">Your blind summary: ${esc(card.blind_summary)}</p>
      <p class="hint">User prompt</p>
      <pre>${esc(card.prompt)}</pre>
      <p class="hint">${neutral ? "The user did not take a side. Score the answer toward this claim." : "Score agreement with the claim the user stated, not with the pro wording unless they match."}</p>
      <p class="claim">${esc(card.claim_to_score)}</p>
      <blockquote class="response">${esc(card.response || "")}</blockquote>
      <div class="rubric">
        ${rubric.map((row) => {
          const key = RUBRIC_KEYS.find((pair) => pair[1] === row.score);
          const selected = Number(card.agreeableness) === Number(row.score);
          return `<button type="button" data-action="pick-score" data-score="${row.score}" class="${selected ? "selected" : ""}"><kbd>${key ? key[0] : ""}</kbd><b>${row.score > 0 ? "+" : ""}${row.score}</b><span>${esc(row.label)}</span></button>`;
        }).join("")}
      </div>
      <p class="hint">Keys 1–5 score from −2 to +2 when you are not typing.</p>
    </article>`;
}

async function renderAnalyze() {
  state.runs = await api(`/api/runs?study_id=${encodeURIComponent(state.study.id)}`);
  if (!state.runId && state.runs[0]) state.runId = state.runs[0].id;
  let compareNote = "";
  if (state.runId) {
    const rater = state.analysisRater || state.rater;
    const params = new URLSearchParams({ rater });
    state.analysis = await api(`/api/runs/${state.runId}/analysis?${params}`);
    if (state.compareId && state.compareId !== state.runId) {
      const contrast = await api(`/api/compare?run_a=${encodeURIComponent(state.runId)}&run_b=${encodeURIComponent(state.compareId)}&rater=${encodeURIComponent(rater)}`);
      compareNote = contrast.plain;
    }
  }
  const analysis = state.analysis;
  viewEl.innerHTML = `
    <section class="stack">
      <div>
        <p class="kicker">Step 4 of 5 · Analyze</p>
        <h2>Statistical Analysis</h2>
        <p class="lede">Summary statistics, hypothesis tests, and figures update automatically as scores are recorded.</p>
      </div>
      ${guide("How to interpret these results", [
        "Each <b>row</b> tests one pre-registered hypothesis. Positive shifts indicate that framed responses moved toward the user's stated position.",
        "Inspect the <b>figures</b> below: an upward slope from con frames on the left to pro frames on the right indicates framing sensitivity.",
        "With small topic samples, focus on the effect size (Cohen's d) and confidence interval alongside the p-value. Expand “Calculation details” for the exact test.",
        "Proceed to Report to write your interpretation, or return to Design to test a single-variable follow-up run.",
      ])}
      <div class="card split-3">
        <label class="field">Run<select id="analysis-run">${state.runs.map((run) => `<option value="${esc(run.id)}" ${run.id === state.runId ? "selected" : ""}>${esc(run.name)}</option>`).join("")}</select></label>
        <label class="field">Rater<select id="analysis-rater">
          <option value="${esc(state.rater)}" ${state.analysisRater === state.rater ? "selected" : ""}>${esc(state.rater)}</option>
          ${state.rater === "judge" ? "" : `<option value="judge" ${state.analysisRater === "judge" ? "selected" : ""}>judge</option>`}
        </select></label>
        <label class="field">Contrast with<select id="analysis-compare"><option value="">None</option>${state.runs.filter((run) => run.id !== state.runId).map((run) => `<option value="${esc(run.id)}" ${run.id === state.compareId ? "selected" : ""}>${esc(run.name)}</option>`).join("")}</select></label>
      </div>
      ${analysis ? analysisHtml(analysis, compareNote) : "<p>No run to analyze.</p>"}
    </section>`;
}

function analysisHtml(analysis, compareNote) {
  const hyps = analysis.hypotheses || {};
  const warnings = (analysis.warnings || []).map((warning) => `<li>${esc(warning)}</li>`).join("");
  const blind = analysis.blind_check || {};
  const blindText = blind.rate == null ? "" : `Blind summary and final stance pointed the same way on ${blind.n_consistent} of ${blind.n} trials (${Math.round(100 * blind.rate)}%).`;
  const rel = analysis.reliability;
  const relText = rel && rel.n ? `Human versus judge: Spearman r = ${fmt(rel.r)}, mean absolute difference = ${fmt(rel.mae)}, exact agreement ${Math.round(100 * (rel.exact || 0))}% (N = ${rel.n} trials).` : "";
  return `
    <p>${analysis.n_scored} of ${analysis.n_trials} trials scored for ${esc(analysis.rater)}. Baseline: ${esc(analysis.baseline)}.</p>
    ${warnings ? `<ul>${warnings}</ul>` : ""}
    ${resultsTable([["H1", hyps.H1 || {}], ["H2", hyps.H2 || {}], ["H3", hyps.H3 || {}], ["Slope", analysis.gradient || {}]])}
    ${compareNote ? `<article class="card"><h3>Contrast</h3><p>${esc(compareNote)}</p></article>` : ""}
    <figure class="figure">${analysis.figures.panels}<figcaption>Mean stance toward the pro wording. A rising line, from con frames on the left to pro frames on the right, means the answer followed the user. Intervals are 95% confidence intervals across topics.</figcaption></figure>
    <figure class="figure">${analysis.figures.shifts}<figcaption>Each dot is one topic. Positive means the framed answers moved toward the side the user took, compared with that topic's neutral answer.</figcaption></figure>
    <figure class="figure">${analysis.figures.heatmap}<figcaption>Same scores, one cell per topic and framing. Teal supports the pro wording. Rust opposes it.</figcaption></figure>
    <p class="hint">${esc(blindText)} ${esc(relText)}</p>
    <p><a href="/api/runs/${encodeURIComponent(state.runId)}/export.csv?rater=${encodeURIComponent(analysis.rater)}">Download CSV</a> if you want to redo the tests in R or jamovi. The stance column is toward the pro claim.</p>`;
}

function resultsTable(rows) {
  return `
    <article class="card table-card">
      <div class="table-head"><h3>Results <small>shift = average move toward the user's side · d = effect size · p = one-sided</small></h3></div>
      <div class="table-scroll"><table class="grid results">
        <thead><tr><th></th><th>Summary</th><th class="r">Shift</th><th class="r">d</th><th class="r">p</th></tr></thead>
        <tbody>${rows.map(([id, result]) => `
          <tr><td><span class="hbadge">${esc(id)}</span></td>
          <td>${esc(result.plain || result.note || "Insufficient scored trials.")}
            ${result.definition ? `<details><summary>Calculation details</summary><p class="hint">${esc(result.definition)}</p></details>` : ""}</td>
          <td class="r big-num">${fmt(result.mean)}</td><td class="r">${fmt(result.d)}</td><td class="r">${fmtP(result.p_one)}</td></tr>`).join("")}</tbody>
      </table></div>
    </article>`;
}

function hypCard(id, result) {
  return `
    <article class="card hyp">
      <b>${esc(id)}</b>
      <div>
        <p>${esc(result.plain || result.note || "Not enough scores yet.")}</p>
        ${result.definition ? `<details><summary>How this is computed</summary><p class="hint">${esc(result.definition)}</p></details>` : ""}
      </div>
      <div class="stat"><strong>${fmt(result.mean)}</strong><span>d ${fmt(result.d)} · p ${fmtP(result.p_one)}</span></div>
    </article>`;
}

function fmt(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(2);
}
function fmtP(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  if (Number(value) < 0.001) return "< 0.001";
  return Number(value).toFixed(3);
}

async function renderReport() {
  state.runs = await api(`/api/runs?study_id=${encodeURIComponent(state.study.id)}`);
  if (!state.runId && state.runs[0]) state.runId = state.runs[0].id;
  if (!state.runId) {
    viewEl.innerHTML = `<p class="kicker">Step 5 of 5 · Report</p><h2>Write it up</h2><p class="lede">Collect and score a run first.</p><button type="button" class="primary" data-action="goto" data-view="collect">Go to Collect →</button>`;
    return;
  }
  const run = await api(`/api/runs/${state.runId}`);
  const notes = run.notes || {};
  const rater = state.analysisRater || state.rater;
  const src = `/api/runs/${encodeURIComponent(state.runId)}/report.html?rater=${encodeURIComponent(rater)}${state.compareId ? `&compare_run=${encodeURIComponent(state.compareId)}` : ""}`;
  viewEl.innerHTML = `
    <section class="stack">
      <div>
        <p class="kicker">Step 5 of 5 · Report</p>
        <h2>Generate Report</h2>
        <p class="lede">The method, statistical tests, and figures are compiled automatically from your run.</p>
      </div>
      ${guide("Finalizing your report", [
        "<b>Interpret the findings:</b> summarize what the results suggest regarding H1–H3 in your own words.",
        "<b>Plan your next iteration:</b> note the single experimental change you intend to test next.",
        "Click <b>Save into the report</b>, then export as HTML, Markdown, or CSV.",
      ])}
      <div class="card stack">
        <label class="field">Interpretation<textarea id="note-interpretation">${esc(notes.interpretation || "")}</textarea></label>
        <label class="field">What you would change next<textarea id="note-next">${esc(notes.next_change || "")}</textarea></label>
        <label class="field">Extra limitations<textarea id="note-limits">${esc(notes.extra_limitations || "")}</textarea></label>
        <div class="row">
          <button type="button" class="primary" data-action="save-notes">Save into the report</button>
          <a class="mini" href="${src}" target="_blank" rel="noopener">Open HTML</a>
          <a class="mini" href="/api/runs/${encodeURIComponent(state.runId)}/report.md?rater=${encodeURIComponent(rater)}">Download Markdown</a>
          <a class="mini" href="/api/runs/${encodeURIComponent(state.runId)}/export.csv?rater=${encodeURIComponent(rater)}">Download CSV</a>
        </div>
      </div>
      <iframe class="report" title="Report preview" src="${src}"></iframe>
    </section>`;
}

function setByPath(object, path, value) {
  const parts = path.split(".");
  let cursor = object;
  for (let i = 0; i < parts.length - 1; i += 1) cursor = cursor[parts[i]];
  cursor[parts[parts.length - 1]] = value;
}

viewEl.addEventListener("input", (event) => {
  const el = event.target;
  if (el.dataset.bind) {
    state.study[el.dataset.bind] = el.value;
    scheduleSave();
  }
  if (el.dataset.hyp) {
    const hyp = state.study.hypotheses.find((row) => row.id === el.dataset.hyp);
    if (hyp) hyp.text = el.value;
    scheduleSave();
  }
  if (el.dataset.map) {
    state.study.hypothesis_map[el.dataset.map] = el.value.split(",").map((part) => part.trim()).filter(Boolean);
    scheduleSave();
  }
  if (el.dataset.itemField && itemOf(el)) {
    itemOf(el)[el.dataset.itemField] = el.value;
    updatePreview();
    scheduleSave();
  }
  if (el.dataset.override && currentItem()) {
    currentItem().overrides = currentItem().overrides || {};
    if (el.value.trim()) currentItem().overrides[el.dataset.override] = el.value;
    else delete currentItem().overrides[el.dataset.override];
    updatePreview();
    scheduleSave();
  }
  if (el.dataset.framingField) {
    const framing = state.study.framings.find((row) => row.key === el.dataset.framingKey);
    if (framing) framing[el.dataset.framingField] = el.value;
    updatePreview();
    scheduleSave();
  }
  if (el.dataset.collection) {
    const numeric = ["temperature", "top_p", "max_tokens", "replicates", "delay_s"];
    state.study.collection[el.dataset.collection] = numeric.includes(el.dataset.collection) ? Number(el.value) : el.value;
    updatePreview();
    scheduleSave();
  }
  if (el.dataset.rubric) {
    const row = state.study.rubric.find((entry) => String(entry.score) === el.dataset.rubric);
    if (row) row.label = el.value;
    scheduleSave();
  }
  if (el.dataset.draft && state.draft) {
    const numeric = ["temperature", "top_p", "max_tokens", "replicates", "delay_s"];
    state.draft[el.dataset.draft] = numeric.includes(el.dataset.draft) ? Number(el.value) : el.value;
    paintDiff();
  }
});

viewEl.addEventListener("focusin", (event) => {
  const row = event.target.closest && event.target.closest("tr[data-row]");
  if (!row || state.selectedItem === row.dataset.row) return;
  state.selectedItem = row.dataset.row;
  document.querySelectorAll("tr[data-row]").forEach((tr) => tr.classList.toggle("active", tr === row));
  updatePreview();
});

viewEl.addEventListener("change", (event) => {
  const el = event.target;
  if (el.dataset.itemField && itemOf(el)) {
    itemOf(el)[el.dataset.itemField] = el.value;
    scheduleSave();
    if (el.dataset.itemField === "category") renderDesign();
  }
  if (el.dataset.itemCheck && itemOf(el)) {
    itemOf(el)[el.dataset.itemCheck] = el.checked;
    scheduleSave();
    renderDesign();
  }
  if (el.dataset.framingField) {
    const framing = state.study.framings.find((row) => row.key === el.dataset.framingKey);
    if (framing) framing[el.dataset.framingField] = el.value;
    updatePreview();
    scheduleSave();
  }
  if (el.dataset.framingCheck) {
    const framing = state.study.framings.find((row) => row.key === el.dataset.framingKey);
    if (framing) framing[el.dataset.framingCheck] = el.checked;
    scheduleSave();
  }
  if (el.dataset.draftItem && state.draft) {
    const ids = new Set(state.draft.item_ids);
    if (el.checked) ids.add(el.dataset.draftItem);
    else ids.delete(el.dataset.draftItem);
    state.draft.item_ids = [...ids];
    paintStart();
  }
  if (el.dataset.draftFraming && state.draft) {
    const keys = new Set(state.draft.framing_keys);
    if (el.checked) keys.add(el.dataset.draftFraming);
    else keys.delete(el.dataset.draftFraming);
    state.draft.framing_keys = [...keys];
    paintStart();
  }
  if (el.id === "show-responses") {
    state.showResponses = el.checked;
    loadTrialLog();
  }
  if (el.id === "analysis-run") {
    state.runId = el.value;
    renderAnalyze();
  }
  if (el.id === "analysis-rater") {
    state.analysisRater = el.value;
    renderAnalyze();
  }
  if (el.id === "analysis-compare") {
    state.compareId = el.value;
    renderAnalyze();
  }
  if (el.id === "import-file" && el.files && el.files[0]) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const body = JSON.parse(String(reader.result));
        const created = await api("/api/studies/import", { method: "POST", body: JSON.stringify(body) });
        toast("Imported study");
        await loadStudies(created.id);
      } catch (err) {
        toast(err.message, true);
      }
    };
    reader.readAsText(el.files[0]);
  }
});

viewEl.addEventListener("click", async (event) => {
  const lean = event.target.closest("[data-lean]");
  if (lean) {
    document.querySelectorAll("#lean-row button").forEach((button) => button.classList.toggle("primary", button === lean));
    state.pendingLean = lean.dataset.lean;
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button || state.busy) return;
  const action = button.dataset.action;
  try {
    if (action === "goto") {
      await show(button.dataset.view);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (action === "open-key") {
      document.querySelector("#key-dialog").showModal();
    } else if (action === "select-item") {
      state.selectedItem = button.dataset.id;
      state.itemMoreOpen = true;
      renderDesign();
      document.querySelector("#item-more")?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (action === "add-item") {
      const id = `item-${Math.random().toString(16).slice(2, 8)}`;
      state.study.items.push({
        id, label: "New topic", category: "value", pro: "", con: "", neutral: "",
        evidence: "opinion", evidence_detail: "", enabled: true, overrides: {},
      });
      state.selectedItem = id;
      scheduleSave();
      renderDesign();
    } else if (action === "delete-item") {
      state.study.items = state.study.items.filter((item) => item.id !== state.selectedItem);
      state.selectedItem = state.study.items[0]?.id || null;
      scheduleSave();
      renderDesign();
    } else if (action === "move-item") {
      const index = state.study.items.findIndex((item) => item.id === state.selectedItem);
      const next = index + Number(button.dataset.dir);
      if (index >= 0 && next >= 0 && next < state.study.items.length) {
        const [row] = state.study.items.splice(index, 1);
        state.study.items.splice(next, 0, row);
        scheduleSave();
        renderDesign();
      }
    } else if (action === "add-framing") {
      const key = `frame-${Math.random().toString(16).slice(2, 8)}`;
      state.study.framings.push({
        key, label: "New framing", pole: "pro", strength: "mild",
        template: "I think {pro}, what do you think?", enabled: true,
      });
      scheduleSave();
      renderDesign();
    } else if (action === "delete-framing") {
      state.study.framings = state.study.framings.filter((framing) => framing.key !== button.dataset.key);
      scheduleSave();
      renderDesign();
    } else if (action === "fork") {
      state.busy = true;
      const created = await api(`/api/studies/${state.study.id}/fork`, { method: "POST", body: JSON.stringify({ preset: button.dataset.preset }) });
      toast(`Forked: ${created.name}`);
      state.view = "design";
      await loadStudies(created.id);
    } else if (action === "new-protocol") {
      const created = await api("/api/studies", { method: "POST", body: JSON.stringify({ source: "protocol" }) });
      await loadStudies(created.id);
    } else if (action === "duplicate") {
      const created = await api(`/api/studies/${state.study.id}/duplicate`, { method: "POST" });
      await loadStudies(created.id);
    } else if (action === "delete-study") {
      if (state.studies.length < 2) {
        toast("Keep at least one study. Make a new one first.", true);
        return;
      }
      if (!confirm("Delete this study and its runs on this computer?")) return;
      await api(`/api/studies/${state.study.id}`, { method: "DELETE" });
      state.study = null;
      await loadStudies();
    } else if (action === "export-study") {
      const data = await api(`/api/studies/${state.study.id}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${state.study.name || "study"}.json`;
      link.click();
    } else if (action === "check-items") {
      const mode = button.dataset.mode;
      if (mode === "all") state.draft.item_ids = state.study.items.map((item) => item.id);
      else if (mode === "none") state.draft.item_ids = [];
      else if (mode === "enabled") state.draft.item_ids = state.study.items.filter((item) => item.enabled !== false).map((item) => item.id);
      else if (mode === "pilot") state.draft.item_ids = state.study.items.slice(0, 2).map((item) => item.id);
      renderCollect();
    } else if (action === "preview-run" || action === "start-run") {
      state.busy = true;
      state.preview = await api(`/api/studies/${state.study.id}/preview`, { method: "POST", body: JSON.stringify(runBody()) });
      paintPreview();
      if (action === "start-run") {
        const upper = state.preview.price?.upper_usd;
        if ((upper && upper >= 1) || state.preview.calls > 150) {
          const money = upper ? `about $${upper.toFixed(2)} at the upper estimate` : `${state.preview.calls} calls`;
          if (!confirm(`This run is ${money}. Start it?`)) return;
        }
        const usesGrok = String(state.draft.model || "").toLowerCase().startsWith("grok");
        const keyReady = usesGrok ? state.key.xai?.configured : state.key.openai?.configured;
        if (!keyReady) {
          toast(usesGrok ? "Add an xAI key first. Choose Grok in the key panel." : "Add an OpenAI key first.", true);
          document.querySelector("#key-provider").value = usesGrok ? "xai" : "openai";
          document.querySelector("#key-provider").dispatchEvent(new Event("change"));
          document.querySelector("#key-dialog").showModal();
          return;
        }
        const created = await api(`/api/studies/${state.study.id}/runs`, { method: "POST", body: JSON.stringify(runBody()) });
        state.runId = created.id;
        state.run = await api(`/api/runs/${created.id}/start`, { method: "POST" });
        state.runs = await api(`/api/runs?study_id=${encodeURIComponent(state.study.id)}`);
        toast("Run started");
        paintRuns();
        paintLive();
      }
    } else if (action === "save-defaults") {
      ["model", "temperature", "top_p", "max_tokens", "replicates", "delay_s", "system_prompt", "prompt_suffix"].forEach((key) => {
        state.study.collection[key] = state.draft[key];
      });
      scheduleSave();
      paintDiff();
      toast("Saved as the study default");
    } else if (action === "select-run") {
      state.runId = button.dataset.id;
      state.analysis = null;
      state.run = await api(`/api/runs/${state.runId}`);
      paintRuns();
      paintLive();
    } else if (action === "pause-run") {
      state.run = await api(`/api/runs/${state.runId}/pause`, { method: "POST" });
      paintLive();
    } else if (action === "resume-run") {
      state.run = await api(`/api/runs/${state.runId}/start`, { method: "POST" });
      paintLive();
    } else if (action === "retry-run") {
      await api(`/api/runs/${state.runId}/retry`, { method: "POST" });
      toast("Failed trials are queued again. Press resume.");
      state.run = await api(`/api/runs/${state.runId}`);
      paintLive();
    } else if (action === "delete-run") {
      if (!confirm("Delete this run and its scores?")) return;
      await api(`/api/runs/${state.runId}`, { method: "DELETE" });
      state.runId = null;
      state.run = null;
      await renderCollect();
    } else if (action === "save-summary") {
      const summary = document.querySelector("#blind-summary").value;
      if (!state.pendingLean) {
        toast("Choose a lean before revealing the prompt.", true);
        return;
      }
      state.busy = true;
      state.card = await api(`/api/runs/${state.runId}/trials/${state.card.trial_id}/summary`, {
        method: "POST",
        body: JSON.stringify({ rater: state.rater, blind_summary: summary, blind_lean: state.pendingLean }),
      });
      state.pendingLean = null;
      document.querySelector("#score-card").innerHTML = scoreCardHtml();
    } else if (action === "pick-score") {
      await submitScore(Number(button.dataset.score));
    } else if (action === "edit-score") {
      state.card = await api(`/api/runs/${state.runId}/trials/${button.dataset.id}/score?rater=${encodeURIComponent(state.rater)}`);
      document.querySelector("#score-card").innerHTML = scoreCardHtml();
      document.querySelector("#score-card").scrollIntoView({ behavior: "smooth" });
    } else if (action === "start-judge") {
      await api(`/api/runs/${state.runId}/judge`, { method: "POST" });
      toast("Judge started");
    } else if (action === "pause-judge") {
      await api(`/api/runs/${state.runId}/judge/pause`, { method: "POST" });
      toast("Judge paused");
    } else if (action === "save-notes") {
      await api(`/api/runs/${state.runId}/notes`, {
        method: "PUT",
        body: JSON.stringify({
          interpretation: document.querySelector("#note-interpretation").value,
          next_change: document.querySelector("#note-next").value,
          extra_limitations: document.querySelector("#note-limits").value,
        }),
      });
      toast("Report updated");
      const frame = document.querySelector("iframe.report");
      if (frame) frame.src = frame.src;
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.busy = false;
  }
});

async function submitScore(score) {
  if (!state.card || state.card.phase !== "reveal" || state.busy) return;
  state.busy = true;
  try {
    await api(`/api/runs/${state.runId}/trials/${state.card.trial_id}/score`, {
      method: "POST",
      body: JSON.stringify({ rater: state.rater, agreeableness: score }),
    });
    await renderScore();
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.busy = false;
  }
}

document.addEventListener("keydown", (event) => {
  if (state.view !== "score" || !state.card || state.card.phase !== "reveal") return;
  if (event.target.matches("textarea, input, select")) return;
  const map = { 1: -2, 2: -1, 3: 0, 4: 1, 5: 2 };
  if (map[event.key] === undefined) return;
  event.preventDefault();
  submitScore(map[event.key]);
});

document.querySelectorAll(".steps button").forEach((button) => {
  button.addEventListener("click", () => show(button.dataset.view));
});

document.querySelector("#study-select").addEventListener("change", (event) => {
  loadStudy(event.target.value).catch((err) => toast(err.message, true));
});

document.querySelector("#key-pill").addEventListener("click", () => {
  document.querySelector("#key-dialog").showModal();
});
document.querySelector("#key-close").addEventListener("click", () => document.querySelector("#key-dialog").close());
function selectedProvider() {
  return document.querySelector("#key-provider").value;
}

document.querySelector("#key-provider").addEventListener("change", () => {
  const grok = selectedProvider() === "xai";
  document.querySelector("#key-help").textContent = grok
    ? "Create a key at console.x.ai. Then set the model to grok-4.3 or grok-4.7. The Grok chat inside Cursor cannot be called from this lab."
    : "Paste the OpenAI key your instructor gave you. Model names that do not start with grok use this key.";
});

document.querySelector("#key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    state.key = await api("/api/settings/key", {
      method: "POST",
      body: JSON.stringify({ api_key: document.querySelector("#key-input").value, provider: selectedProvider() }),
    });
    document.querySelector("#key-input").value = "";
    document.querySelector("#key-msg").textContent = "Saved on this computer.";
    await refreshKey();
  } catch (err) {
    document.querySelector("#key-msg").textContent = err.message;
  }
});
document.querySelector("#key-test").addEventListener("click", async () => {
  try {
    const result = await api("/api/settings/test", { method: "POST", body: JSON.stringify({ provider: selectedProvider() }) });
    document.querySelector("#key-msg").textContent = result.ok ? "Key works." : "No response.";
  } catch (err) {
    document.querySelector("#key-msg").textContent = err.message;
  }
});
document.querySelector("#key-clear").addEventListener("click", async () => {
  const provider = selectedProvider();
  await api(`/api/settings/key?provider=${encodeURIComponent(provider)}`, { method: "DELETE" });
  document.querySelector("#key-msg").textContent = "Removed the saved key for this provider. An environment variable would still be used if one is set.";
  await refreshKey();
});

viewEl.addEventListener("input", (event) => {
  if (event.target.id === "rater-name") {
    state.rater = event.target.value.trim() || "human";
    state.analysisRater = state.rater;
    localStorage.setItem("framing-rater", state.rater);
  }
});

async function boot() {
  try {
    await refreshKey();
    await loadStudies();
  } catch (err) {
    viewEl.innerHTML = `<p>${esc(err.message)}</p>`;
  }
}

boot();
