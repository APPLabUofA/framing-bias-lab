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
  pill.textContent = state.key.configured ? `Key ····${state.key.last4}` : "Add API key";
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

function renderDesign() {
  const study = state.study;
  const item = currentItem();
  viewEl.innerHTML = `
    <section class="stack">
      <div>
        <p class="kicker">Step 1</p>
        <h2>Design the experiment</h2>
        <p class="lede">The 15 topics and five framings are already loaded. Change one thing when you want to test an idea. The evidence notes stay on this page. They are never sent to the model.</p>
      </div>
      <article class="card mission">
        <h3>What to iterate</h3>
        <p>Collect a baseline, score it, and read the slope. Then fork the study with one change and run a matched subset. The result to write about is the contrast, not a single p-value.</p>
        <div class="preset-grid">
          <button type="button" data-action="fork" data-preset="accuracy_prompt">Accuracy system prompt</button>
          <button type="button" data-action="fork" data-preset="honesty_suffix">Suffix: disagree if you must</button>
          <button type="button" data-action="fork" data-preset="temperature_zero">Temperature 0</button>
          <button type="button" data-action="fork" data-preset="three_replicates">Three replicates</button>
          <button type="button" data-action="fork" data-preset="values_only">Value topics only</button>
          <button type="button" data-action="fork" data-preset="factual_only">Factual topics only</button>
        </div>
      </article>
      <div class="card stack">
        <label class="field">Study name<input data-bind="name" value="${esc(study.name)}" /></label>
        <label class="field">Research question<textarea data-bind="research_question">${esc(study.research_question)}</textarea></label>
        ${(study.hypotheses || []).map((hyp) => `
          <label class="field">${esc(hyp.id)}
            <textarea data-hyp="${esc(hyp.id)}">${esc(hyp.text)}</textarea>
          </label>`).join("")}
        <div class="split-3">
          <label class="field">Value categories<input data-map="value_categories" value="${esc((study.hypothesis_map?.value_categories || []).join(", "))}" /></label>
          <label class="field">Factual categories<input data-map="factual_categories" value="${esc((study.hypothesis_map?.factual_categories || []).join(", "))}" /></label>
          <label class="field">Contested categories<input data-map="contested_categories" value="${esc((study.hypothesis_map?.contested_categories || []).join(", "))}" /></label>
        </div>
        <p class="hint">H1 uses the value list. H2 compares value with factual. Other category names still appear in the figures. Separate names with commas.</p>
      </div>
      <div class="grid-2">
        <div class="stack">
          <div class="row">
            <button type="button" class="mini" data-action="add-item">Add topic</button>
            <button type="button" class="mini" data-action="move-item" data-dir="-1">Up</button>
            <button type="button" class="mini" data-action="move-item" data-dir="1">Down</button>
          </div>
          <div class="item-list">
            ${(study.items || []).map((entry) => `
              <button type="button" class="item ${entry.id === item?.id ? "active" : ""}" data-action="select-item" data-id="${esc(entry.id)}">
                <strong data-item-label="${esc(entry.id)}">${esc(entry.label)}</strong>
                <small><span class="tag ${esc(entry.category)}">${esc(entry.category)}</span> ${entry.enabled === false ? '<span class="tag off">off</span>' : ""}</small>
              </button>`).join("")}
          </div>
        </div>
        <div class="card stack" id="item-editor">
          ${item ? itemEditor(item) : "<p>Add a topic to begin.</p>"}
        </div>
      </div>
      <div class="card stack">
        <div class="row">
          <h3>Framing templates</h3>
          <button type="button" class="mini" data-action="add-framing">Add framing</button>
        </div>
        <p class="hint">Use {pro}, {con}, and {neutral}. Write the pro and con lines in lowercase and without a final period, the way they should sit inside “I think …”. A per-topic override replaces the template for that cell only.</p>
        ${(study.framings || []).map((framing) => framingEditor(framing)).join("")}
      </div>
      <div class="card stack">
        <h3>Collection defaults</h3>
        <p class="hint">A run can override these without changing the study. Save a default here when you want every new run to start from it.</p>
        ${collectionFields("collection")}
      </div>
      <div class="card stack">
        <h3>Rubric wording</h3>
        <p class="hint">The numbers stay −2 to +2 so the tests keep their meaning. You can change the anchor sentences.</p>
        ${(study.rubric || []).slice().sort((a, b) => b.score - a.score).map((row) => `
          <label class="field">${row.score > 0 ? "+" : ""}${row.score}
            <input data-rubric="${row.score}" value="${esc(row.label)}" />
          </label>`).join("")}
      </div>
      <div class="card" id="prompt-preview"></div>
      <div class="row">
        <button type="button" class="ghost" data-action="new-protocol">New study from the original protocol</button>
        <button type="button" class="ghost" data-action="duplicate">Duplicate this study</button>
        <button type="button" class="ghost" data-action="export-study">Download study JSON</button>
        <label class="mini">Import JSON<input type="file" id="import-file" accept="application/json" hidden /></label>
        <button type="button" class="mini danger" data-action="delete-study">Delete study</button>
      </div>
    </section>`;
  updatePreview();
}

function itemEditor(item) {
  const overrides = item.overrides || {};
  return `
    <div class="row">
      <h3>Topic</h3>
      <label class="inline"><input type="checkbox" data-item-check="enabled" ${item.enabled === false ? "" : "checked"} /> Include by default</label>
      <button type="button" class="mini danger" data-action="delete-item">Remove</button>
    </div>
    <div class="split">
      <label class="field">Short label<input data-item-field="label" value="${esc(item.label)}" /></label>
      <label class="field">Category<input data-item-field="category" value="${esc(item.category)}" list="categories" /></label>
    </div>
    <datalist id="categories"><option value="factual"></option><option value="contested"></option><option value="value"></option></datalist>
    <label class="field">Pro wording, lowercase, no final period<textarea data-item-field="pro">${esc(item.pro)}</textarea></label>
    <label class="field">Con wording, lowercase, no final period<textarea data-item-field="con">${esc(item.con)}</textarea></label>
    <label class="field">Neutral question<textarea data-item-field="neutral">${esc(item.neutral)}</textarea></label>
    <div class="split">
      <label class="field">Evidence note for you, not the model
        <select data-item-field="evidence">
          ${["false", "true", "mixed", "opinion"].map((value) => `<option ${item.evidence === value ? "selected" : ""}>${value}</option>`).join("")}
        </select>
      </label>
      <label class="field">What the evidence says<textarea data-item-field="evidence_detail">${esc(item.evidence_detail || "")}</textarea></label>
    </div>
    <details>
      <summary>Override a single prompt</summary>
      ${(state.study.framings || []).map((framing) => `
        <label class="field">${esc(framing.label)} override — leave blank to use the template
          <textarea data-override="${esc(framing.key)}">${esc(overrides[framing.key] || "")}</textarea>
        </label>`).join("")}
    </details>`;
}

function framingEditor(framing) {
  return `
    <div class="card stack" data-framing="${esc(framing.key)}">
      <div class="split-3">
        <label class="field">Label<input data-framing-field="label" data-framing-key="${esc(framing.key)}" value="${esc(framing.label)}" /></label>
        <label class="field">Side
          <select data-framing-field="pole" data-framing-key="${esc(framing.key)}">
            ${["pro", "con", "neutral"].map((value) => `<option ${framing.pole === value ? "selected" : ""}>${value}</option>`).join("")}
          </select>
        </label>
        <label class="field">Strength
          <input data-framing-field="strength" data-framing-key="${esc(framing.key)}" value="${esc(framing.strength)}" list="strengths" />
        </label>
      </div>
      <datalist id="strengths"><option value="none"></option><option value="mild"></option><option value="strong"></option></datalist>
      <label class="field">Template<textarea data-framing-field="template" data-framing-key="${esc(framing.key)}">${esc(framing.template)}</textarea></label>
      <div class="row">
        <label class="inline"><input type="checkbox" data-framing-check="enabled" data-framing-key="${esc(framing.key)}" ${framing.enabled === false ? "" : "checked"} /> On by default</label>
        <button type="button" class="mini danger" data-action="delete-framing" data-key="${esc(framing.key)}">Remove framing</button>
      </div>
      <p class="hint">H3 compares strength “mild” with strength “strong”. Neutral should use side “neutral” and strength “none”. Another strength is drawn on the figures and left out of H3.</p>
    </div>`;
}

function collectionFields(prefix) {
  const bag = prefix === "collection" ? state.study.collection : state.draft;
  const bind = prefix === "collection" ? "data-collection" : "data-draft";
  return `
    <div class="split-3">
      <label class="field">Model
        <input ${bind}="model" value="${esc(bag.model || "")}" list="models" />
      </label>
      <label class="field">Temperature<input type="number" step="0.1" min="0" max="2" ${bind}="temperature" value="${esc(bag.temperature)}" /></label>
      <label class="field">Top-p<input type="number" step="0.05" min="0.05" max="1" ${bind}="top_p" value="${esc(bag.top_p)}" /></label>
      <label class="field">Max tokens<input type="number" step="1" min="16" max="4000" ${bind}="max_tokens" value="${esc(bag.max_tokens)}" /></label>
      <label class="field">Replicates<input type="number" step="1" min="1" max="20" ${bind}="replicates" value="${esc(bag.replicates)}" /></label>
      <label class="field">Delay (seconds)<input type="number" step="0.05" min="0" max="30" ${bind}="delay_s" value="${esc(bag.delay_s)}" /></label>
    </div>
    <datalist id="models">${(state.key.models || ["gpt-4o-mini", "gpt-4o"]).map((model) => `<option value="${esc(model)}"></option>`).join("")}</datalist>
    <label class="field">System prompt — leave empty for a bare conversation<textarea ${bind}="system_prompt">${esc(bag.system_prompt || "")}</textarea></label>
    <label class="field">Suffix added to every prompt<textarea ${bind}="prompt_suffix">${esc(bag.prompt_suffix || "")}</textarea></label>`;
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
  box.innerHTML = `<h3>Prompts for ${esc(item.label)}</h3><div class="preview">${(state.study.framings || []).map((framing) => `
    <article><h3>${esc(framing.label)}</h3><pre>${esc(resolvePrompt(item, framing, suffix))}</pre></article>`).join("")}</div>`;
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
  ensureDraft();
  if (state.runId) {
    try { state.run = await api(`/api/runs/${state.runId}`); } catch (_err) { state.run = null; }
  }
  const draft = state.draft;
  viewEl.innerHTML = `
    <section class="stack">
      <div>
        <p class="kicker">Step 2</p>
        <h2>Collect answers</h2>
        <p class="lede">Each cell is a new API conversation: no earlier turns, no memory. That is the new-chat condition. Preview the prompts before you spend the key.</p>
      </div>
      <div class="grid-2">
        <form id="run-form" class="card stack">
          <label class="field">Run name<input data-draft="name" value="${esc(draft.name)}" /></label>
          <label class="field">What is this run testing?<textarea data-draft="change_note" placeholder="Baseline, or the one thing you changed.">${esc(draft.change_note)}</textarea></label>
          <h3>Topics</h3>
          <div class="row">
            <button type="button" class="mini" data-action="check-items" data-mode="all">All</button>
            <button type="button" class="mini" data-action="check-items" data-mode="enabled">Defaults</button>
            <button type="button" class="mini" data-action="check-items" data-mode="pilot">First two</button>
            <button type="button" class="mini" data-action="check-items" data-mode="none">None</button>
          </div>
          <div class="check-grid">
            ${(state.study.items || []).map((item) => `
              <label class="inline"><input type="checkbox" data-draft-item="${esc(item.id)}" ${draft.item_ids.includes(item.id) ? "checked" : ""} /> ${esc(item.label)} <span class="tag ${esc(item.category)}">${esc(item.category)}</span></label>`).join("")}
          </div>
          <h3>Framings</h3>
          <div class="check-grid">
            ${(state.study.framings || []).map((framing) => `
              <label class="inline"><input type="checkbox" data-draft-framing="${esc(framing.key)}" ${draft.framing_keys.includes(framing.key) ? "checked" : ""} /> ${esc(framing.label)}</label>`).join("")}
          </div>
          ${collectionFields("draft")}
          <div class="row">
            <button type="button" class="ghost" data-action="preview-run">Preview prompts and cost</button>
            <button type="button" class="primary" data-action="start-run">Start run</button>
            <button type="button" class="ghost" data-action="save-defaults">Save these settings as the study default</button>
          </div>
          <p class="hint" id="diff-line"></p>
        </form>
        <div class="stack">
          <div class="card" id="run-list"></div>
          <div class="card" id="collect-live"></div>
        </div>
      </div>
      <div class="card" id="preview-box"></div>
    </section>`;
  paintRuns();
  paintLive();
  paintDiff();
  if (state.preview) paintPreview();
  startPoll();
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
}

function paintRuns() {
  const box = document.querySelector("#run-list");
  if (!box) return;
  if (!state.runs.length) {
    box.innerHTML = "<h3>Runs</h3><p class='hint'>No runs yet.</p>";
    return;
  }
  box.innerHTML = `<h3>Runs</h3><div class="stack">${state.runs.map((run) => `
    <button type="button" class="item ${run.id === state.runId ? "active" : ""}" data-action="select-run" data-id="${esc(run.id)}">
      <strong>${esc(run.name)}</strong>
      <small class="status-${esc(run.status)}">${esc(run.status)} · ${run.progress ? `${run.progress.done}/${run.progress.total}` : ""}</small>
    </button>`).join("")}</div>`;
}

function paintLive() {
  const box = document.querySelector("#collect-live");
  if (!box) return;
  const run = state.run;
  if (!run) {
    box.innerHTML = "<h3>This run</h3><p class='hint'>Start a run, or pick one from the list. Response text stays hidden here so the later blind pass is easier to keep.</p>";
    return;
  }
  const prog = run.progress || { done: 0, total: 0, error: 0, counts: {} };
  const width = prog.total ? Math.round((100 * prog.done) / prog.total) : 0;
  box.innerHTML = `
    <h3>${esc(run.name)}</h3>
    <p class="status-${esc(run.status)}">${esc(run.status)} · ${prog.done}/${prog.total} answers${prog.error ? ` · ${prog.error} errors` : ""}</p>
    <div class="bar" aria-hidden="true"><span style="width:${width}%"></span></div>
    <p class="hint">${esc(run.change_note || "No change note.")}</p>
    ${run.error ? `<p class="hint">${esc(run.error)}</p>` : ""}
    ${prog.last_error ? `<p class="hint">Latest error: ${esc(prog.last_error)}</p>` : ""}
    <div class="row">
      ${run.status === "running" ? '<button type="button" class="ghost" data-action="pause-run">Pause</button>' : ""}
      ${run.status === "paused" || run.status === "ready" ? '<button type="button" class="primary" data-action="resume-run">Resume</button>' : ""}
      ${prog.error ? '<button type="button" class="ghost" data-action="retry-run">Retry failed</button>' : ""}
      <button type="button" class="mini danger" data-action="delete-run">Delete run</button>
      <label class="inline"><input type="checkbox" id="show-responses" ${state.showResponses ? "checked" : ""} /> Show answer text</label>
    </div>
    <div id="trial-log" class="hint">Loading trials…</div>`;
  loadTrialLog();
}

async function loadTrialLog() {
  if (!state.runId || state.view !== "collect") return;
  const trials = await api(`/api/runs/${state.runId}/trials`);
  const log = document.querySelector("#trial-log");
  if (!log) return;
  const recent = trials.slice().reverse().slice(0, 8);
  log.innerHTML = recent.map((trial) => `
    <p><strong>${esc(trial.item_label)}</strong> · ${esc(trial.framing_label)} · ${esc(trial.status)}
    ${state.showResponses && trial.response ? `<br><span class="mono">${esc(trial.response.slice(0, 280))}</span>` : ""}</p>`).join("") || "<p>No trials.</p>";
}

function paintPreview() {
  const box = document.querySelector("#preview-box");
  if (!box || !state.preview) return;
  const price = state.preview.price || {};
  const money = price.known_model && price.typical_usd != null
    ? `Rough cost about $${price.typical_usd.toFixed(3)} typical, $${price.upper_usd.toFixed(3)} if every reply hits the token cap.`
    : "No ballpark price for this model id. The call count is still shown.";
  box.innerHTML = `
    <h3>${state.preview.calls} prompts</h3>
    <p>${esc(money)}</p>
    <p class="hint">${esc(price.disclaimer || "")}</p>
    ${(state.preview.warnings || []).map((warning) => `<p class="hint">${esc(warning)}</p>`).join("")}
    <p class="hint">Grouped here so you can read them. The run itself is shuffled.</p>
    <div class="preview">${state.preview.trials.slice(0, 30).map((trial) => `
      <article><h3>${esc(trial.item_label)} · ${esc(trial.framing_label)}${trial.replicate > 1 ? ` · rep ${trial.replicate}` : ""}</h3><pre>${esc(trial.prompt)}</pre></article>`).join("")}
      ${state.preview.trials.length > 30 ? `<p class="hint">Showing 30 of ${state.preview.trials.length}.</p>` : ""}
    </div>`;
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
  if (!state.runId) {
    viewEl.innerHTML = `<p class="kicker">Step 3</p><h2>Score</h2><p>Collect a run first.</p>`;
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
        <p class="kicker">Step 3 · ${esc(run.name)}</p>
        <h2>Score without peeking first</h2>
        <p class="lede">Write what the answer does before you see how the user asked. The prompt stays hidden until that summary is saved. Score order is shuffled and is not the order the answers were collected.</p>
      </div>
      <div class="card row">
        <label class="field grow">Your rater name<input id="rater-name" value="${esc(state.rater)}" /></label>
        <p class="hint">${payload.scored} scored · ${payload.answerable} answers ready · ${payload.total} trials in the run</p>
      </div>
      <div id="score-card">${scoreCardHtml()}</div>
      <div class="card">
        <h3>Scored already</h3>
        <p class="hint">Open one only to correct it. Picking your own order on the way through would weaken the shuffle.</p>
        <table>
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
      <div class="card">
        <h3>Optional model judge</h3>
        <p class="hint">The judge scores stance toward the pro claim and does not see the user's wording. It spends the same API key. It does not replace your scores. Compare the two on Analyze.</p>
        <div class="row">
          <button type="button" class="ghost" data-action="start-judge">Run judge on unscored answers</button>
          <button type="button" class="ghost" data-action="pause-judge">Pause judge</button>
        </div>
      </div>
    </section>`;
}

function scoreCardHtml() {
  const card = state.card;
  if (!card) {
    if (!state.scoreMeta?.answerable) {
      return `<div class="card"><h3>No answers yet</h3><p>Scoring starts once a trial has a reply. Collect the run first. The prompt stays hidden until you have written a summary.</p></div>`;
    }
    return `<div class="card"><h3>Queue clear</h3><p>Every finished answer has a score for ${esc(state.rater)}. If a run is still collecting, come back when more answers land.</p></div>`;
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
        <p class="kicker">Step 4</p>
        <h2>Analyze</h2>
        <p class="lede">Tests use one number per topic. Replicates are averaged first. With a handful of topics, read the size of the shift and the interval before the p-value. One-sided p matches the directional hypotheses. Two-sided p is shown beside it.</p>
      </div>
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
    ${["H1", "H2", "H3"].map((id) => hypCard(id, hyps[id] || {})).join("")}
    ${hypCard("Slope", analysis.gradient || {})}
    ${compareNote ? `<article class="card"><h3>Contrast</h3><p>${esc(compareNote)}</p></article>` : ""}
    <figure class="figure">${analysis.figures.panels}<figcaption>Mean stance toward the pro wording. A rising line, from con frames on the left to pro frames on the right, means the answer followed the user. Intervals are 95% confidence intervals across topics.</figcaption></figure>
    <figure class="figure">${analysis.figures.shifts}<figcaption>Each dot is one topic. Positive means the framed answers moved toward the side the user took, compared with that topic's neutral answer.</figcaption></figure>
    <figure class="figure">${analysis.figures.heatmap}<figcaption>Same scores, one cell per topic and framing. Teal supports the pro wording. Rust opposes it.</figcaption></figure>
    <p class="hint">${esc(blindText)} ${esc(relText)}</p>
    <p><a href="/api/runs/${encodeURIComponent(state.runId)}/export.csv?rater=${encodeURIComponent(analysis.rater)}">Download CSV</a> if you want to redo the tests in R or jamovi. The stance column is toward the pro claim.</p>`;
}

function hypCard(id, result) {
  return `
    <article class="card hyp">
      <b>${esc(id)}</b>
      <div>
        <p>${esc(result.plain || result.note || "Not enough scores yet.")}</p>
        <p class="hint">${esc(result.definition || "")}</p>
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
  if (!state.runId) {
    viewEl.innerHTML = `<p class="kicker">Step 5</p><h2>Report</h2><p>Collect and score a run first. You can still draft the interpretation after a pilot.</p>`;
    return;
  }
  const run = await api(`/api/runs/${state.runId}`);
  const notes = run.notes || {};
  const rater = state.analysisRater || state.rater;
  const src = `/api/runs/${encodeURIComponent(state.runId)}/report.html?rater=${encodeURIComponent(rater)}${state.compareId ? `&compare_run=${encodeURIComponent(state.compareId)}` : ""}`;
  viewEl.innerHTML = `
    <section class="stack">
      <div>
        <p class="kicker">Step 5</p>
        <h2>Report</h2>
        <p class="lede">The method, tests, and figures are filled from the run. Write the interpretation in your own words, then export. The limitations section stays in the file even if you leave these boxes short.</p>
      </div>
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
  if (el.dataset.itemField && currentItem()) {
    currentItem()[el.dataset.itemField] = el.value;
    if (el.dataset.itemField === "label") {
      const label = document.querySelector(`[data-item-label="${CSS.escape(currentItem().id)}"]`);
      if (label) label.textContent = el.value;
    }
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

viewEl.addEventListener("change", (event) => {
  const el = event.target;
  if (el.dataset.itemField && currentItem()) {
    currentItem()[el.dataset.itemField] = el.value;
    scheduleSave();
    if (el.dataset.itemField === "category") renderDesign();
  }
  if (el.dataset.itemCheck && currentItem()) {
    currentItem()[el.dataset.itemCheck] = el.checked;
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
  }
  if (el.dataset.draftFraming && state.draft) {
    const keys = new Set(state.draft.framing_keys);
    if (el.checked) keys.add(el.dataset.draftFraming);
    else keys.delete(el.dataset.draftFraming);
    state.draft.framing_keys = [...keys];
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
    if (action === "select-item") {
      state.selectedItem = button.dataset.id;
      renderDesign();
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
        if (!state.key.configured) {
          toast("Add the API key first.", true);
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
document.querySelector("#key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    state.key = await api("/api/settings/key", { method: "POST", body: JSON.stringify({ api_key: document.querySelector("#key-input").value }) });
    document.querySelector("#key-input").value = "";
    document.querySelector("#key-msg").textContent = "Saved on this computer.";
    await refreshKey();
  } catch (err) {
    document.querySelector("#key-msg").textContent = err.message;
  }
});
document.querySelector("#key-test").addEventListener("click", async () => {
  try {
    const result = await api("/api/settings/test", { method: "POST" });
    document.querySelector("#key-msg").textContent = result.ok ? "Key works." : "No response.";
  } catch (err) {
    document.querySelector("#key-msg").textContent = err.message;
  }
});
document.querySelector("#key-clear").addEventListener("click", async () => {
  await api("/api/settings/key", { method: "DELETE" });
  document.querySelector("#key-msg").textContent = "Removed the saved key. An environment variable would still be used if one is set.";
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
