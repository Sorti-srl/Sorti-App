// =========================================================
// Sorti · Riepilogo per caso studio (dettaglio cestino)
// Conferimenti per categoria tra due giorni di calendario (ora italiana),
// nello stesso ordine del foglio "Caso studio" del file di campionamento.
// Richiede il server Sorti API v2.3 (/api/stats/summary).
// =========================================================
(() => {
  const S = () => window.__sorti;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => S().escapeHtml(v ?? "");

  let infoPromise = null;
  let currentBin = null;
  let lastData = null;
  let compatMode = false;   // server precedente alla v2.3: conteggio dall'export CSV dei conferimenti

  function features() {
    if (!infoPromise) {
      infoPromise = S().fetchJSON(S().apiUrl("/api/info"))
        .then(r => new Set(r?.features || []))
        .catch(() => new Set());
    }
    return infoPromise;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const itDate = (iso) => { const [y, m, d] = String(iso).split("-"); return `${d}/${m}/${y}`; };

  // Numeri con la virgola, per incollarli in Excel italiano
  const num = (v, max = 4) => Number(v || 0).toLocaleString("it-IT", { useGrouping: false, maximumFractionDigits: max });
  const kg = (g) => Number(g || 0) / 1000;

  async function render(bin) {
    currentBin = bin;
    const box = $("caseBody");
    if (!box) return;
    const f = await features();
    if (currentBin !== bin) return;
    compatMode = !f.has("summary");
    if (compatMode && !S().adminKey()) {
      $("caseControls").style.display = "none";
      box.innerHTML = `<div class="regNotice">Per il riepilogo per caso studio serve la Admin key (Impostazioni).</div>`;
      return;
    }
    $("caseControls").style.display = "";
    if (!$("caseFrom").value) $("caseFrom").value = today();
    if (!$("caseTo").value) $("caseTo").value = $("caseFrom").value;
    load();
  }

  async function load() {
    const bin = currentBin;
    const box = $("caseBody");
    const from = $("caseFrom").value, to = $("caseTo").value;
    if (!bin || !from || !to) return;
    if (to < from) {
      box.innerHTML = `<div class="regNotice err">La data "Al" è precedente alla data "Dal".</div>`;
      return;
    }
    const q = new URLSearchParams({ date_from: from, date_to: to, bin_id: bin.bin_id });
    let d;
    try {
      d = compatMode ? await compatSummary(bin.bin_id, from, to)
                     : await S().fetchJSON(S().apiUrl(`/api/stats/summary?${q}`));
    } catch (e) {
      box.innerHTML = `<div class="regNotice err">${esc(String(e?.message || e).split("\n")[0])}</div>`;
      return;
    }
    if (currentBin !== bin) return;
    lastData = d;

    const rows = d.categories.map(c => `
      <tr class="${c.unknown ? "caseUnknown" : ""}">
        <td>${esc(c.label)}${c.unknown ? ' <span class="muted">(non previsto)</span>' : ""}</td>
        <td class="right"><b>${c.events}</b></td>
        <td class="right">${c.weight_estimated ? num(c.avg_weight_g, 2) : '<span class="muted">n.s.</span>'}</td>
        <td class="right">${c.weight_estimated ? num(kg(c.weight_g), 3) : '<span class="muted">n.s.</span>'}</td>
        <td class="right">${c.weight_estimated ? num(kg(c.co2_saved_g), 3) : '<span class="muted">n.s.</span>'}</td>
      </tr>`).join("");
    const t = d.totals;
    const c = d.coefficients || {};
    const mixed = (d.versions_in_period || []).filter(v => v !== c.version);
    const period = from === to ? itDate(from) : `${itDate(from)} – ${itDate(to)}`;

    box.innerHTML = `
      <div class="tableWrap">
        <table class="caseTable">
          <thead><tr>
            <th>Categoria</th><th class="right">Conferi&shy;menti</th><th class="right">Peso medio (g)</th>
            <th class="right">kg stimati</th><th class="right">CO₂e pot. evitata (kg)</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr>
            <td>Totale</td><td class="right">${t.events}</td><td></td>
            <td class="right">${num(kg(t.weight_g), 3)}</td><td class="right">${num(kg(t.co2_saved_g), 3)}</td>
          </tr></tfoot>
        </table>
      </div>
      <div class="caseMeta">
        ${esc(period)} · giorni interi in ora italiana · coefficienti <b>${esc(c.version || "?")}</b>${c.date ? ` del ${esc(itDate(c.date))}` : ""}
        ${mixed.length ? `<br><span class="caseWarn">Attenzione: nel periodo ci sono conferimenti calcolati con altre versioni (${esc(mixed.join(", "))}).</span>` : ""}
      </div>
      <div class="caseActions">
        <button class="btn btnPrimary btnSm" type="button" id="caseCopyCounts" title="Incolla nella cella B14 del foglio Caso studio">Copia conferimenti per Excel</button>
        <button class="btn btnSm" type="button" id="caseCopyTable">Copia tabella</button>
        <span class="caseCopied" id="caseCopied"></span>
      </div>`;
    $("caseCopyCounts").onclick = () => copy(countsText(), "Conferimenti copiati: incollali nella cella B14 del foglio Caso studio.");
    $("caseCopyTable").onclick = () => copy(tableText(), "Tabella copiata.");
  }

  // Server precedente alla v2.3: si contano i conferimenti dall'export CSV (Admin key)
  // e si stimano peso e CO2 con i coefficienti v1 incorporati nella dashboard.
  const romeDay = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
  };

  async function compatSummary(binId, from, to) {
    const res = await fetch(S().apiUrl("/api/export/events.csv"), {
      headers: Object.assign({}, S().extraHeaders(), { "X-API-Key": S().adminKey() }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}\n${text}`);
    const lines = text.split(/\r?\n/).filter(Boolean);
    const head = (lines.shift() || "").split(",");
    const iTs = head.indexOf("ts"), iBin = head.indexOf("bin_id"), iMat = head.indexOf("material");
    if (iTs < 0 || iBin < 0 || iMat < 0) throw new Error("Formato dell'export non riconosciuto");
    const counts = {};
    for (const ln of lines) {
      const c = ln.split(",");
      if (c[iBin] !== binId) continue;
      const day = romeDay(c[iTs]);
      if (!day || day < from || day > to) continue;
      const k = S().coefKey(c[iMat]);
      counts[k] = (counts[k] || 0) + 1;
    }
    const coef = S().COEF_FALLBACK;
    const out = [];
    for (const [key, cat] of Object.entries(coef.categories)) {
      const n = counts[key] || 0; delete counts[key];
      const avg = cat.avg_weight_g;
      out.push({ material: key, label: cat.label, events: n, avg_weight_g: avg,
                 weight_estimated: typeof avg === "number" && avg > 0,
                 weight_g: n * S().estWeightG(key), co2_saved_g: n * S().estCo2G(key) });
    }
    for (const [key, n] of Object.entries(counts)) {
      out.push({ material: key, label: key, events: n, avg_weight_g: null, weight_estimated: false,
                 weight_g: 0, co2_saved_g: 0, unknown: true });
    }
    return {
      categories: out, coefficients: S().coefMeta(), versions_in_period: [],
      totals: { events: out.reduce((s, x) => s + x.events, 0), weight_g: out.reduce((s, x) => s + x.weight_g, 0),
                co2_saved_g: out.reduce((s, x) => s + x.co2_saved_g, 0) },
    };
  }

  // Solo le 6 categorie del foglio Excel, una per riga, nell'ordine B14:B19
  function countsText() {
    return lastData.categories.filter(c => !c.unknown).map(c => String(c.events)).join("\n");
  }

  function tableText() {
    const head = ["Categoria", "Conferimenti", "Peso medio (g)", "kg stimati", "CO2e potenzialmente evitata (kg)"];
    const lines = lastData.categories.map(c => [
      c.label, c.events,
      c.weight_estimated ? num(c.avg_weight_g, 4) : "",
      c.weight_estimated ? num(kg(c.weight_g), 4) : "",
      c.weight_estimated ? num(kg(c.co2_saved_g), 4) : "",
    ].join("\t"));
    return [head.join("\t"), ...lines].join("\n");
  }

  async function copy(text, okMsg) {
    let done = false;
    try { await navigator.clipboard.writeText(text); done = true; } catch { }
    if (!done) {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { done = document.execCommand("copy"); } catch { }
      ta.remove();
    }
    const el = $("caseCopied");
    if (el) {
      el.textContent = done ? okMsg : "Copia non riuscita: seleziona la tabella e copiala a mano.";
      setTimeout(() => { if (el.textContent === okMsg) el.textContent = ""; }, 6000);
    }
  }

  window.__sortiCase = { render };

  document.addEventListener("DOMContentLoaded", () => {
    $("caseFrom")?.addEventListener("change", () => {
      if ($("caseTo").value < $("caseFrom").value) $("caseTo").value = $("caseFrom").value;
      load();
    });
    $("caseTo")?.addEventListener("change", load);
    $("caseToday")?.addEventListener("click", () => { $("caseFrom").value = today(); $("caseTo").value = today(); load(); });
  });
})();
