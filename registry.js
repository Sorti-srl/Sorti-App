// =========================================================
// Sorti · Anagrafica cestini, registro svuotamenti, storico avvisi
// Richiede il server Sorti API v2 (endpoint /api/info). Con il server
// precedente le sezioni mostrano un invito ad aggiornarlo.
// =========================================================
(() => {
  const S = () => window.__sorti;
  const $ = (id) => document.getElementById(id);
  const LS_OPERATOR = "sorti_last_operator";

  let infoPromise = null;
  let currentBin = null;
  let editing = false;

  // --- Capacità del server ---
  function serverInfo() {
    if (!infoPromise) {
      infoPromise = S().fetchJSON(S().apiUrl("/api/info"))
        .then(r => ({ v2: !!r?.ok && String(r.version || "").startsWith("2"), version: r?.version }))
        .catch(() => ({ v2: false }));
    }
    return infoPromise;
  }

  const esc = (v) => S().escapeHtml(v ?? "");
  const adminHeaders = () => ({ "X-API-Key": S().adminKey() });

  function errMessage(e) {
    const raw = String(e?.message || e || "");
    const nl = raw.indexOf("\n");
    if (nl >= 0) {
      try {
        const j = JSON.parse(raw.slice(nl + 1));
        if (typeof j?.detail === "string") return j.detail;
        if (Array.isArray(j?.detail)) return j.detail.map(d => d.msg || JSON.stringify(d)).join("; ");
      } catch { }
      return raw.slice(0, nl);
    }
    return raw;
  }

  async function api(path, { method = "GET", body } = {}) {
    const opts = { method, headers: adminHeaders() };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return S().fetchJSON(S().apiUrl(path), opts);
  }

  const fmtDate = (iso) => {
    const d = S().isoToDate(iso);
    return d ? d.toLocaleString("it-IT", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  };

  function notice(text, kind = "") {
    return `<div class="regNotice ${kind}">${text}</div>`;
  }

  // =========================================================
  // Dettaglio cestino
  // =========================================================
  async function renderDrawer(bin, { soft = false } = {}) {
    currentBin = bin;
    if (!soft) editing = false;
    const info = await serverInfo();
    if (currentBin !== bin) return;
    renderRegistry(bin, info);
    renderEmptyings(bin, info);
  }

  // --- Anagrafica ---
  function renderRegistry(bin, info) {
    const box = $("ddRegistry");
    const btn = $("btnEditRegistry");
    if (!box) return;
    const admin = !!S().adminKey();

    if (!info.v2) {
      btn.style.display = "none";
      box.innerHTML = notice("Per nome, posizione e cliente dei cestini serve il server Sorti aggiornato (versione 2).");
      return;
    }
    btn.style.display = admin && !editing ? "" : "none";

    if (editing) {
      box.innerHTML = `
        <form id="regForm" class="regForm" autocomplete="off">
          <label class="regField"><span>Nome</span><input name="name" maxlength="120" placeholder="es. Hall piano terra" value="${esc(bin.name)}"></label>
          <label class="regField"><span>Posizione</span><input name="location" maxlength="240" placeholder="es. Edificio B, Via Roma 1, Milano" value="${esc(bin.location)}"></label>
          <label class="regField"><span>Cliente / organizzazione</span><input name="organization" maxlength="160" placeholder="es. Università di Milano" value="${esc(bin.organization)}"></label>
          <label class="regField"><span>Capacità (kg)</span><input name="capacity_kg" type="number" min="0.1" step="0.1" value="${bin.capacity_g ? (bin.capacity_g / 1000) : ""}"></label>
          <label class="regField wide"><span>Note</span><textarea name="notes" maxlength="2000" rows="2" placeholder="es. chiavi in portineria, svuotamento il lunedì">${esc(bin.notes)}</textarea></label>
          <div class="regActions wide">
            <span id="regMsg" class="regMsg"></span>
            <button type="button" class="btn btnGhost" id="regCancel">Annulla</button>
            <button type="submit" class="btn btnPrimary" id="regSave">Salva</button>
          </div>
        </form>`;
      $("regCancel").onclick = () => { editing = false; renderRegistry(currentBin, info); };
      $("regForm").onsubmit = (e) => { e.preventDefault(); saveRegistry(e.target, info); };
      $("regForm").querySelector("input[name=name]")?.focus();
      return;
    }

    const row = (k, v, ph = "—") => `<div class="regRow"><span>${k}</span><b class="${v ? "" : "muted"}">${v ? esc(v) : ph}</b></div>`;
    const capTxt = bin.capacity_g ? `${(bin.capacity_g / 1000).toLocaleString("it-IT", { maximumFractionDigits: 1 })} kg` : "";
    box.innerHTML = `
      <div class="regGrid">
        ${row("Nome", bin.name, "non impostato")}
        ${row("Codice", bin.bin_id)}
        ${row("Posizione", bin.location, "non impostata")}
        ${row("Cliente", bin.organization, "non impostato")}
        ${row("Capacità", capTxt)}
        ${bin.notes ? `<div class="regRow wide"><span>Note</span><b>${esc(bin.notes)}</b></div>` : ""}
      </div>
      ${admin ? "" : notice("Per modificare l'anagrafica serve la Admin key (Impostazioni).")}`;
  }

  async function saveRegistry(form, info) {
    const fd = new FormData(form);
    const body = {
      name: fd.get("name") || "",
      location: fd.get("location") || "",
      organization: fd.get("organization") || "",
      notes: fd.get("notes") || "",
    };
    const capKg = Number(String(fd.get("capacity_kg") || "").replace(",", "."));
    if (capKg > 0) body.capacity_g = Math.round(capKg * 1000);
    const msg = $("regMsg");
    const save = $("regSave");
    save.disabled = true;
    msg.textContent = "Salvataggio…";
    msg.className = "regMsg";
    try {
      const r = await api(`/api/bins/${encodeURIComponent(currentBin.bin_id)}`, { method: "PATCH", body });
      editing = false;
      Object.assign(currentBin, r?.bin || {});
      renderRegistry(currentBin, info);
      S().refresh();
      S().reopenDrawer();
    } catch (e) {
      msg.textContent = errMessage(e);
      msg.className = "regMsg err";
      save.disabled = false;
    }
  }

  // --- Svuotamenti ---
  async function renderEmptyings(bin, info) {
    const box = $("ddEmptyings");
    const btn = $("btnRegisterEmpty");
    if (!box) return;
    const admin = !!S().adminKey();
    if (!info.v2) {
      btn.style.display = "none";
      box.innerHTML = notice("Il registro degli svuotamenti richiede il server Sorti aggiornato (versione 2).");
      return;
    }
    btn.style.display = admin ? "" : "none";
    if (!admin) {
      box.innerHTML = notice("Per vedere e registrare gli svuotamenti serve la Admin key (Impostazioni).");
      return;
    }
    let list;
    try {
      list = await api(`/api/bins/${encodeURIComponent(bin.bin_id)}/emptyings?limit=8`);
    } catch (e) {
      box.innerHTML = notice(esc(errMessage(e)), "err");
      return;
    }
    if (currentBin !== bin) return;
    if (!list.length) {
      box.innerHTML = notice("Nessuno svuotamento registrato. Dopo aver cambiato i sacchi premi “Registra svuotamento”: i livelli si azzerano e gli avvisi si riattivano.");
      return;
    }
    const labelOf = (cid) => {
      if (cid == null) return "Tutto il cestino";
      const c = (bin.compartments || []).find(x => String(x.compartment_id) === String(cid));
      return c ? `Scomparto ${c.label}` : `Scomparto ${cid}`;
    };
    box.innerHTML = `<div class="emptyList">${list.map(e => `
      <div class="emptyItem">
        <div class="emptyIcon" aria-hidden="true"></div>
        <div class="emptyMain">
          <div class="emptyWhat">${esc(labelOf(e.compartment_id))}${e.fill_before_percent != null ? ` <span class="muted">· era al ${Math.round(e.fill_before_percent)}%</span>` : ""}</div>
          <div class="emptyMeta">${esc(fmtDate(e.ts))}${e.emptied_by ? ` · ${esc(e.emptied_by)}` : ""}${e.note ? ` · ${esc(e.note)}` : ""}</div>
        </div>
      </div>`).join("")}</div>`;
  }

  function openEmptyDialog() {
    const bin = currentBin;
    if (!bin) return;
    const dlg = $("emptyModal");
    const sel = $("emptyTarget");
    const comps = (bin.compartments || []).slice().sort((a, b) => String(a.compartment_id).localeCompare(String(b.compartment_id), "it", { numeric: true }));
    sel.innerHTML = `<option value="">Tutto il cestino</option>` + comps.map(c =>
      `<option value="${esc(c.compartment_id)}">Scomparto ${esc(c.label)}${c.sensor_fill_percent != null ? ` (${Math.round(c.sensor_fill_percent)}%)` : ""}</option>`).join("");
    $("emptyBinName").textContent = S().binTitle(bin);
    $("emptyBy").value = localStorage.getItem(LS_OPERATOR) || "";
    $("emptyNote").value = "";
    $("emptyMsg").textContent = "";
    $("emptyOk").disabled = false;
    dlg.showModal();
  }

  async function submitEmpty() {
    const bin = currentBin;
    const by = $("emptyBy").value.trim();
    if (by) localStorage.setItem(LS_OPERATOR, by);
    const body = { emptied_by: by || null, note: $("emptyNote").value.trim() || null };
    const cid = $("emptyTarget").value;
    if (cid !== "") body.compartment_id = cid;
    $("emptyOk").disabled = true;
    $("emptyMsg").textContent = "Registrazione…";
    try {
      await api(`/api/bins/${encodeURIComponent(bin.bin_id)}/empty`, { method: "POST", body });
      $("emptyModal").close();
      S().refresh();
      S().reopenDrawer();
    } catch (e) {
      $("emptyMsg").textContent = errMessage(e);
      $("emptyOk").disabled = false;
    }
  }

  // =========================================================
  // Impostazioni: storico degli avvisi di cestino pieno (inviati via push)
  // =========================================================
  async function renderNotifySettings() {
    const log = $("notifyLog");
    if (!log) return;
    log.innerHTML = "";
    const info = await serverInfo();
    if (!info.v2 || !S().adminKey()) return;
    let st;
    try {
      st = await api("/api/notifications/status");
    } catch {
      return;
    }
    const short = (t) => (t || "").length > 140 ? t.slice(0, 140) + "…" : (t || "");
    const rows = (st.recent || []).slice(0, 5);
    log.innerHTML = rows.length ? `<div class="notifyLogTitle">Ultimi avvisi</div>` + rows.map(n => `
      <div class="notifyItem ${n.status}">
        <span class="nDot"></span>
        <div class="nMain">
          <div class="nSubj">${esc(n.subject || n.kind)}</div>
          <div class="nMeta">${esc(fmtDate(n.ts))} · ${n.status === "sent" ? "inviato" : n.status === "error" ? `errore: ${esc(short(n.error))}` : "in invio"}</div>
        </div>
      </div>`).join("") : "";
    if (st.rejected_events > 0) {
      const n = st.rejected_events;
      log.innerHTML += notice(`${n} conferiment${n === 1 ? "o scartato" : "i scartati"} perché non valid${n === 1 ? "o" : "i"} (salvat${n === 1 ? "o" : "i"} sul server nella tabella rejected_events).`, "warn");
    }
  }

  window.__sortiRegistry = { renderDrawer, renderNotifySettings, serverInfo };

  document.addEventListener("DOMContentLoaded", () => {
    $("btnEditRegistry")?.addEventListener("click", async () => {
      editing = true;
      renderRegistry(currentBin, await serverInfo());
    });
    $("btnRegisterEmpty")?.addEventListener("click", openEmptyDialog);
    $("emptyCancel")?.addEventListener("click", () => $("emptyModal").close());
    $("emptyClose")?.addEventListener("click", () => $("emptyModal").close());
    $("emptyForm")?.addEventListener("submit", (e) => { e.preventDefault(); submitEmpty(); });
    $("btnSettings")?.addEventListener("click", () => renderNotifySettings());
  });
})();
