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
    if (!f.has("summary")) {
      $("caseControls").style.display = "none";
      box.innerHTML = `<div class="regNotice">Il riepilogo per caso studio richiede il server Sorti aggiornato (versione 2.3).</div>`;
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
      d = await S().fetchJSON(S().apiUrl(`/api/stats/summary?${q}`));
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
