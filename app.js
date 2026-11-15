(() => {
  const $ = (id) => document.getElementById(id);

  const API_BASE = (window.SORTI_API_BASE || "").replace(/\/$/, "");
  const USE_SSE = !!window.SORTI_USE_SSE;
  const apiUrl = (path) => API_BASE ? `${API_BASE}${path}` : path;

  const LS_DEV = "SORTI_DEV_MODE";
  const isDevMode = () => (localStorage.getItem(LS_DEV) === "1");

  let refreshing = false;
  let lastBinsSig = "";
  let lastEventsSig = "";

  let es = null;
  let pollTimer = null;
  let lastUpdateTs = 0;

  let refreshTimer = null;
  let pendingRefresh = false;

  let lastIsAdmin = false;

  const LS_THRESH = "sorti_thresholds_v1";
  let thresholds = { warn: 70, critical: 85 };

  const LS_ADMIN = "sorti_admin_key";
  const LS_INGEST = "sorti_ingest_key";
  const adminKey = () => localStorage.getItem(LS_ADMIN) || "";
  const ingestKey = () => localStorage.getItem(LS_INGEST) || "";

  let drawerOpen = false;
  let activeBinId = null;
  let ddLineChart = null;
  let ddPieChart = null;

  // --- Gestione Modale Custom ---
  function openModal({ type, message, title = "Avviso", defaultValue = "" }) {
    return new Promise((resolve) => {
      const modal = $("customModal");
      const titleEl = $("modalTitle");
      const msgEl = $("modalMessage");
      const inputEl = $("modalInput");
      const btnCancel = $("modalBtnCancel");
      const btnOk = $("modalBtnOk");
      const btnX = $("modalCloseX");

      titleEl.textContent = title;
      msgEl.textContent = message;

      if (type === "prompt") {
        inputEl.style.display = "block";
        inputEl.value = defaultValue;
        setTimeout(() => inputEl.focus(), 10);
      } else {
        inputEl.style.display = "none";
        inputEl.value = "";
      }

      btnCancel.style.display = (type === "alert") ? "none" : "";

      modal.showModal();

      const cleanup = () => {
        btnOk.onclick = null;
        btnCancel.onclick = null;
        btnX.onclick = null;
        modal.close();
      };

      btnOk.onclick = () => {
        const res = type === "prompt" ? inputEl.value : true;
        cleanup();
        resolve(res);
      };

      const cancelHandler = () => {
        cleanup();
        resolve(type === "prompt" ? null : false);
      };

      btnCancel.onclick = cancelHandler;
      btnX.onclick = cancelHandler;
      modal.oncancel = (e) => { e.preventDefault(); cancelHandler(); };
    });
  }

  const customAlert = (msg, title) => openModal({ type: "alert", message: msg, title });
  const customPrompt = (msg, def, title) => openModal({ type: "prompt", message: msg, defaultValue: def, title: title || "Inserimento" });
  // ------------------------------

  function safeText(id, txt) {
    const el = $(id);
    if (el) el.textContent = txt;
  }

  function safeHTML(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function loadThresholds() {
    try {
      const raw = localStorage.getItem(LS_THRESH);
      if (!raw) return;
      const obj = JSON.parse(raw);
      const w = Number(obj?.warn);
      const c = Number(obj?.critical);
      if (isFinite(w) && isFinite(c) && w > 0 && c > 0 && w < c && c <= 100) {
        thresholds = { warn: w, critical: c };
      }
    } catch { }
  }

  function saveThresholds() {
    localStorage.setItem(LS_THRESH, JSON.stringify(thresholds));
  }

  function updateThresholdLabels() {
    safeText("warnLabel", `${thresholds.warn}%`);
    safeText("critLabel", `${thresholds.critical}%`);
    const btn = $("btnEditThresholds");
    if (btn) btn.title = `Soglie: attenzione ≥ ${thresholds.warn}% · critico ≥ ${thresholds.critical}%`;
  }

  function setConnState(state) {
    const dot = $("connDot");
    if (!dot) return;
    dot.classList.remove("warn", "bad");
    // polling = funzionamento normale (aggiornamento periodico)
    if (state === "offline") dot.classList.add("bad");
  }

  function setLive(text, state) {
    safeText("liveText", text);
    if (state) setConnState(state);
  }

  function showError(msg) {
    const err = $("errBox");
    if (err) {
      err.style.display = "block";
      err.textContent = msg;
    }
    setLive("Offline", "offline");
  }

  function clearError() {
    const err = $("errBox");
    if (err) {
      err.style.display = "none";
      err.textContent = "";
    }
  }

  function formatWeight(g) {
    const n = Number(g || 0);
    if (!isFinite(n)) return "—";
    if (n >= 1000) {
      const kg = n / 1000;
      const txt = (kg < 100 ? kg.toFixed(1) : Math.round(kg).toString());
      return txt + " kg";
    }
    return Math.round(n) + " g";
  }

  const formatCO2 = formatWeight;

  function numOrNull(v) {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }

  function clampPct(n) {
    return Math.max(0, Math.min(100, Number(n || 0)));
  }

  function isoToDate(s) {
    if (!s) return null;
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d;
  }

  function isoToNice(s) {
    const d = isoToDate(s);
    if (!d) return (s || "—");
    return d.toLocaleString();
  }

  function timeAgo(iso) {
    const d = isoToDate(iso);
    if (!d) return "—";
    const now = new Date();
    let diff = Math.floor((now - d) / 1000);
    if (!isFinite(diff)) return "—";
    if (diff < 0) diff = 0;

    if (diff < 10) return "adesso";
    if (diff < 60) return `${diff}s fa`;
    const m = Math.floor(diff / 60);
    if (m < 60) return `${m} min fa`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} h fa`;
    const days = Math.floor(h / 24);
    if (days === 1) return "ieri";
    if (days < 7) return `${days} gg fa`;
    const w = Math.floor(days / 7);
    if (w < 5) return `${w} sett fa`;
    const mo = Math.floor(days / 30);
    if (mo < 12) return `${mo} mesi fa`;
    const y = Math.floor(days / 365);
    return `${y} anni fa`;
  }

  function shortId(s) {
    if (!s) return "—";
    const str = String(s);
    if (str.length <= 10) return str;
    return str.slice(0, 8) + "…" + str.slice(-6);
  }

  function getCompartments(obj) {
    const arr = obj?.compartments;
    return Array.isArray(arr) ? arr : [];
  }

  function getSensorFillPercent(obj) {
    if (!obj || typeof obj !== "object") return null;
    const keys = ["sensor_fill_percent", "fill_percent_sensor", "ultrasonic_fill_percent"];
    for (const k of keys) {
      const n = numOrNull(obj?.[k]);
      if (n !== null) return clampPct(n);
    }
    return null;
  }

  function getSensorState(obj) {
    const keys = ["sensor_level_state", "level_state", "ultrasonic_state"];
    for (const k of keys) {
      const v = obj?.[k];
      if (typeof v === "string" && v.trim()) return v.trim().toUpperCase();
    }
    return null;
  }

  function getSensorDistanceCm(obj) {
    const keys = ["sensor_distance_cm", "distance_cm", "ultrasonic_distance_cm"];
    for (const k of keys) {
      const n = numOrNull(obj?.[k]);
      if (n !== null) return n;
    }
    return null;
  }

  function getFillSource(obj) {
    const src = typeof obj?.fill_source === "string" ? obj.fill_source.trim().toLowerCase() : "";
    if (src) return src;
    return getCompartments(obj).length > 0 ? "sensor" : "estimated";
  }

  function getFillPercent(obj) {
    const n = numOrNull(obj?.fill_percent);
    if (n !== null) return clampPct(n);

    const sensor = getSensorFillPercent(obj);
    if (sensor !== null) return sensor;

    const comps = getCompartments(obj);
    if (comps.length > 0) {
      let num = 0;
      let den = 0;
      for (const c of comps) {
        const fill = getSensorFillPercent(c);
        const cap = numOrNull(c?.capacity_percent);
        if (fill !== null && cap !== null && cap > 0) {
          num += fill * cap;
          den += cap;
        }
      }
      if (den > 0) return clampPct(num / den);
    }

    const est = numOrNull(obj?.estimated_fill_percent);
    if (est !== null) return clampPct(est);

    return 0;
  }

  function formatDistanceCm(v) {
    const n = numOrNull(v);
    return n === null ? "—" : `${n.toFixed(1)} cm`;
  }

  function countCompartmentStates(obj) {
    const comps = getCompartments(obj);
    let full = 0, med = 0, empty = 0, fail = 0;
    for (const c of comps) {
      const st = getSensorState(c);
      if (st === "FULL") full++;
      else if (st === "MEDIUM") med++;
      else if (st === "EMPTY") empty++;
      else fail++;
    }
    return { full, med, empty, fail, total: comps.length };
  }

  function extraHeaders() {
    return (window.SORTI_EXTRA_HEADERS && typeof window.SORTI_EXTRA_HEADERS === "object")
      ? window.SORTI_EXTRA_HEADERS
      : {};
  }

  async function fetchJSON(url, opts = {}) {
    opts.headers = Object.assign({}, extraHeaders(), opts.headers || {});
    const res = await fetch(url, opts);
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}\n${text}`);
    try { return JSON.parse(text); }
    catch { throw new Error(`Risposta non-JSON da ${url}\n${text}`); }
  }

  async function downloadFile(url, filename, headers) {
    const res = await fetch(url, { headers: Object.assign({}, extraHeaders(), headers) });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`${res.status} ${res.statusText}\n${t}`);
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  function statusOf(fill) {
    const f = Number(fill || 0);
    if (f >= thresholds.critical) return "crit";
    if (f >= thresholds.warn) return "warn";
    return "ok";
  }

  const STATUS_LABEL = { ok: "Regolare", warn: "Attenzione", crit: "Critico" };

  function barColor(fill) {
    const s = statusOf(fill);
    if (s === "crit") return "var(--crit)";
    if (s === "warn") return "var(--warn)";
    return "var(--brand-grad)";
  }

  function fillBadge(fill) {
    const s = statusOf(fill);
    return `<span class="badge ${s}">${STATUS_LABEL[s]}</span>`;
  }

  // Stato operativo del cestino: conta lo scomparto più pieno
  // (uno scomparto pieno blocca quella frazione anche se il totale è basso)
  function binStatusFill(b) {
    let worst = getFillPercent(b);
    for (const c of getCompartments(b)) {
      const f = getSensorFillPercent(c);
      if (f !== null && f > worst) worst = f;
    }
    return worst;
  }

  function binGlyphHTML(fill, statusFill = fill, key = "") {
    const f = clampPct(fill);
    const anim = key ? ` data-k="${escapeHtml(key)}" data-v="${f}"` : "";
    return `<div class="binGlyph ${statusOf(statusFill)}" aria-hidden="true"><div class="binGlyphFill"${anim} style="height:${f}%"></div></div>`;
  }

  // Colori per frazione, ispirati alla raccolta differenziata italiana
  // Colori delle frazioni come sul cestino Sorti (ruota e icone laterali)
  const MATERIAL_RULES = [
    [/plast|pet|hdpe|ldpe/i, "#f2b705"],
    [/cart|paper|card|cellul/i, "#2f6fd8"],
    [/vetr|glass/i, "#1e8c45"],
    [/organ|umid|food|bio|compost/i, "#c62832"],
    [/metal|allum|alumin|latt|can|accia|steel/i, "#4fb3e0"],
    [/indiff|secco|resid|general|other|altro|mixed/i, "#5b5f8a"],
    [/raee|elettr|batter|pil/i, "#c2410c"],
    [/tess|textile|abbig/i, "#a855f7"],
  ];
  const MATERIAL_FALLBACK = ["#4cb82e", "#09182F", "#0ea5b7", "#7c6cf2", "#e0729a", "#94a3b8"];
  const materialColorCache = {};
  function materialColor(name) {
    const key = String(name || "").trim().toLowerCase();
    if (materialColorCache[key]) return materialColorCache[key];
    let col = null;
    for (const [re, c] of MATERIAL_RULES) if (re.test(key)) { col = c; break; }
    if (!col) {
      let h = 0;
      for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      col = MATERIAL_FALLBACK[h % MATERIAL_FALLBACK.length];
    }
    materialColorCache[key] = col;
    return col;
  }

  function materialHTML(name) {
    const n = name || "—";
    return `<span class="matCell"><span class="matDot" style="background:${materialColor(n)}"></span>${escapeHtml(n)}</span>`;
  }

  function priorityOf(fill) {
    const f = Number(fill || 0);
    if (f >= thresholds.critical) return 2;
    if (f >= thresholds.warn) return 1;
    return 0;
  }

  function compartmentsSorted(obj) {
    return getCompartments(obj)
      .slice()
      .sort((a, b) => Number(a?.compartment_id || 0) - Number(b?.compartment_id || 0));
  }

  // Mini visualizzazione a colonne: uno "scomparto" per colonna
  function compStripHTML(obj, keyPrefix = "") {
    const comps = compartmentsSorted(obj);
    if (!comps.length) return "";
    return `<div class="compStrip">${comps.map(c => {
      const fill = getSensorFillPercent(c);
      const label = c?.label || `Scomparto ${c?.compartment_id ?? "—"}`;
      if (fill === null) {
        return `<span class="compCol nodata" title="${escapeHtml(label)}: nessun dato"></span>`;
      }
      const anim = keyPrefix ? ` data-k="${escapeHtml(`${keyPrefix}|c${c?.compartment_id}`)}" data-v="${fill}"` : "";
      return `<span class="compCol ${statusOf(fill)}" title="${escapeHtml(label)}: ${Math.round(fill)}%"><i${anim} style="height:${fill}%"></i></span>`;
    }).join("")}</div>`;
  }

  function compSummaryHTML(obj) {
    const comps = compartmentsSorted(obj);
    if (!comps.length) {
      return `<span class="compNone">${getFillSource(obj) === "sensor" ? "Nessun dato sensori" : "Stima da peso"}</span>`;
    }
    let crit = 0, warn = 0;
    for (const c of comps) {
      const f = getSensorFillPercent(c);
      if (f === null) continue;
      const s = statusOf(f);
      if (s === "crit") crit++;
      else if (s === "warn") warn++;
    }
    const parts = [];
    if (crit) parts.push(`<b style="color:var(--crit-ink)">${crit} critic${crit === 1 ? "o" : "i"}</b>`);
    if (warn) parts.push(`<b style="color:var(--warn-ink)">${warn} in attenzione</b>`);
    if (!parts.length) parts.push("tutti regolari");
    return `
      <div class="compInfo">
        ${compStripHTML(obj, `${obj?.bin_id}|t`)}
        <div class="compText"><b>${comps.length}</b> scompart${comps.length === 1 ? "o" : "i"}<br>${parts.join(" · ")}</div>
      </div>`;
  }

  function renderQuickAlerts(bins){
    const warn = thresholds.warn;
    const crit = thresholds.critical;

    const criticalCompartments = [];
    const warnCompartments = [];

    for (const b of bins) {
      const comps = Array.isArray(b.compartments) ? b.compartments : [];

      for (const c of comps) {
        const fill = Number(c?.sensor_fill_percent ?? 0);
        const item = {
          bin_id: b.bin_id,
          compartment_id: c.compartment_id,
          label: c.label || `Scomparto ${c.compartment_id}`,
          fill
        };

        if (fill >= crit) {
          criticalCompartments.push(item);
        } else if (fill >= warn) {
          warnCompartments.push(item);
        }
      }
    }

    const summary = $("alertSummary");
    const totalAlerts = criticalCompartments.length + warnCompartments.length;

    if (criticalCompartments.length > 0){
      summary.className = "chip bad";
      summary.textContent = `${criticalCompartments.length} scompart${criticalCompartments.length === 1 ? "o critico" : "i critici"}` +
        (warnCompartments.length ? ` · ${warnCompartments.length} in attenzione` : "");
    } else if (warnCompartments.length > 0){
      summary.className = "chip warn";
      summary.textContent = `${warnCompartments.length} scompart${warnCompartments.length === 1 ? "o" : "i"} in attenzione`;
    } else {
      summary.className = "chip ok";
      summary.textContent = "Tutto regolare";
    }

    const list = $("alertsList");
    if (totalAlerts === 0){
      list.style.display = "none";
      list.innerHTML = "";
      return;
    }

    const items = [
      ...criticalCompartments.map(x => ({ ...x, _p: "crit" })),
      ...warnCompartments.map(x => ({ ...x, _p: "warn" })),
    ].sort((a, b) => b.fill - a.fill);

    const MAX = 6;
    const html = items.slice(0, MAX).map(x => `
      <button type="button" class="alertItem ${x._p}" data-bin="${escapeHtml(x.bin_id)}" title="Apri dettagli cestino">
        <div class="aMain">
          <div class="aBin">${escapeHtml(x.bin_id)}</div>
          <div class="aComp">${escapeHtml(x.label)} · ${x._p === "crit" ? "critico" : "attenzione"}</div>
        </div>
        <div class="aPct">${Math.round(x.fill)}%</div>
      </button>
    `).join("") + (items.length > MAX ? `<div class="alertMore">+${items.length - MAX} altri</div>` : "");

    list.style.display = "grid";
    list.innerHTML = html;
  }

  function touchBinRow(binId, isoTs) {
    if (!binId) return;

    const tr = document.getElementById(`binrow-${binId}`);
    if (tr) {
      const tdLast = tr.querySelector('[data-col="last"]');
      if (tdLast) {
        tdLast.title = isoToNice(isoTs);
        tdLast.textContent = timeAgo(isoTs);
      }
    }

    const card = document.getElementById(`bincard-${binId}`);
    if (card) {
      const el = card.querySelector('[data-col="last"]');
      if (el) {
        el.title = isoToNice(isoTs);
        el.textContent = timeAgo(isoTs);
      }
    }

    if (drawerOpen && activeBinId === binId) {
      safeText("ddLast", timeAgo(isoTs));
      const ddLast = $("ddLast");
      if (ddLast) ddLast.title = isoToNice(isoTs);
    }
  }

  function prependRecentEvent(payload) {
    if (!payload) return;
    if (!adminKey()) return;
    if (!lastIsAdmin) return;

    const eventsBody = $("eventsBody");
    const eventsEmpty = $("eventsEmpty");
    if (!eventsBody || !eventsEmpty) return;

    eventsEmpty.style.display = "none";
    eventsEmpty.textContent = "";

    const ts = payload.ts || new Date().toISOString();
    const whenHuman = timeAgo(ts);
    const whenTitle = isoToNice(ts);
    const binId = payload.bin_id || "—";
    const material = payload.material || "—";
    const w = payload.weight_g;
    const co2 = payload.co2_saved_g;
    const eid = payload.event_id ?? "";

    if (eid) {
      const existing = eventsBody.querySelector(`tr[data-eid="${CSS.escape(String(eid))}"]`);
      if (existing) return;
    }

    const rowHtml = `
      <tr data-eid="${String(eid)}">
        <td class="muted" title="${whenTitle}">${whenHuman}</td>
        <td><b>${escapeHtml(binId)}</b></td>
        <td>${materialHTML(material)}</td>
        <td class="right">${formatWeight(w)}</td>
        <td class="right">${formatCO2(co2)}</td>
        <td class="mono" style="text-align:right" title="${escapeHtml(String(eid))}">${shortId(eid)}</td>
      </tr>
    `;

    eventsBody.insertAdjacentHTML("afterbegin", rowHtml);

    const rows = eventsBody.querySelectorAll("tr");
    for (let i = 20; i < rows.length; i++) rows[i].remove();

    lastEventsSig = "LIVE";

    if (drawerOpen && activeBinId === binId) {
      const ddBody = $("ddEventsBody");
      const ddEmpty = $("ddEventsEmpty");
      if (!ddBody || !ddEmpty) return;

      ddEmpty.style.display = "none";
      ddEmpty.textContent = "";

      const row = `
        <tr data-eid="${String(eid)}">
          <td class="muted" title="${whenTitle}">${whenHuman}</td>
          <td>${materialHTML(material)}</td>
          <td class="right">${formatWeight(w)}</td>
          <td class="right">${formatCO2(co2)}</td>
          <td class="mono" style="text-align:right" title="${escapeHtml(String(eid))}">${shortId(eid)}</td>
        </tr>
      `;
      ddBody.insertAdjacentHTML("afterbegin", row);
      const rows2 = ddBody.querySelectorAll("tr");
      for (let i = 20; i < rows2.length; i++) rows2[i].remove();
    }
  }

  function scheduleRefresh(ms = 800) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, ms);
  }

  const LS_VIEW = "sorti_bins_view";
  const binsView = () => (localStorage.getItem(LS_VIEW) === "table" ? "table" : "tiles");

  function syncResponsiveBinsView() {
    const mobile = window.matchMedia("(max-width: 820px)").matches;
    const view = mobile ? "tiles" : binsView();
    const binsTableWrap = $("binsBody")?.closest(".tableWrap");
    const binsCards = $("binsCards");

    if (binsTableWrap) binsTableWrap.style.display = view === "table" ? "block" : "none";
    if (binsCards) binsCards.style.display = view === "tiles" ? "grid" : "none";
    document.querySelectorAll(".segBtn[data-view]").forEach(btn => {
      btn.classList.toggle("active", btn.getAttribute("data-view") === binsView());
    });
  }

  // --- Tema & grafici ---
  const LS_THEME = "sorti_theme";
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const FONT = '"Plus Jakarta Sans", Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

  function chartTheme() {
    return {
      text: cssVar("--muted") || "#66766f",
      strong: cssVar("--text") || "#0f1e1b",
      grid: cssVar("--border") || "#e2e8e6",
      surface: cssVar("--surface") || "#fff",
      brand: cssVar("--brand") || "#14a37f",
    };
  }

  function applyChartDefaults() {
    const t = chartTheme();
    Chart.defaults.color = t.text;
    Chart.defaults.borderColor = t.grid;
    Chart.defaults.font.family = FONT;
    Chart.defaults.font.size = 12;
    Chart.defaults.plugins.tooltip.backgroundColor = "rgba(15,30,27,.92)";
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.cornerRadius = 8;
    Chart.defaults.plugins.tooltip.titleFont = { family: FONT, weight: "700", size: 12 };
    Chart.defaults.plugins.tooltip.bodyFont = { family: FONT, weight: "600", size: 12 };
    Chart.defaults.plugins.tooltip.displayColors = false;
  }
  applyChartDefaults();

  // Riempimento a gradiente con i colori Sorti
  function areaGradient(ctx) {
    const { chart } = ctx;
    const { ctx: c, chartArea } = chart;
    if (!chartArea) return "rgba(126,218,85,.15)";
    const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, "rgba(126,218,85,.38)");
    g.addColorStop(1, "rgba(126,218,85,0)");
    return g;
  }
  function lineGradient(ctx) {
    const { chart } = ctx;
    const { ctx: c, chartArea } = chart;
    if (!chartArea) return "#5fc63b";
    const g = c.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
    g.addColorStop(0, "#4cb82e");
    g.addColorStop(1, "#7EDA55");
    return g;
  }

  function formatDayLabel(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : isoToDate(day);
    if (!d) return day;
    return d.toLocaleDateString("it-IT", { day: "2-digit", month: "short" });
  }

  const donutCenterText = {
    id: "donutCenterText",
    afterDraw(chart) {
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      if (chart.config?.type !== "doughnut") return;

      const ds = chart.data?.datasets?.[0];
      if (!ds || !Array.isArray(ds.data) || !ds.data.length) return;

      const totalG = ds.data.reduce((s, v) => s + (Number(v) || 0), 0);
      const totalTxt = formatWeight(totalG);
      const t = chartTheme();

      const x = (chartArea.left + chartArea.right) / 2;
      const y = (chartArea.top + chartArea.bottom) / 2;

      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      ctx.font = `600 11px ${FONT}`;
      ctx.fillStyle = t.text;
      ctx.fillText("TOTALE", x, y - 11);

      ctx.font = `800 18px ${FONT}`;
      ctx.fillStyle = t.strong;
      ctx.fillText(totalTxt, x, y + 9);

      ctx.restore();
    }
  };
  Chart.register(donutCenterText);

  let lineChart = null;
  let doughnutChart = null;

  function lineConfig(label, withTooltip = true) {
    const t = chartTheme();
    return {
      type: "line",
      data: {
        labels: [], datasets: [{
          label,
          data: [],
          borderWidth: 2.5,
          borderColor: lineGradient,
          backgroundColor: areaGradient,
          tension: .35,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: "#09182F",
          pointHoverBorderColor: t.surface,
          pointHoverBorderWidth: 2,
          fill: true
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: withTooltip ? { callbacks: { label: (ctx) => `CO₂ risparmiata: ${formatCO2(ctx.parsed.y)}` } } : {}
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { maxRotation: 0, autoSkipPadding: 18, callback(v) { return formatDayLabel(this.getLabelForValue(v)); } }
          },
          y: {
            beginAtZero: true,
            border: { display: false },
            grid: { color: t.grid },
            ticks: { maxTicksLimit: 5, padding: 8, callback: (v) => formatCO2(v) }
          }
        }
      }
    };
  }

  function doughnutConfig() {
    const t = chartTheme();
    return {
      type: "doughnut",
      data: {
        labels: [], datasets: [{
          data: [],
          backgroundColor: [],
          borderColor: t.surface,
          borderWidth: 3,
          hoverOffset: 6,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: "70%",
        layout: { padding: 6 },
        plugins: {
          legend: {
            position: "bottom",
            labels: { usePointStyle: true, pointStyle: "rectRounded", boxWidth: 10, boxHeight: 10, padding: 14, font: { weight: "600" } }
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const total = ctx.dataset.data.reduce((s, v) => s + (Number(v) || 0), 0);
                const pct = total > 0 ? Math.round((ctx.parsed / total) * 100) : 0;
                return `${ctx.label}: ${formatWeight(ctx.parsed)} (${pct}%)`;
              }
            }
          },
          donutCenterText: {}
        }
      }
    };
  }

  function setDoughnutData(chart, mats) {
    chart.data.labels = mats.map(r => r.material);
    chart.data.datasets[0].data = mats.map(r => Number(r.weight_g || 0));
    chart.data.datasets[0].backgroundColor = mats.map(r => materialColor(r.material));
    chart.update();
  }

  function initCharts() {
    lineChart = new Chart($("co2Line").getContext("2d"), lineConfig("CO₂"));
    doughnutChart = new Chart($("matPie").getContext("2d"), doughnutConfig());
    ddLineChart = new Chart($("ddLine").getContext("2d"), lineConfig("CO₂ cestino"));
    ddPieChart = new Chart($("ddPie").getContext("2d"), doughnutConfig());
  }

  function retintCharts() {
    applyChartDefaults();
    const t = chartTheme();
    for (const ch of [lineChart, ddLineChart]) {
      if (!ch) continue;
      ch.options.scales.y.grid.color = t.grid;
      ch.options.scales.x.ticks.color = t.text;
      ch.options.scales.y.ticks.color = t.text;
      ch.data.datasets[0].pointHoverBorderColor = t.surface;
      ch.update("none");
    }
    for (const ch of [doughnutChart, ddPieChart]) {
      if (!ch) continue;
      ch.data.datasets[0].borderColor = t.surface;
      ch.options.plugins.legend.labels.color = t.text;
      ch.update("none");
    }
  }

  function setTheme(theme, persist = true) {
    document.documentElement.setAttribute("data-theme", theme);
    if (persist) localStorage.setItem(LS_THEME, theme);
    retintCharts();
  }

  // --- Periodo selezionato ---
  // Il backend accetta il periodo solo in giorni (dati aggregati per giorno).
  // "Ultima ora" e "Ultime 24 ore" si calcolano dai singoli conferimenti
  // (disponibili con la Admin key). Per le 24 ore i totali vengono dal server
  // (days=1 = ultime 24 ore esatte); i conferimenti servono solo per l'andamento orario.
  // NB: oggi /api/dashboard restituisce al massimo 20 conferimenti e /api/bins/{id} 200:
  // se l'evento più vecchio ricevuto è dentro la finestra, il dato è parziale.
  const FINE_EVENTS_LIMIT = 1000;
  function getRange() {
    const v = String($("rangeSel")?.value || "30");
    if (v === "1h") return { key: v, days: 1, hours: 1, fine: true, label: "Ultima ora", bucketMin: 5 };
    if (v === "24h") return { key: v, days: 1, hours: 24, fine: true, label: "Ultime 24 ore", bucketMin: 60 };
    const d = Math.max(1, Math.min(365, Number(v) || 30));
    return { key: v, days: d, hours: null, fine: false, label: `Ultimi ${d} giorni`, bucketMin: null };
  }

  // Aggrega i conferimenti nella finestra [ora - hours, ora]
  function aggregateEvents(events, range, now = Date.now()) {
    const cutoff = now - range.hours * 3600000;
    const bucketMs = range.bucketMin * 60000;
    const start = Math.floor(cutoff / bucketMs) * bucketMs;
    const nB = Math.max(1, Math.ceil((now + 1 - start) / bucketMs));
    const buckets = Array.from({ length: nB }, (_, i) => ({ t: start + i * bucketMs, weight_g: 0, co2_g: 0, count: 0 }));
    const byMat = new Map();
    const byBin = new Map();
    let w = 0, co2 = 0, n = 0, oldest = Infinity;

    for (const e of events || []) {
      const t = isoToDate(e.ts)?.getTime();
      if (!t) continue;
      if (t < oldest) oldest = t;
      if (t < cutoff || t > now + 60000) continue;
      const ew = Number(e.weight_g || 0), ec = Number(e.co2_saved_g || 0);
      w += ew; co2 += ec; n++;
      const bi = Math.min(nB - 1, Math.max(0, Math.floor((t - start) / bucketMs)));
      buckets[bi].weight_g += ew; buckets[bi].co2_g += ec; buckets[bi].count++;
      const mk = String(e.material || "non specificato").trim().toLowerCase();
      const m = byMat.get(mk) || { material: mk, weight_g: 0, co2_saved_g: 0 };
      m.weight_g += ew; m.co2_saved_g += ec; byMat.set(mk, m);
      const bk = String(e.bin_id || "—");
      const bb = byBin.get(bk) || { weight_g: 0, co2_g: 0, count: 0 };
      bb.weight_g += ew; bb.co2_g += ec; bb.count++; byBin.set(bk, bb);
    }
    const total = (events || []).length;
    // Completo se abbiamo visto un evento più vecchio della finestra o se il server ha restituito meno del limite
    // Completo solo se abbiamo ricevuto almeno un evento più vecchio della finestra
    // (oppure nessun evento): il server può troncare la lista sotto il limite richiesto.
    const complete = total === 0 || oldest < cutoff;
    const label = (t) => new Date(t).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    return {
      weight_g: w, co2_g: co2, count: n, complete, fetched: total, cutoff, now,
      buckets: buckets.map(b => ({ ...b, label: label(b.t) })),
      materials: [...byMat.values()].sort((a, b) => b.weight_g - a.weight_g),
      byBin,
    };
  }

  async function fetchDashboard(days, eventsLimit = 20) {
    const d = Math.max(1, Math.min(365, Number(days || 30)));
    const url = apiUrl(`/api/dashboard?days=${encodeURIComponent(d)}&events_limit=${encodeURIComponent(eventsLimit)}`);
    const headers = {};
    if (adminKey()) headers["X-API-Key"] = adminKey();
    return await fetchJSON(url, { headers });
  }

  async function fetchBinDetail(binId, days, eventsLimit = 20) {
    const d = Math.max(1, Math.min(365, Number(days || 30)));
    const url = apiUrl(`/api/bins/${encodeURIComponent(binId)}?days=${encodeURIComponent(d)}&events_limit=${encodeURIComponent(eventsLimit)}`);
    const headers = {};
    if (adminKey()) headers["X-API-Key"] = adminKey();
    return await fetchJSON(url, { headers });
  }

  function startPollingFallback() {
    if (pollTimer) return;
    setLive("Live · 10s", "polling");
    pollTimer = setInterval(() => refresh(), 10000);
  }

  function startSSE() {
    if (!USE_SSE) {
      startPollingFallback();
      return;
    }

    try {
      if (es) es.close();
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

      es = new EventSource(apiUrl("/api/stream"));

      es.addEventListener("hello", () => {
        setLive("Realtime", "realtime");
        refresh();
      });

      es.addEventListener("update", (ev) => {
        const now = Date.now();
        if (now - lastUpdateTs < 120) return;
        lastUpdateTs = now;

        setLive("Realtime", "realtime");

        let payload = null;
        try { payload = ev?.data ? JSON.parse(ev.data) : null; } catch { payload = null; }

        const binId = payload?.bin_id;
        const ts = payload?.ts || new Date().toISOString();
        if (binId) touchBinRow(binId, ts);

        if (payload?.type === "event") {
          prependRecentEvent(payload);
        }

        if (drawerOpen && activeBinId && activeBinId === binId) {
          scheduleBinRefresh(900);
        }

        const t = String(payload?.type || "update");
        const delay =
          (t === "config" || t === "empty" || t === "rotate_key") ? 350 :
          (t === "event") ? 650 :
          800;

        scheduleRefresh(delay);
      });

      es.onerror = () => {
        try { es.close(); } catch { }
        es = null;
        startPollingFallback();
      };
    } catch {
      startPollingFallback();
    }
  }

  function openDrawer() {
    drawerOpen = true;
    $("drawer").classList.add("open");
    $("drawerOverlay").classList.add("open");
    $("drawer").setAttribute("aria-hidden", "false");
    $("drawerOverlay").setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function closeDrawer() {
    drawerOpen = false;
    activeBinId = null;
    $("drawer").classList.remove("open");
    $("drawerOverlay").classList.remove("open");
    $("drawer").setAttribute("aria-hidden", "true");
    $("drawerOverlay").setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  let binRefreshTimer = null;
  function scheduleBinRefresh(ms = 900) {
    if (!drawerOpen || !activeBinId) return;
    if (binRefreshTimer) clearTimeout(binRefreshTimer);
    binRefreshTimer = setTimeout(async () => {
      binRefreshTimer = null;
      await openBinDrawer(activeBinId, { soft: true });
    }, ms);
  }

  function setDrawerGlyph(fill, statusFill = fill) {
    const g = $("ddGlyph");
    if (!g) return;
    const f = clampPct(fill);
    g.className = `binGlyph lg ${statusOf(statusFill)}`;
    const inner = g.querySelector(".binGlyphFill");
    if (inner) inner.style.height = `${f}%`;
  }

  function ddSetLoading(binId) {
    safeText("ddTitle", `Cestino ${binId}`);
    safeText("ddSub", "Caricamento…");
    setDrawerGlyph(0);
    safeText("ddFill", "—");
    safeText("ddWeight", "—");
    safeText("ddCap", "—");
    safeText("ddLast", "—");
    safeText("ddRangeLabel", getRange().label);

    const body = $("ddCompartmentsBody");
    if (body) body.innerHTML = "";

    const empty = $("ddCompartmentsEmpty");
    if (empty) {
      empty.style.display = "none";
      empty.textContent = "";
    }

    const ddEventsEmpty = $("ddEventsEmpty");
    if (ddEventsEmpty) {
      ddEventsEmpty.style.display = "none";
      ddEventsEmpty.textContent = "";
    }

    const ddEventsBody = $("ddEventsBody");
    if (ddEventsBody) ddEventsBody.innerHTML = "";

    const ddLineEmpty = $("ddLineEmpty");
    if (ddLineEmpty) ddLineEmpty.style.display = "none";

    const ddPieEmpty = $("ddPieEmpty");
    if (ddPieEmpty) ddPieEmpty.style.display = "none";
  }

  function renderCompartments(bin) {
    const comps = getCompartments(bin);
    const body = $("ddCompartmentsBody");
    const empty = $("ddCompartmentsEmpty");
    if (!body || !empty) return;

    if (!comps.length) {
      body.innerHTML = "";
      empty.style.display = "block";
      empty.textContent = "Nessun dato sugli scomparti disponibile per questo cestino.";
      return;
    }

    empty.style.display = "none";
    empty.textContent = "";

    body.innerHTML = compartmentsSorted(bin).map(c => {
      const fill = getSensorFillPercent(c);
      const state = getSensorState(c);
      const cap = numOrNull(c?.capacity_percent);
      const st = fill !== null ? statusOf(fill) : "nodata";
      const badge = fill !== null ? fillBadge(fill) : `<span class="badge nodata">Nessun dato</span>`;
      const meta = cap !== null ? `quota ${cap.toFixed(0)}%` : "";

      return `
        <div class="compCard">
          <div class="compTank ${st}" aria-hidden="true"><i data-k="${escapeHtml(`dd|${bin?.bin_id}|${c?.compartment_id}`)}" data-v="${fill ?? 0}" style="height:${fill ?? 0}%"></i><span class="wave"></span></div>
          <div class="compBody">
            <div>
              <div class="compTitle" title="${escapeHtml(c.label || `Scomparto ${c.compartment_id}`)}">${escapeHtml(c.label || `Scomparto ${c.compartment_id}`)}</div>
              <div class="compMeta" title="${escapeHtml(state ? "Sensore: " + state : "")}">#${escapeHtml(c.compartment_id ?? "—")}${meta ? " · " + meta : ""}</div>
            </div>
            <div class="compPct">${fill !== null ? `${Math.round(fill)}%` : "—"}</div>
            <div>${badge}</div>
          </div>
        </div>
      `;
    }).join("");
    animateLevels(body);
  }

  async function openBinDrawer(binId, { soft = false } = {}) {
    try {
      activeBinId = binId;
      const range = getRange();
      const days = range.days;
      const wantFine = range.fine && !!adminKey();

      if (!soft) {
        ddSetLoading(binId);
        openDrawer();
      }

      const data = await fetchBinDetail(binId, days, wantFine ? FINE_EVENTS_LIMIT : 20);
      const ddAgg = (wantFine && data?.is_admin) ? aggregateEvents(data?.recent_events || [], range) : null;
      const b = data?.bin || {};

      const fill = getFillPercent(b);
      const wG = Number(b.current_weight_g || 0);
      const capG = Number(b.capacity_g || 0);
      const lastSeen = b.last_seen || null;
      const fillSource = getFillSource(b);
      const comps = getCompartments(b);

      safeText("ddTitle", `Cestino ${binId}`);
      const sFill = binStatusFill(b);
      setDrawerGlyph(fill, sFill);
      safeText("ddFill", `${Math.round(fill)}%`);
      safeHTML("ddFillHint", `${fillBadge(sFill)} <span>${fillSource === "sensor" ? "da sensori" : "stimato"}</span>`);
      safeText("ddWeight", formatWeight(wG));

      const capKg = capG / 1000;
      safeText("ddCap", isFinite(capKg) ? (capKg < 100 ? capKg.toFixed(1) : Math.round(capKg).toString()) + " kg" : "—");

      safeText("ddLast", timeAgo(lastSeen));
      const ddLast = $("ddLast");
      if (ddLast) ddLast.title = isoToNice(lastSeen);

      safeHTML(
        "ddSub",
        `${fillBadge(sFill)} <span>Ultimo segnale ${escapeHtml(timeAgo(lastSeen))}</span> · <span>${fillSource === "sensor" ? `${comps.length} scompart${comps.length === 1 ? "o" : "i"}` : "stima peso/capacità"}</span>`
      );

      safeText("ddRangeLabel", range.label);

      renderCompartments(b);

      const daily = data?.daily || [];
      const ddSeries = ddAgg
        ? ddAgg.buckets.map(x => ({ label: x.label, v: x.co2_g }))
        : (range.hours === 1 ? [] : daily.map(r => ({ label: r.day, v: Number(r.co2_saved_g || 0) })));
      const ddLineEmpty = $("ddLineEmpty");
      if (ddLineEmpty) {
        ddLineEmpty.style.display = ddSeries.some(r => r.v > 0) ? "none" : "block";
        ddLineEmpty.textContent = (range.hours === 1 && !ddAgg)
          ? "Per la vista \"Ultima ora\" serve la Admin key."
          : "Nessun dato nel periodo selezionato.";
      }
      ddLineChart.data.labels = ddSeries.map(r => r.label);
      ddLineChart.data.datasets[0].data = ddSeries.map(r => r.v);
      ddLineChart.update();

      const mats = ddAgg ? ddAgg.materials : (data?.by_material || []);
      if ($("ddPieEmpty")) $("ddPieEmpty").style.display = mats.some(r => Number(r.weight_g || 0) > 0) ? "none" : "block";
      setDoughnutData(ddPieChart, mats);

      const isAdmin = !!data?.is_admin;
      const events = (data?.recent_events || []).slice(0, 20);

      if (!adminKey()) {
        $("ddEventsEmpty").style.display = "block";
        $("ddEventsEmpty").textContent = "Configura la Admin key nelle Impostazioni (icona ingranaggio) per vedere i conferimenti di questo cestino.";
        $("ddEventsBody").innerHTML = "";
      } else if (!isAdmin) {
        $("ddEventsEmpty").style.display = "block";
        $("ddEventsEmpty").textContent = "Admin key non valida (401). Aggiornala nelle Impostazioni.";
        $("ddEventsBody").innerHTML = "";
      } else if (!events || events.length === 0) {
        $("ddEventsEmpty").style.display = "block";
        $("ddEventsEmpty").textContent = "Nessun conferimento recente per questo cestino.";
        $("ddEventsBody").innerHTML = "";
      } else {
        $("ddEventsEmpty").style.display = "none";
        $("ddEventsEmpty").textContent = "";
        $("ddEventsBody").innerHTML = events.map(e => {
          const whenHuman = timeAgo(e.ts);
          const whenTitle = isoToNice(e.ts);
          const eid = e.id ?? "";
          return `
            <tr data-eid="${String(eid)}">
              <td class="muted" title="${whenTitle}">${whenHuman}</td>
              <td>${materialHTML(e.material)}</td>
              <td class="right">${formatWeight(e.weight_g)}</td>
              <td class="right">${formatCO2(e.co2_saved_g)}</td>
              <td class="mono" style="text-align:right" title="${escapeHtml(String(eid))}">${shortId(eid)}</td>
            </tr>
          `;
        }).join("");
      }

    } catch (e) {
      safeText("ddSub", "Errore caricamento dettagli.");
      if ($("ddCompartmentsEmpty")) {
        $("ddCompartmentsEmpty").style.display = "block";
        $("ddCompartmentsEmpty").textContent = (e?.message || String(e));
      }
      if ($("ddEventsEmpty")) {
        $("ddEventsEmpty").style.display = "block";
        $("ddEventsEmpty").textContent = (e?.message || String(e));
      }
    }
  }

  function renderRecentEvents(dash) {
    const eventsBody = $("eventsBody");
    const eventsEmpty = $("eventsEmpty");
    if (!eventsBody || !eventsEmpty) return;

    const isAdmin = !!dash?.is_admin;
    const events = (dash?.recent_events || []).slice(0, 20);

    if (!adminKey()) {
      const msg = "Configura la Admin key nelle Impostazioni (icona ingranaggio) per vedere i conferimenti recenti.";
      if (lastEventsSig !== "NOADMIN") {
        lastEventsSig = "NOADMIN";
        eventsBody.innerHTML = "";
        eventsEmpty.style.display = "block";
        eventsEmpty.textContent = msg;
      }
      return;
    }

    if (!isAdmin) {
      const msg = "Admin key non valida (401). Aggiornala nelle Impostazioni.";
      if (lastEventsSig !== "BADADMIN") {
        lastEventsSig = "BADADMIN";
        eventsBody.innerHTML = "";
        eventsEmpty.style.display = "block";
        eventsEmpty.textContent = msg;
      }
      return;
    }

    const sig = (events || []).map(e =>
      `${e.ts || ""}|${e.bin_id || ""}|${e.material || ""}|${Number(e.weight_g || 0)}|${Number(e.co2_saved_g || 0)}|${e.id || ""}`
    ).join(";;");

    if (sig === lastEventsSig) return;
    lastEventsSig = sig;

    if (!events || events.length === 0) {
      eventsBody.innerHTML = "";
      eventsEmpty.style.display = "block";
      eventsEmpty.textContent = "Nessun conferimento registrato (ancora).";
      return;
    }

    eventsEmpty.style.display = "none";
    eventsEmpty.textContent = "";

    eventsBody.innerHTML = events.map(e => {
      const whenHuman = timeAgo(e.ts);
      const whenTitle = isoToNice(e.ts);
      const eid = e.id ?? "";
      return `
        <tr data-eid="${String(eid)}">
          <td class="muted" title="${whenTitle}">${whenHuman}</td>
          <td><b>${escapeHtml(e.bin_id)}</b></td>
          <td>${materialHTML(e.material)}</td>
          <td class="right">${formatWeight(e.weight_g)}</td>
          <td class="right">${formatCO2(e.co2_saved_g)}</td>
          <td class="mono" style="text-align:right" title="${escapeHtml(String(eid))}">${shortId(eid)}</td>
        </tr>
      `;
    }).join("");
  }

  window.__lastCapGByBin = {};

  // =========================================================
  // Effetti live: attività, nuovi cestini, conferimenti, animazioni
  // =========================================================
  const ACTIVE_NOW_MIN = 15;
  const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // Il cestino invia dati solo quando riconosce un rifiuto:
  // misuriamo l'attività, non la connessione.
  function activityOf(iso) {
    const d = isoToDate(iso);
    if (!d) return { cls: "idle", label: "Nessun conferimento" };
    const min = (Date.now() - d.getTime()) / 60000;
    if (min < ACTIVE_NOW_MIN) return { cls: "now", label: "Attivo ora" };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (d >= today) return { cls: "today", label: "Attivo oggi" };
    return { cls: "idle", label: "Inattivo" };
  }

  function activityHTML(iso) {
    const a = activityOf(iso);
    return `<span class="act ${a.cls}" title="${escapeHtml(a.label)} · ${escapeHtml(isoToNice(iso))}"><span class="actDot"></span><span data-col="last">${timeAgo(iso)}</span></span>`;
  }

  function renderActivitySummary(bins) {
    let now = 0, today = 0;
    for (const b of bins) {
      const a = activityOf(b.last_seen).cls;
      if (a === "now") now++;
      if (a === "now" || a === "today") today++;
    }
    const el = $("activitySummary");
    if (!el) return;
    el.className = `act ${now ? "now" : today ? "today" : "idle"}`;
    el.innerHTML = `<span class="actDot"></span>${now ? `<b>${now}</b> attiv${now === 1 ? "o" : "i"} ora` : `<b>${today}</b> attiv${today === 1 ? "o" : "i"} oggi`}`;
  }

  // --- Toast ---
  function toast({ title, text, color, kind = "event" }) {
    const box = $("toasts");
    if (!box) return;
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.innerHTML = `
      <span class="toastIcon" style="${color ? `--tc:${color}` : ""}"></span>
      <div class="toastBody"><div class="toastTitle">${title}</div>${text ? `<div class="toastText">${text}</div>` : ""}</div>`;
    box.prepend(el);
    while (box.children.length > 4) box.lastElementChild.remove();
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 350); }, 5200);
  }

  // --- Contatori animati ---
  const kpiValues = {};
  function animateNumber(id, to, fmt) {
    const el = $(id);
    if (!el) return;
    el.classList.remove("skeleton");
    const target = Number(to || 0);
    const from = kpiValues[id];
    kpiValues[id] = target;
    if (prefersReducedMotion()) { el.textContent = fmt(target); return; }
    const start = from ?? 0;
    if (start === target) { el.textContent = fmt(target); return; }
    if (from !== undefined && target > from) {
      el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
    }
    const dur = from === undefined ? 1100 : 700;
    const t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      el.textContent = fmt(start + (target - start) * ease(t));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // --- Livelli animati tra un aggiornamento e l'altro ---
  // Gli elementi con data-k / data-v / data-p partono dal valore precedente
  // e salgono (o scendono) fino al nuovo, invece di saltare.
  const levelMemory = {};
  function setLevel(el, p, v) {
    if (p === "dash") {
      const c = Number(el.getAttribute("stroke-dasharray")) || 0;
      el.style.strokeDashoffset = `${c * (1 - v / 100)}`;
    } else {
      el.style[p] = `${v}%`;
    }
  }
  function animateLevels(root) {
    if (!root) return;
    const els = root.querySelectorAll("[data-k]");
    const pending = [];
    els.forEach(el => {
      const k = el.getAttribute("data-k");
      const v = Number(el.getAttribute("data-v"));
      const p = el.getAttribute("data-p") || "height";
      const prev = levelMemory[k];
      const startVal = prev === undefined ? 0 : prev;
      levelMemory[k] = v;
      if (startVal === v || prefersReducedMotion()) { setLevel(el, p, v); return; }
      el.style.transition = "none";
      setLevel(el, p, startVal);
      pending.push([el, p, v]);
    });
    if (!pending.length) return;
    void root.offsetWidth;
    requestAnimationFrame(() => {
      for (const [el, p, v] of pending) {
        el.style.transition = "";
        setLevel(el, p, v);
      }
    });
  }

  // --- Rilevamento novità ---
  const LS_KNOWN_BINS = "sorti_known_bins_v1";
  let knownBins = null;            // Set dei cestini già visti (persistente)
  let prevWeights = null;          // bin_id -> peso al refresh precedente
  let seenEventIds = null;         // id eventi già visti
  let lastEventTs = 0;             // timestamp del conferimento più recente già visto
  const freshBins = new Map();     // bin_id -> "new" | "event", per l'evidenziazione

  function markFresh(binId, kind) {
    freshBins.set(String(binId), kind);
    setTimeout(() => freshBins.delete(String(binId)), 4000);
  }

  function detectChanges(bins, dash) {
    // 1) Nuovi cestini
    if (!knownBins) {
      try { knownBins = new Set(JSON.parse(localStorage.getItem(LS_KNOWN_BINS) || "null") || []); }
      catch { knownBins = new Set(); }
      const firstEver = knownBins.size === 0;
      for (const b of bins) {
        if (!knownBins.has(b.bin_id) && !firstEver) {
          markFresh(b.bin_id, "new");
          toast({ kind: "new", title: "Nuovo cestino connesso", text: `<b>${escapeHtml(b.bin_id)}</b> ha iniziato a inviare dati` });
        }
        knownBins.add(b.bin_id);
      }
    } else {
      for (const b of bins) {
        if (!knownBins.has(b.bin_id)) {
          knownBins.add(b.bin_id);
          markFresh(b.bin_id, "new");
          toast({ kind: "new", title: "Nuovo cestino connesso", text: `<b>${escapeHtml(b.bin_id)}</b> ha iniziato a inviare dati` });
        }
      }
    }
    localStorage.setItem(LS_KNOWN_BINS, JSON.stringify([...knownBins]));

    // 2) Nuovi conferimenti: dagli eventi (con Admin key) oppure dal peso
    const events = dash?.is_admin ? (dash?.recent_events || []) : null;
    const notifiedBins = new Set();

    if (events) {
      const ids = events.map(e => String(e.id ?? `${e.ts}|${e.bin_id}`));
      if (seenEventIds) {
        // Solo conferimenti davvero nuovi: mai visti E più recenti dell'ultimo noto
        // (cambiando periodo la dashboard scarica anche eventi più vecchi)
        const fresh = events.filter((e, i) => !seenEventIds.has(ids[i]) && (isoToDate(e.ts)?.getTime() || 0) > lastEventTs).slice(0, 3).reverse();
        for (const e of fresh) {
          notifiedBins.add(e.bin_id);
          if (freshBins.get(String(e.bin_id)) !== "new") markFresh(e.bin_id, "event");
          toast({
            title: `+${formatWeight(e.weight_g)} di ${escapeHtml(e.material || "rifiuto")}`,
            text: `${escapeHtml(e.bin_id)} · ${formatCO2(e.co2_saved_g)} CO₂ risparmiata`,
            color: materialColor(e.material)
          });
        }
      }
      seenEventIds = new Set(ids);
      for (const e of events) {
        const t = isoToDate(e.ts)?.getTime() || 0;
        if (t > lastEventTs) lastEventTs = t;
      }
    }

    const weights = {};
    for (const b of bins) weights[b.bin_id] = Number(b.current_weight_g || 0);
    if (prevWeights) {
      for (const b of bins) {
        const before = prevWeights[b.bin_id];
        const delta = weights[b.bin_id] - (before ?? weights[b.bin_id]);
        if (delta > 0 && !notifiedBins.has(b.bin_id)) {
          if (freshBins.get(String(b.bin_id)) !== "new") markFresh(b.bin_id, "event");
          if (!events) toast({ title: `+${formatWeight(delta)} conferiti`, text: `${escapeHtml(b.bin_id)}` });
        }
      }
    }
    prevWeights = weights;
  }

  function freshClass(binId) {
    const k = freshBins.get(String(binId));
    return k === "new" ? "isNew" : k === "event" ? "isEvent" : "";
  }

  function renderBinsDesktopAndMobile(bins, onlyAlerts) {
    const binsSig = `${thresholds.warn}|${thresholds.critical}|${[...freshBins].join(",")}|` + (onlyAlerts ? "ONLY|" : "ALL|") + bins.map(b =>
      `${b.bin_id}|${Number(b.capacity_g || 0)}|${Number(b.current_weight_g || 0)}|${b.last_seen || ""}|${getFillPercent(b)}|${JSON.stringify(getCompartments(b))}`
    ).join(";;");

    if (binsSig !== lastBinsSig) {
      lastBinsSig = binsSig;

      const fmtKg = (g) => {
        const kg = Number(g || 0) / 1000;
        return isFinite(kg) ? (kg < 100 ? kg.toFixed(1) : Math.round(kg).toString()) + " kg" : "—";
      };

      const rowsHTML = bins.map(b => {
        const i = "t";
        const fill = getFillPercent(b);
        const sFill = binStatusFill(b);
        const p = priorityOf(sFill);
        const priClass = (p === 2) ? "priCritical" : (p === 1) ? "priWarn" : "";
        const id = escapeHtml(b.bin_id);
        const source = getFillSource(b) === "sensor" ? "sensori" : "stima";

        window.__lastCapGByBin[b.bin_id] = Number(b.capacity_g || 0);

        return `
          <tr id="binrow-${id}" class="${priClass} ${freshClass(b.bin_id)}" data-bin="${id}" title="Apri dettagli">
            <td>
              <div class="binCell">
                ${binGlyphHTML(fill, sFill, `${b.bin_id}|glyph|${i}`)}
                <div>
                  <div class="binId">${id}</div>
                  <div class="binMeta">${fillBadge(sFill)}</div>
                </div>
              </div>
            </td>
            <td data-col="fill">
              <div class="fillCell">
                <span class="fillPct">${Math.round(fill)}%</span>
                <span class="bar"><div data-k="${id}|bar" data-v="${clampPct(fill)}" data-p="width" style="width:${clampPct(fill)}%; background:${barColor(fill)}"></div></span>
              </div>
              <div class="binMeta">fonte: ${source}</div>
            </td>
            <td>${compSummaryHTML(b)}</td>
            <td class="weightCell" data-col="weight">
              <b>${formatWeight(b.current_weight_g)}</b> <span class="of">/ ${fmtKg(b.capacity_g)}</span>
            </td>
            <td class="lastCell">${activityHTML(b.last_seen)}</td>
          </tr>
        `;
      }).join("");

      const emptyMsg = onlyAlerts ? "Nessun cestino in attenzione. Tutto regolare." : "Nessun cestino registrato.";
      safeHTML("binsBody", rowsHTML || `<tr class="emptyRow"><td colspan="5">${emptyMsg}</td></tr>`);

      const RING_C = 2 * Math.PI * 42;
      const cards = bins.map(b => {
        const i = "m";
        const fill = getFillPercent(b);
        const sFill = binStatusFill(b);
        const st = statusOf(sFill);
        const p = priorityOf(sFill);
        const priClass = (p === 2) ? "priCritical" : (p === 1) ? "priWarn" : "";
        const id = escapeHtml(b.bin_id);
        const f = clampPct(fill);

        return `
          <div id="bincard-${id}" class="binTile ${priClass} ${freshClass(b.bin_id)}" data-bin="${id}" role="button" tabindex="0" title="Apri dettagli">
            <div class="tileTop">
              <span class="tileIcon">${binGlyphHTML(fill, sFill, `${b.bin_id}|glyph|${i}`)}</span>
              ${fillBadge(sFill)}
            </div>
            <div class="ring ${st}">
              <svg viewBox="0 0 100 100" aria-hidden="true">
                <circle class="ringTrack" cx="50" cy="50" r="42" />
                <circle class="ringVal" cx="50" cy="50" r="42"
                  stroke-dasharray="${RING_C.toFixed(2)}"
                  data-k="${id}|ring" data-v="${f}" data-p="dash"
                  style="stroke-dashoffset:${(RING_C * (1 - f / 100)).toFixed(2)}" />
              </svg>
              <div class="ringCenter">
                <span class="ringPct">${Math.round(fill)}%</span>
                <span class="ringLbl">riempito</span>
              </div>
            </div>
            <div class="tileName">${id}</div>
            <div class="tileSub"><b>${formatWeight(b.current_weight_g)}</b> di ${fmtKg(b.capacity_g)}</div>
            <div class="tileComps">${compStripHTML(b, `${b.bin_id}|m`) || `<span class="compNone">${getFillSource(b) === "sensor" ? "Nessun dato sensori" : "Stima da peso"}</span>`}</div>
            <div class="tileFoot">${activityHTML(b.last_seen)}</div>
          </div>
        `;
      }).join("");

      safeHTML("binsCards", cards || `<div class="emptyState">${emptyMsg}</div>`);
      animateLevels($("binsBody"));
      animateLevels($("binsCards"));
    }

    syncResponsiveBinsView();
  }

  function updateRangeHints(range, fineAgg) {
    let txt = range.label;
    if (range.hours === 1 && fineAgg && !fineAgg.complete) txt += ` · parziale (ultimi ${fineAgg.fetched} conferimenti)`;
    if (range.hours === 1 && !fineAgg) txt = "Ultima ora · serve la Admin key";
    document.querySelectorAll(".rangeHint").forEach(el => { el.textContent = txt; });
    const sub = $("trendSub");
    const fineOk = range.fine && fineAgg && (fineAgg.complete || range.hours === 1);
    if (sub) sub.textContent = fineOk ? `valori ogni ${range.bucketMin === 60 ? "ora" : range.bucketMin + " minuti"}` : "valori giornalieri";
    const mSub = $("matSub");
    if (mSub) mSub.textContent = (fineAgg && fineAgg.complete) ? `Peso per frazione · ${range.label.toLowerCase()}` : "Peso per frazione · storico";
  }

  function setKpiUnavailable(id) {
    const el = $(id);
    if (!el) return;
    el.classList.remove("skeleton");
    el.textContent = "—";
    el.title = "Serve la Admin key per i dati dell'ultima ora";
    delete kpiValues[id];
  }

  function updateKeyStatus() {
    const a = !!adminKey(), i = !!ingestKey();
    const as = $("adminKeyStatus"), is = $("ingestKeyStatus");
    if (as) { as.textContent = a ? "Configurata" : "Non configurata"; as.classList.toggle("on", a); }
    if (is) { is.textContent = i ? "Configurata" : "Non configurata"; is.classList.toggle("on", i); }
    const dot = $("keyDot");
    if (dot) dot.classList.toggle("show", !a);
  }

  async function refresh() {
    if (refreshing) {
      pendingRefresh = true;
      return;
    }
    refreshing = true;

    try {
      clearError();
      const range = getRange();
      const days = range.days;
      const wantFine = range.fine && !!adminKey();
      const dash = await fetchDashboard(days, wantFine ? FINE_EVENTS_LIMIT : 20);
      const fineAgg = (wantFine && dash?.is_admin) ? aggregateEvents(dash?.recent_events || [], range) : null;
      updateRangeHints(range, fineAgg);

      lastIsAdmin = !!dash?.is_admin;

      animateNumber("kpiTotalWeight", dash?.totals?.total_weight_g, formatWeight);
      animateNumber("kpiTotalCO2", dash?.totals?.total_co2_saved_g, formatCO2);

      let binsAll = (dash?.bins || []).slice();
      safeText("binsCount", binsAll.length.toString());

      binsAll.sort((a, b) => {
        const pa = priorityOf(binStatusFill(a));
        const pb = priorityOf(binStatusFill(b));
        if (pa !== pb) return pb - pa;
        return getFillPercent(b) - getFillPercent(a);
      });

      renderQuickAlerts(binsAll);

      const onlyAlerts = !!$("onlyAlerts").checked;
      const bins = onlyAlerts ? binsAll.filter(b => priorityOf(binStatusFill(b)) > 0) : binsAll;

      detectChanges(binsAll, dash);
      renderActivitySummary(binsAll);
      renderBinsDesktopAndMobile(bins, onlyAlerts);

      const daily = dash?.daily || [];
      let rangeW, rangeC, series;
      if (fineAgg && range.hours === 24) {
        // Totali esatti dal server; andamento orario solo se i conferimenti sono completi
        rangeW = daily.reduce((s, r) => s + Number(r.weight_g || 0), 0);
        rangeC = daily.reduce((s, r) => s + Number(r.co2_saved_g || 0), 0);
        series = fineAgg.complete
          ? fineAgg.buckets.map(b => ({ label: b.label, v: b.co2_g }))
          : daily.map(r => ({ label: r.day, v: Number(r.co2_saved_g || 0) }));
      } else if (fineAgg) {
        rangeW = fineAgg.weight_g;
        rangeC = fineAgg.co2_g;
        series = fineAgg.buckets.map(b => ({ label: b.label, v: b.co2_g }));
      } else if (range.hours === 1) {
        // Ultima ora senza Admin key: dato non disponibile
        rangeW = null; rangeC = null; series = [];
      } else {
        rangeW = daily.reduce((s, r) => s + Number(r.weight_g || 0), 0);
        rangeC = daily.reduce((s, r) => s + Number(r.co2_saved_g || 0), 0);
        series = daily.map(r => ({ label: r.day, v: Number(r.co2_saved_g || 0) }));
      }

      if (rangeW === null) {
        setKpiUnavailable("kpiRangeWeight");
        setKpiUnavailable("kpiRangeCO2");
      } else {
        animateNumber("kpiRangeWeight", rangeW, formatWeight);
        animateNumber("kpiRangeCO2", rangeC, formatCO2);
      }

      const lineEmpty = $("lineEmpty");
      lineEmpty.style.display = series.some(r => r.v > 0) ? "none" : "block";
      lineEmpty.textContent = (range.hours === 1 && !fineAgg)
        ? "Per la vista \"Ultima ora\" serve la Admin key: i dati orari si calcolano dai singoli conferimenti."
        : "Nessun dato nel periodo selezionato.";
      lineChart.data.labels = series.map(r => r.label);
      lineChart.data.datasets[0].data = series.map(r => r.v);
      lineChart.update();

      const useFineMats = fineAgg && fineAgg.complete;
      const mats = useFineMats ? fineAgg.materials : (dash?.by_material || []);
      $("pieEmpty").style.display = mats.some(r => Number(r.weight_g || 0) > 0) ? "none" : "block";
      setDoughnutData(doughnutChart, mats);

      renderRecentEvents(dash);

      safeText("lastUpdated", new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      const lu = $("lastUpdated");
      if (lu) lu.title = new Date().toLocaleString("it-IT");

      if (drawerOpen && activeBinId) {
        safeText("ddRangeLabel", range.label);
      }

    } catch (e) {
      showError(e?.message || String(e));
    } finally {
      refreshing = false;
      if (pendingRefresh) {
        pendingRefresh = false;
        scheduleRefresh(350);
      }
    }
  }

  function wireUI() {
    // Tema
    const THEMES = ["light", "dark", "glass"];
    const THEME_NAME = { light: "Chiaro", dark: "Scuro", glass: "Vetro" };
    const syncThemeBtn = () => {
      const cur = document.documentElement.getAttribute("data-theme") || "light";
      const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
      $("btnTheme").title = `Tema: ${THEME_NAME[cur] || cur} · passa a ${THEME_NAME[next]}`;
    };
    $("btnTheme").onclick = () => {
      const cur = document.documentElement.getAttribute("data-theme") || "light";
      setTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
      syncThemeBtn();
    };
    syncThemeBtn();

    // Vista cestini: schede / tabella
    document.querySelectorAll(".segBtn[data-view]").forEach(btn => {
      btn.onclick = () => { localStorage.setItem(LS_VIEW, btn.getAttribute("data-view")); syncResponsiveBinsView(); };
    });

    // Barra di navigazione: sezione attiva durante lo scroll
    const dockLinks = [...document.querySelectorAll(".dockLink")];
    const setActive = (id) => dockLinks.forEach(a => a.classList.toggle("active", a.getAttribute("href") === `#${id}`));
    dockLinks.forEach(a => a.addEventListener("click", (e) => {
      const target = document.querySelector(a.getAttribute("href"));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
      setActive(target.id);
    }));
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        const vis = entries.filter(en => en.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id);
      }, { rootMargin: "-30% 0px -60% 0px" });
      document.querySelectorAll("[data-section]").forEach(sec => io.observe(sec));
    }
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", (e) => {
        if (!localStorage.getItem(LS_THEME)) { setTheme(e.matches ? "dark" : "light", false); syncThemeBtn(); }
      });
    }

    // Impostazioni
    const settings = $("settingsModal");
    $("btnSettings").onclick = () => { updateKeyStatus(); settings.showModal(); };
    $("settingsClose").onclick = () => settings.close();
    settings.addEventListener("click", (e) => { if (e.target === settings) settings.close(); });

    // Apertura dettaglio cestino (delegation)
    document.addEventListener("click", (e) => {
      const el = e.target.closest?.("[data-bin]");
      if (el && !el.closest("#drawer")) openBinDrawer(el.getAttribute("data-bin"));
    });
    document.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target?.matches?.(".binTile[data-bin]")) {
        e.preventDefault();
        openBinDrawer(e.target.getAttribute("data-bin"));
      }
    });

    const devWrap = $("devSimWrap");
    if (devWrap) {
      devWrap.style.display = isDevMode() ? "block" : "none";
    }

    $("btnSaveAdmin").onclick = async () => {
      const v = $("adminKeyInput").value.trim();
      if (!v) return await customAlert("Incolla la ADMIN key.", "Errore");
      localStorage.setItem(LS_ADMIN, v);
      $("adminKeyInput").value = "";
      updateKeyStatus();
      await customAlert("Admin key salvata correttamente.", "Salvato");
      refresh();
      if (drawerOpen && activeBinId) openBinDrawer(activeBinId, { soft: true });
    };

    $("btnSaveIngest").onclick = async () => {
      const v = $("ingestKeyInput").value.trim();
      if (!v) return await customAlert("Incolla la INGEST key.", "Errore");
      localStorage.setItem(LS_INGEST, v);
      $("ingestKeyInput").value = "";
      updateKeyStatus();
      await customAlert("Ingest key salvata correttamente.", "Salvato");
    };

    $("btnEditThresholds").onclick = async () => {
      const w = await customPrompt("Soglia di ATTENZIONE (%):", String(thresholds.warn), "Soglie Alert");
      if (w === null) return;
      const c = await customPrompt("Soglia CRITICA (%):", String(thresholds.critical), "Soglie Alert");
      if (c === null) return;

      const wn = Number(String(w).replace(",", ".").trim());
      const cn = Number(String(c).replace(",", ".").trim());

      if (!isFinite(wn) || !isFinite(cn) || wn <= 0 || cn <= 0 || wn >= cn || cn > 100) {
        return await customAlert("Valori non validi.\nRegola: 0 < attenzione < critico ≤ 100", "Errore");
      }
      thresholds = { warn: wn, critical: cn };
      saveThresholds();
      updateThresholdLabels();
      refresh();
      if (drawerOpen && activeBinId) openBinDrawer(activeBinId, { soft: true });
    };

    const btnSim = $("btnSimEvent");
    if (btnSim) {
      btnSim.onclick = async () => {
        if (!isDevMode()) return await customAlert("Simulatore disabilitato (non sei in DEV mode).", "Avviso");
        try {
          if (!ingestKey()) return await customAlert("Manca Ingest key (X-Ingest-Key).", "Errore");
          const bin = $("simBin").value.trim();
          const mat = $("simMat").value.trim();
          const w = Number($("simW").value || 0);
          if (!bin || !mat || !w) return await customAlert("Compila bin_id, materiale e grammi.", "Attenzione");

          const resp = await fetchJSON(apiUrl("/api/event"), {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Ingest-Key": ingestKey() },
            body: JSON.stringify({ bin_id: bin, material: mat, weight_g: w, source: "simulator" })
          });

          $("simW").value = "";
          const r = $("simResult");
          if (r) {
            r.style.display = "block";
            r.textContent =
              `✅ Evento registrato\n` +
              `bin: ${resp.bin_id}\n` +
              `materiale: ${resp.material}\n` +
              `peso: ${formatWeight(resp.weight_g)}\n` +
              `CO₂ risparmiata: ${formatCO2(resp.co2_saved_g)}\n` +
              `riempimento totale: ${Math.round(getFillPercent(resp.bin || {}))}%`;
          }

          await refresh();
        } catch (e) {
          if ($("simResult")) $("simResult").style.display = "none";
          await customAlert("Errore invio evento:\n\n" + (e?.message || String(e)), "Errore");
        }
      };
    }

    $("btnExportEvents").onclick = async () => {
      try {
        if (!adminKey()) return await customAlert("Manca Admin key.", "Errore");
        await downloadFile(apiUrl("/api/export/events.csv"), "sorti_events.csv", { "X-API-Key": adminKey() });
      } catch (e) {
        await customAlert("Errore export eventi:\n\n" + (e?.message || String(e)), "Errore");
      }
    };

    $("btnExportDaily").onclick = async () => {
      try {
        if (!adminKey()) return await customAlert("Manca Admin key.", "Errore");
        const d = Math.max(1, Math.min(365, Number($("exportDays").value || 30)));
        await downloadFile(apiUrl(`/api/export/daily.csv?days=${d}`), `sorti_daily_${d}d.csv`, { "X-API-Key": adminKey() });
      } catch (e) {
        await customAlert("Errore export daily:\n\n" + (e?.message || String(e)), "Errore");
      }
    };

    $("rangeSel").onchange = async () => {
      await refresh();
      if (drawerOpen && activeBinId) await openBinDrawer(activeBinId, { soft: true });
    };

    $("onlyAlerts").onchange = () => refresh();

    $("btnCloseDrawer").onclick = () => closeDrawer();
    $("drawerOverlay").onclick = () => closeDrawer();

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && drawerOpen) closeDrawer();
    });

    window.addEventListener("resize", syncResponsiveBinsView);
    window.__openBin = (binId) => openBinDrawer(binId);
  }

  // Funzioni condivise con report.js (report ESG)
  window.__sorti = {
    apiUrl, fetchJSON, adminKey, formatWeight, materialColor, statusOf,
    getFillPercent, binStatusFill, getFillSource, getCompartments, isoToDate,
    customAlert, customPrompt, STATUS_LABEL,
    getRangeDays: () => getRange().days,
    getRange, aggregateEvents, FINE_EVENTS_LIMIT,
  };

  document.addEventListener("DOMContentLoaded", () => {
    loadThresholds();
    updateThresholdLabels();
    updateKeyStatus();
    initCharts();
    wireUI();
    syncResponsiveBinsView();
    startSSE();
    refresh();
  });
})();
