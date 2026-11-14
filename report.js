// =========================================================
// Sorti · Report ESG (Excel) — generato interamente nel browser
// Struttura allineata a GRI 306 (Rifiuti 2020) ed ESRS E5 (CSRD);
// emissioni evitate riportate separatamente (GHG Protocol / GRI 305 / ESRS E1).
// =========================================================
(() => {
  const EXCELJS_URL = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  const LS_ORG = "sorti_report_org";

  // Palette Sorti (ARGB per Excel)
  const C = {
    green: "FF7EDA55",   // verde lime Sorti
    brand: "FF132A4D",   // intestazioni tabelle (blu notte chiaro)
    blue: "FF09182F",    // blu notte Sorti
    ink: "FF0F1E1B",
    muted: "FF66766F",
    soft: "FFF0F9EA",
    softBlue: "FFEAEEF5",
    line: "FFE2E8E6",
    white: "FFFFFFFF",
    warnSoft: "FFFFF6DB",
  };

  const S = () => window.__sorti;

  // ---------- Utilità ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error("Impossibile caricare la libreria Excel (connessione a cdn.jsdelivr.net)."));
      document.head.appendChild(el);
    });
  }

  async function ensureExcelJS() {
    if (window.ExcelJS) return window.ExcelJS;
    await loadScript(EXCELJS_URL);
    if (!window.ExcelJS) throw new Error("Libreria Excel non disponibile.");
    return window.ExcelJS;
  }

  const kg = (g) => Math.round((Number(g || 0) / 1000) * 1000) / 1000;
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const itDate = (d) => d.toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });
  const parseDay = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  };
  const slug = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
  const cap = (s) => { const t = String(s || "").trim(); return t ? t[0].toUpperCase() + t.slice(1) : "—"; };

  // Classificazione della destinazione prevista per frazione
  function classify(material) {
    const m = String(material || "").toLowerCase();
    if (/indiff|secco|resid|general|mixed|altro|other/.test(m)) {
      return { group: "disposal", op: "Smaltimento (termovalorizzazione o discarica)", ref: "GRI 306-5 · ESRS E5-5 (37c)" };
    }
    if (/organ|umid|food|bio|compost/.test(m)) {
      return { group: "recovery", op: "Altre operazioni di recupero (compostaggio / digestione anaerobica)", ref: "GRI 306-4 · ESRS E5-5 (37b)" };
    }
    if (/plast|pet|cart|paper|card|vetr|glass|metal|allum|alumin|latt|accia|steel|can/.test(m)) {
      return { group: "recovery", op: "Riciclo", ref: "GRI 306-4 · ESRS E5-5 (37b)" };
    }
    return { group: "unclassified", op: "Da classificare con il gestore rifiuti", ref: "—" };
  }

  // ---------- Raccolta dati ----------
  async function collectData(days) {
    const { apiUrl, fetchJSON, adminKey } = S();
    const headers = adminKey() ? { "X-API-Key": adminKey() } : {};
    const dash = await fetchJSON(apiUrl(`/api/dashboard?days=${days}&events_limit=1`), { headers });
    const bins = Array.isArray(dash?.bins) ? dash.bins : [];

    // Dettaglio per cestino: materiali e andamento nel periodo
    const details = await Promise.allSettled(bins.map(b =>
      fetchJSON(apiUrl(`/api/bins/${encodeURIComponent(b.bin_id)}?days=${days}&events_limit=1`), { headers })
    ));

    const notes = [];
    const matMap = new Map();
    const perBin = [];
    let okDetails = 0;

    bins.forEach((b, i) => {
      const r = details[i];
      let w = null, co2 = null;
      if (r.status === "fulfilled") {
        okDetails++;
        const d = r.value || {};
        const daily = Array.isArray(d.daily) ? d.daily : [];
        w = daily.reduce((s, x) => s + Number(x.weight_g || 0), 0);
        co2 = daily.reduce((s, x) => s + Number(x.co2_saved_g || 0), 0);
        for (const m of (d.by_material || [])) {
          const key = String(m.material || "non specificato").trim().toLowerCase();
          const cur = matMap.get(key) || { material: key, weight_g: 0, co2_g: 0, hasCo2: false };
          cur.weight_g += Number(m.weight_g || 0);
          if (m.co2_saved_g !== undefined && m.co2_saved_g !== null) {
            cur.co2_g += Number(m.co2_saved_g || 0);
            cur.hasCo2 = true;
          }
          matMap.set(key, cur);
        }
      }
      perBin.push({ bin: b, weight_g: w, co2_g: co2 });
    });

    let materialsScope = "period";
    if (bins.length && okDetails === 0) {
      // Ripiego: ripartizione materiali della dashboard (potrebbe non essere limitata al periodo)
      materialsScope = "dashboard";
      for (const m of (dash?.by_material || [])) {
        const key = String(m.material || "non specificato").trim().toLowerCase();
        matMap.set(key, {
          material: key, weight_g: Number(m.weight_g || 0),
          co2_g: Number(m.co2_saved_g || 0), hasCo2: m.co2_saved_g !== undefined
        });
      }
      notes.push("Il dettaglio per cestino non era disponibile: la ripartizione per materiale proviene dal riepilogo generale e potrebbe includere dati esterni al periodo.");
    } else if (okDetails < bins.length) {
      notes.push(`Dettaglio non disponibile per ${bins.length - okDetails} cestino/i su ${bins.length}: la ripartizione per materiale potrebbe essere incompleta.`);
    }

    const daily = (Array.isArray(dash?.daily) ? dash.daily : []).map(r => ({
      day: r.day, date: parseDay(r.day), weight_g: Number(r.weight_g || 0), co2_g: Number(r.co2_saved_g || 0)
    }));

    const totalW = daily.reduce((s, r) => s + r.weight_g, 0);
    const totalCO2 = daily.reduce((s, r) => s + r.co2_g, 0);
    const materials = [...matMap.values()].sort((a, b) => b.weight_g - a.weight_g);
    const matW = materials.reduce((s, m) => s + m.weight_g, 0);

    if (totalW > 0 && matW > 0 && Math.abs(matW - totalW) / totalW > 0.01) {
      notes.push(`Il totale per materiale (${kg(matW).toLocaleString("it-IT")} kg) differisce dal totale giornaliero (${kg(totalW).toLocaleString("it-IT")} kg): verificare la completezza dei dati.`);
    }

    // Periodo
    const end = new Date(); end.setHours(0, 0, 0, 0);
    const start = new Date(end); start.setDate(start.getDate() - (days - 1));
    const firstDay = daily.find(r => r.date)?.date;
    const lastDay = [...daily].reverse().find(r => r.date)?.date;

    return {
      days, dash, bins, perBin, daily, materials, materialsScope, notes,
      totalW: totalW || matW, totalCO2,
      start: firstDay && firstDay < start ? firstDay : start,
      end: lastDay && lastDay > end ? lastDay : end,
      allTime: { w: Number(dash?.totals?.total_weight_g || 0), co2: Number(dash?.totals?.total_co2_saved_g || 0) },
    };
  }

  // ---------- Immagini (logo e grafici) ----------
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // Banner con il logo ufficiale Sorti su fondo blu notte
  async function brandBanner() {
    try { await document.fonts?.ready; } catch { }
    const W = 1040, H = 170;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d");
    x.fillStyle = "#09182F"; x.fillRect(0, 0, W, H);

    let logoW = 0;
    try {
      const logo = await loadImage("./assets/sorti-logo.png");
      const h = 104, w = Math.round(logo.width * (h / logo.height));
      x.imageSmoothingQuality = "high";
      x.drawImage(logo, 28, (H - 8 - h) / 2, w, h);
      logoW = w;
    } catch {
      x.fillStyle = "#7EDA55";
      x.font = `800 72px "Plus Jakarta Sans", Arial, sans-serif`;
      x.fillText("SORTI", 40, 108);
      logoW = 240;
    }

    const font = '"Plus Jakarta Sans", "Segoe UI", Arial, sans-serif';
    const tx = 28 + logoW + 36;
    x.fillStyle = "rgba(255,255,255,.18)"; x.fillRect(tx - 18, 40, 2, 82);
    x.fillStyle = "#ffffff";
    x.font = `800 34px ${font}`;
    x.fillText("Report ESG", tx, 82);
    x.fillStyle = "#7EDA55";
    x.font = `700 20px ${font}`;
    x.fillText("Butta qui, smista lui.", tx, 116);

    x.fillStyle = "#7EDA55"; x.fillRect(0, H - 8, W, 8);
    return c.toDataURL("image/png");
  }

  const whiteBg = {
    id: "whiteBg",
    beforeDraw(chart) {
      const { ctx, width, height } = chart;
      ctx.save(); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height); ctx.restore();
    }
  };

  function renderChart(config, w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.style.cssText = `position:fixed;left:-10000px;top:0;width:${w}px;height:${h}px`;
    document.body.appendChild(c);
    config.options = Object.assign({ responsive: false, animation: false, devicePixelRatio: 2 }, config.options || {});
    config.plugins = [whiteBg, ...(config.plugins || [])];
    const ch = new Chart(c.getContext("2d"), config);
    const url = ch.toBase64Image("image/png", 1);
    ch.destroy();
    c.remove();
    return url;
  }

  function chartImages(data) {
    const font = { family: '"Plus Jakarta Sans", "Segoe UI", Arial, sans-serif', size: 12, weight: "600" };
    const out = {};
    if (data.daily.length) {
      out.trend = renderChart({
        type: "bar",
        data: {
          labels: data.daily.map(r => r.date ? r.date.toLocaleDateString("it-IT", { day: "2-digit", month: "short" }) : r.day),
          datasets: [
            {
              type: "line", label: "CO₂e evitata (kg)", yAxisID: "y1",
              data: data.daily.map(r => kg(r.co2_g)),
              borderColor: "#09182F", backgroundColor: "#09182F", borderWidth: 2.5, pointRadius: 0, tension: .35
            },
            {
              label: "Rifiuti raccolti (kg)", yAxisID: "y",
              data: data.daily.map(r => kg(r.weight_g)),
              backgroundColor: "rgba(126,218,85,.85)", borderRadius: 3
            }
          ]
        },
        options: {
          plugins: { legend: { position: "top", align: "start", labels: { font, color: "#3b4b47", usePointStyle: true, boxWidth: 10 } } },
          scales: {
            x: { grid: { display: false }, ticks: { font, color: "#66766f", maxRotation: 0, autoSkipPadding: 14 } },
            y: { beginAtZero: true, grid: { color: "#e9eeec" }, ticks: { font, color: "#66766f" }, title: { display: true, text: "kg rifiuti", font, color: "#66766f" } },
            y1: { beginAtZero: true, position: "right", grid: { display: false }, ticks: { font, color: "#09182F" }, title: { display: true, text: "kg CO₂e", font, color: "#09182F" } }
          }
        }
      }, 820, 320);
    }
    if (data.materials.some(m => m.weight_g > 0)) {
      out.materials = renderChart({
        type: "doughnut",
        data: {
          labels: data.materials.map(m => cap(m.material)),
          datasets: [{
            data: data.materials.map(m => kg(m.weight_g)),
            backgroundColor: data.materials.map(m => S().materialColor(m.material)),
            borderColor: "#fff", borderWidth: 3
          }]
        },
        options: {
          cutout: "62%",
          plugins: { donutCenterText: false, legend: { position: "right", labels: { font, color: "#3b4b47", usePointStyle: true, padding: 14 } } }
        }
      }, 520, 260);
    }
    return out;
  }

  // ---------- Stili Excel ----------
  const border = { top: { style: "thin", color: { argb: C.line } }, bottom: { style: "thin", color: { argb: C.line } }, left: { style: "thin", color: { argb: C.line } }, right: { style: "thin", color: { argb: C.line } } };
  const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
  const FMT_KG = '#,##0.00 "kg"';
  const FMT_T = '#,##0.000 "t"';
  const FMT_PCT = "0.0%";
  const FMT_NUM = "#,##0.00";

  function sheetHeader(ws, title, subtitle, cols) {
    ws.mergeCells(1, 1, 1, cols);
    ws.mergeCells(2, 1, 2, cols);
    const t = ws.getCell(1, 1);
    t.value = title;
    t.font = { name: "Calibri", size: 16, bold: true, color: { argb: C.green } };
    t.fill = fill(C.blue);
    t.alignment = { vertical: "middle", indent: 1 };
    ws.getRow(1).height = 30;
    const s = ws.getCell(2, 1);
    s.value = subtitle;
    s.font = { name: "Calibri", size: 10, italic: true, color: { argb: C.muted } };
    s.fill = fill(C.soft);
    s.alignment = { vertical: "middle", indent: 1, wrapText: true };
    ws.getRow(2).height = 20;
    // linea "brand" verde sotto l'intestazione
    for (let c = 1; c <= cols; c++) ws.getCell(2, c).border = { bottom: { style: "medium", color: { argb: C.green } } };
  }

  function tableHeader(row) {
    row.eachCell(cell => {
      cell.font = { bold: true, color: { argb: C.white }, size: 10 };
      cell.fill = fill(C.brand);
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = border;
    });
    row.height = 30;
  }

  function bodyRow(row, zebra) {
    row.eachCell({ includeEmpty: true }, cell => {
      cell.border = border;
      cell.alignment = Object.assign({ vertical: "middle", wrapText: true }, cell.alignment || {});
      if (zebra) cell.fill = fill("FFF7F9F8");
    });
  }

  function totalRow(row, argb = C.soft) {
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = Object.assign({}, cell.font || {}, { bold: true, color: { argb: C.ink } });
      cell.fill = fill(argb);
      cell.border = border;
      cell.alignment = Object.assign({ vertical: "middle", wrapText: true }, cell.alignment || {});
    });
  }

  // ---------- Costruzione del workbook ----------
  async function buildWorkbook(data, org) {
    const ExcelJS = await ensureExcelJS();
    const wb = new ExcelJS.Workbook();
    wb.creator = "Sorti SmartBin Console";
    wb.created = new Date();
    wb.title = "Report ESG – Gestione dei rifiuti";

    const periodTxt = `${itDate(data.start)} – ${itDate(data.end)} (${data.days} giorni)`;
    const genTxt = new Date().toLocaleString("it-IT", { dateStyle: "long", timeStyle: "short" });

    // Aggregati GRI 306
    const groups = { recovery: 0, disposal: 0, unclassified: 0 };
    const opTotals = {};
    for (const m of data.materials) {
      const cl = classify(m.material);
      m.cls = cl;
      groups[cl.group] += m.weight_g;
      opTotals[cl.op] = (opTotals[cl.op] || 0) + m.weight_g;
    }
    const matTot = data.materials.reduce((s, m) => s + m.weight_g, 0);
    const recoveryShare = matTot > 0 ? groups.recovery / matTot : 0;

    const banner = await brandBanner();
    const charts = chartImages(data);
    const bannerId = wb.addImage({ base64: banner, extension: "png" });

    // ===== 1. Sintesi =====
    const ws = wb.addWorksheet("Sintesi", { views: [{ showGridLines: false }], properties: { tabColor: { argb: C.green } } });
    ws.columns = [{ width: 3 }, { width: 64 }, { width: 18 }, { width: 12 }, { width: 3 }, { width: 22 }, { width: 22 }, { width: 22 }];
    ws.addImage(bannerId, { tl: { col: 1, row: 0.3 }, ext: { width: 640, height: 105 } });
    for (let r = 1; r <= 6; r++) ws.getRow(r).height = 18;

    const put = (r, c, v, style = {}) => { const cell = ws.getCell(r, c); cell.value = v; Object.assign(cell, style); return cell; };
    put(7, 2, "Report ESG · Gestione dei rifiuti", { font: { size: 20, bold: true, color: { argb: C.ink } } });
    ws.getRow(7).height = 30;
    put(8, 2, org ? org : "Organizzazione non specificata", { font: { size: 13, bold: true, color: { argb: C.blue } } });
    put(10, 2, "Periodo di rendicontazione", { font: { color: { argb: C.muted }, size: 10 } });
    put(10, 3, periodTxt, { font: { bold: true } });
    put(11, 2, "Data di generazione", { font: { color: { argb: C.muted }, size: 10 } });
    put(11, 3, genTxt);
    put(12, 2, "Fonte dei dati", { font: { color: { argb: C.muted }, size: 10 } });
    put(12, 3, `Sistema Sorti SmartBin · ${data.bins.length} cestini intelligenti`);
    put(13, 2, "Riferimenti", { font: { color: { argb: C.muted }, size: 10 } });
    put(13, 3, "GRI 306 (Rifiuti 2020) · ESRS E5 (Uso delle risorse ed economia circolare)");

    // KPI
    const kpiStart = 15;
    const kh = ws.getRow(kpiStart);
    ws.getCell(kpiStart, 2).value = "Indicatore";
    ws.getCell(kpiStart, 3).value = "Valore";
    ws.getCell(kpiStart, 4).value = "Unità";
    [2, 3, 4].forEach(c => {
      const cell = ws.getCell(kpiStart, c);
      cell.font = { bold: true, color: { argb: C.white }, size: 10 };
      cell.fill = fill(C.blue);
      cell.border = border;
      cell.alignment = { vertical: "middle", horizontal: c === 2 ? "left" : "center", indent: c === 2 ? 1 : 0 };
    });
    kh.height = 24;
    const kpis = [
      ["Rifiuti raccolti nel periodo (GRI 306-3)", kg(data.totalW), "kg", FMT_NUM],
      ["  di cui con destinazione prevista a recupero (GRI 306-4)", kg(groups.recovery), "kg", FMT_NUM],
      ["  di cui con destinazione prevista a smaltimento (GRI 306-5)", kg(groups.disposal), "kg", FMT_NUM],
      ...(groups.unclassified > 0 ? [["  di cui da classificare", kg(groups.unclassified), "kg", FMT_NUM]] : []),
      ["Tasso di raccolta differenziata", recoveryShare, "%", FMT_PCT],
      ["Emissioni di CO₂e evitate (stima, non deducibile da Scope 1-3)", kg(data.totalCO2), "kg CO₂e", FMT_NUM],
      ["Cestini monitorati", data.bins.length, "n.", "0"],
      ["Rifiuti raccolti dall'attivazione (storico)", kg(data.allTime.w), "kg", FMT_NUM],
      ["CO₂e evitata dall'attivazione (storico, stima)", kg(data.allTime.co2), "kg CO₂e", FMT_NUM],
    ];
    kpis.forEach((k, i) => {
      const r = kpiStart + 1 + i;
      const row = ws.getRow(r);
      ws.getCell(r, 2).value = k[0];
      ws.getCell(r, 3).value = k[1];
      ws.getCell(r, 3).numFmt = k[3];
      ws.getCell(r, 4).value = k[2];
      [2, 3, 4].forEach(c => {
        const cell = ws.getCell(r, c);
        cell.border = border;
        cell.alignment = { vertical: "middle", horizontal: c === 2 ? "left" : c === 3 ? "right" : "center", indent: c === 2 ? 1 : 0 };
        if (i === 0 || k[0].startsWith("Tasso") || k[0].startsWith("Emissioni")) {
          cell.font = { bold: true, color: { argb: c === 3 ? C.brand : C.ink }, size: c === 3 ? 12 : 11 };
          cell.fill = fill(C.soft);
        } else if (k[0].startsWith("  ")) {
          cell.font = { color: { argb: C.muted } };
        }
      });
      row.height = 22;
    });

    let r = kpiStart + kpis.length + 2;
    ws.getRow(r - 1).addPageBreak();
    put(r, 2, "Andamento nel periodo", { font: { size: 13, bold: true, color: { argb: C.ink } } });
    r += 1;
    if (charts.trend) {
      ws.addImage(wb.addImage({ base64: charts.trend, extension: "png" }), { tl: { col: 1, row: r }, ext: { width: 820, height: 320 } });
      r += 18;
    } else {
      put(r, 2, "Nessun dato giornaliero nel periodo.", { font: { italic: true, color: { argb: C.muted } } });
      r += 2;
    }
    put(r, 2, "Ripartizione per frazione", { font: { size: 13, bold: true, color: { argb: C.ink } } });
    r += 1;
    if (charts.materials) {
      ws.addImage(wb.addImage({ base64: charts.materials, extension: "png" }), { tl: { col: 1, row: r }, ext: { width: 520, height: 260 } });
      r += 18;
    } else {
      put(r, 2, "Nessun dato sui materiali nel periodo.", { font: { italic: true, color: { argb: C.muted } } });
      r += 2;
    }
    put(r, 2, "Le destinazioni sono previste in base alla frazione raccolta e vanno confermate con il gestore dei rifiuti. Vedi il foglio “Metodologia”.",
      { font: { italic: true, size: 9, color: { argb: C.muted } } });

    // ===== 2. Rifiuti (GRI 306 · ESRS E5) =====
    const w2 = wb.addWorksheet("Rifiuti GRI 306 - ESRS E5", { views: [{ showGridLines: false, state: "frozen", ySplit: 4 }], properties: { tabColor: { argb: C.brand } } });
    w2.columns = [{ width: 36 }, { width: 16 }, { width: 14 }, { width: 13 }, { width: 46 }, { width: 28 }, { width: 28 }];
    sheetHeader(w2, "Rifiuti raccolti per frazione e destinazione prevista",
      `Periodo: ${periodTxt} · ${org || "Organizzazione non specificata"}`, 7);
    const h2 = w2.getRow(4);
    h2.values = ["Frazione", "Peso (kg)", "Peso (t)", "% sul totale", "Destinazione prevista", "Riferimento", "Pericolosità"];
    tableHeader(h2);
    data.materials.forEach((m, i) => {
      const row = w2.addRow([cap(m.material), kg(m.weight_g), kg(m.weight_g) / 1000, matTot > 0 ? m.weight_g / matTot : 0, m.cls.op, m.cls.ref, "Non pericoloso (da verificare)"]);
      row.getCell(2).numFmt = FMT_KG; row.getCell(3).numFmt = FMT_T; row.getCell(4).numFmt = FMT_PCT;
      bodyRow(row, i % 2 === 1);
      row.getCell(1).font = { bold: true, color: { argb: (S().materialColor(m.material) || "#0F1E1B").replace("#", "FF").toUpperCase() } };
    });
    if (!data.materials.length) {
      const row = w2.addRow(["Nessun dato nel periodo"]);
      row.getCell(1).font = { italic: true, color: { argb: C.muted } };
    }
    w2.addRow([]);
    const sumRows = [
      ["Totale rifiuti raccolti", matTot, "GRI 306-3 · ESRS E5-5 (37a)", C.softBlue],
      ["Destinazione prevista: recupero", groups.recovery, "GRI 306-4 · ESRS E5-5 (37b)", C.soft],
      ["Destinazione prevista: smaltimento", groups.disposal, "GRI 306-5 · ESRS E5-5 (37c)", C.soft],
    ];
    if (groups.unclassified > 0) sumRows.push(["Da classificare", groups.unclassified, "—", C.warnSoft]);
    for (const [label, g, ref, col] of sumRows) {
      const row = w2.addRow([label, kg(g), kg(g) / 1000, matTot > 0 ? g / matTot : 0, "", ref, ""]);
      row.getCell(2).numFmt = FMT_KG; row.getCell(3).numFmt = FMT_T; row.getCell(4).numFmt = FMT_PCT;
      totalRow(row, col);
    }
    w2.addRow([]);
    const opHead = w2.addRow(["Operazione prevista (GRI 306-4b / 306-5b)", "Peso (kg)", "Peso (t)", "% sul totale"]);
    tableHeader(opHead);
    Object.entries(opTotals).sort((a, b) => b[1] - a[1]).forEach(([op, g], i) => {
      const row = w2.addRow([op, kg(g), kg(g) / 1000, matTot > 0 ? g / matTot : 0]);
      row.getCell(2).numFmt = FMT_KG; row.getCell(3).numFmt = FMT_T; row.getCell(4).numFmt = FMT_PCT;
      bodyRow(row, i % 2 === 1);
    });
    w2.addRow([]);
    const n2 = w2.addRow(["Nota: Sorti misura i rifiuti conferiti e separati alla fonte. L'effettivo avvio a riciclo/recupero e la sede delle operazioni (in sito / fuori sito, GRI 306-4c e 306-5c) devono essere confermati dai formulari o dalle dichiarazioni del gestore."]);
    w2.mergeCells(n2.number, 1, n2.number, 7);
    n2.getCell(1).font = { italic: true, size: 9, color: { argb: C.muted } };
    n2.getCell(1).alignment = { wrapText: true, vertical: "top" };
    n2.height = 34;

    // ===== 3. Emissioni evitate =====
    const w3 = wb.addWorksheet("Emissioni evitate", { views: [{ showGridLines: false, state: "frozen", ySplit: 4 }], properties: { tabColor: { argb: C.blue } } });
    w3.columns = [{ width: 26 }, { width: 20 }, { width: 20 }, { width: 22 }];
    sheetHeader(w3, "Emissioni di CO₂e evitate (stima)",
      "Riportate separatamente dall'inventario GHG: non vanno sottratte dalle emissioni Scope 1, 2 o 3 (GHG Protocol · GRI 305 · ESRS E1).", 4);
    const anyMatCo2 = data.materials.some(m => m.hasCo2);
    const h3 = w3.getRow(4);
    h3.values = ["Frazione", "Rifiuti (kg)", "CO₂e evitata (kg)", "kg CO₂e per kg di rifiuto"];
    tableHeader(h3);
    if (anyMatCo2) {
      data.materials.forEach((m, i) => {
        const row = w3.addRow([cap(m.material), kg(m.weight_g), kg(m.co2_g), m.weight_g > 0 ? m.co2_g / m.weight_g : 0]);
        row.getCell(2).numFmt = FMT_KG; row.getCell(3).numFmt = FMT_KG; row.getCell(4).numFmt = "0.000";
        bodyRow(row, i % 2 === 1);
      });
    } else {
      const row = w3.addRow(["Ripartizione per frazione non disponibile dal sistema"]);
      w3.mergeCells(row.number, 1, row.number, 4);
      row.getCell(1).font = { italic: true, color: { argb: C.muted } };
    }
    const t3 = w3.addRow(["Totale periodo", kg(data.totalW), kg(data.totalCO2), data.totalW > 0 ? data.totalCO2 / data.totalW : 0]);
    t3.getCell(2).numFmt = FMT_KG; t3.getCell(3).numFmt = FMT_KG; t3.getCell(4).numFmt = "0.000";
    totalRow(t3, C.softBlue);

    // ===== 4. Andamento giornaliero =====
    const w4 = wb.addWorksheet("Andamento giornaliero", { views: [{ showGridLines: false, state: "frozen", ySplit: 4 }] });
    w4.columns = [{ width: 16 }, { width: 20 }, { width: 22 }];
    sheetHeader(w4, "Andamento giornaliero", `Periodo: ${periodTxt}`, 3);
    const h4 = w4.getRow(4);
    h4.values = ["Data", "Rifiuti raccolti (kg)", "CO₂e evitata (kg, stima)"];
    tableHeader(h4);
    const firstDataRow = 5;
    data.daily.forEach((d, i) => {
      const row = w4.addRow([d.date || d.day, kg(d.weight_g), kg(d.co2_g)]);
      if (d.date) row.getCell(1).numFmt = "dd/mm/yyyy";
      row.getCell(2).numFmt = FMT_KG; row.getCell(3).numFmt = FMT_KG;
      bodyRow(row, i % 2 === 1);
    });
    if (data.daily.length) {
      const last = firstDataRow + data.daily.length - 1;
      const row = w4.addRow(["Totale", { formula: `SUM(B${firstDataRow}:B${last})`, result: kg(data.totalW) }, { formula: `SUM(C${firstDataRow}:C${last})`, result: kg(data.totalCO2) }]);
      row.getCell(2).numFmt = FMT_KG; row.getCell(3).numFmt = FMT_KG;
      totalRow(row, C.soft);
    }

    // ===== 5. Cestini =====
    const w5 = wb.addWorksheet("Cestini", { views: [{ showGridLines: false, state: "frozen", ySplit: 4 }] });
    w5.columns = [{ width: 22 }, { width: 18 }, { width: 18 }, { width: 16 }, { width: 14 }, { width: 18 }, { width: 22 }];
    sheetHeader(w5, "Dettaglio per cestino", `Periodo: ${periodTxt} · stato al ${genTxt}`, 7);
    const h5 = w5.getRow(4);
    h5.values = ["Cestino", "Rifiuti nel periodo (kg)", "CO₂e evitata (kg)", "Riempimento attuale", "Stato", "Capacità (kg)", "Ultimo conferimento"];
    tableHeader(h5);
    data.perBin.forEach((p, i) => {
      const b = p.bin;
      const fill = S().getFillPercent(b) / 100;
      const st = S().statusOf(S().binStatusFill(b));
      const last = S().isoToDate(b.last_seen);
      const row = w5.addRow([
        b.bin_id,
        p.weight_g === null ? "n.d." : kg(p.weight_g),
        p.co2_g === null ? "n.d." : kg(p.co2_g),
        fill, S().STATUS_LABEL[st], kg(b.capacity_g), last || "—"
      ]);
      row.getCell(2).numFmt = FMT_KG; row.getCell(3).numFmt = FMT_KG; row.getCell(4).numFmt = "0%";
      row.getCell(6).numFmt = FMT_KG;
      if (last) row.getCell(7).numFmt = "dd/mm/yyyy hh:mm";
      bodyRow(row, i % 2 === 1);
      row.getCell(1).font = { bold: true };
      const stColor = st === "crit" ? "FFC0272D" : st === "warn" ? "FF8F6400" : "FF137A3A";
      row.getCell(5).font = { bold: true, color: { argb: stColor } };
    });

    // ===== 6. Metodologia =====
    const w6 = wb.addWorksheet("Metodologia", { views: [{ showGridLines: false }] });
    w6.columns = [{ width: 30 }, { width: 100 }];
    sheetHeader(w6, "Metodologia, ipotesi e limiti", "Da allegare al report per garantire trasparenza e verificabilità dei dati.", 2);
    const meth = [
      ["Fonte dei dati", "Dati misurati dai cestini intelligenti Sorti: ogni conferimento viene riconosciuto (frazione) e pesato dal dispositivo e registrato con data e ora."],
      ["Perimetro", `${data.bins.length} cestini Sorti dell'organizzazione. Il report copre solo i rifiuti conferiti in questi cestini, non la totalità dei rifiuti prodotti dall'organizzazione.`],
      ["Periodo", periodTxt],
      ["GRI 306-3 · ESRS E5-5 (37a)", "Rifiuti generati: somma dei pesi registrati nel periodo, espressi in kg e tonnellate."],
      ["GRI 306-4 · ESRS E5-5 (37b)", "Rifiuti sottratti allo smaltimento: frazioni raccolte separatamente (plastica, carta, vetro, metalli, organico), con destinazione PREVISTA a riciclo o altre operazioni di recupero."],
      ["GRI 306-5 · ESRS E5-5 (37c)", "Rifiuti destinati allo smaltimento: frazione indifferenziata/residua, con destinazione PREVISTA a termovalorizzazione o discarica."],
      ["Destinazione effettiva", "Il sistema registra la separazione alla fonte. L'effettivo trattamento a valle (riciclo, recupero, smaltimento) e la sede delle operazioni vanno confermati con formulari di identificazione rifiuti, MUD o dichiarazioni del gestore."],
      ["Pericolosità", "Le frazioni raccolte sono assunte come rifiuti urbani non pericolosi. Verificare eventuali flussi pericolosi (es. RAEE, pile) gestiti separatamente."],
      ["Emissioni evitate", "Stima calcolata dal sistema Sorti applicando fattori di emissione per frazione al peso conferito. Sono emissioni evitate rispetto a uno scenario di riferimento: secondo GHG Protocol, GRI 305 ed ESRS E1 vanno riportate separatamente e non possono essere sottratte dalle emissioni Scope 1, 2 o 3."],
      ["Fattori di emissione", "Indicare qui la fonte dei fattori utilizzati dal backend Sorti (es. database ISPRA, DEFRA, Ecoinvent) e l'anno di riferimento, prima della pubblicazione."],
      ["Stato dei cestini", "Riempimento e stato sono istantanei, rilevati al momento della generazione del report."],
      ["Strumento", "Report generato automaticamente da Sorti SmartBin Console. I valori sono arrotondati al grammo."],
    ];
    meth.forEach(([k, v], i) => {
      const row = w6.addRow([k, v]);
      row.getCell(1).font = { bold: true, color: { argb: C.blue } };
      row.getCell(2).alignment = { wrapText: true, vertical: "top" };
      row.getCell(1).alignment = { wrapText: true, vertical: "top" };
      bodyRow(row, i % 2 === 1);
      row.height = Math.max(20, Math.ceil(v.length / 95) * 15 + 6);
    });
    if (data.notes.length) {
      w6.addRow([]);
      const hn = w6.addRow(["Avvisi sulla qualità dei dati", ""]);
      totalRow(hn, C.warnSoft);
      for (const n of data.notes) {
        const row = w6.addRow(["", n]);
        row.getCell(2).alignment = { wrapText: true, vertical: "top" };
        row.height = Math.max(20, Math.ceil(n.length / 95) * 15 + 6);
      }
    }

    // Carattere uniforme e stampa: orizzontale, adatta alla larghezza
    for (const sh of wb.worksheets) {
      sh.eachRow({ includeEmpty: false }, row => row.eachCell({ includeEmpty: true }, cell => {
        cell.font = Object.assign({ size: 11 }, cell.font || {}, { name: "Calibri" });
      }));
      sh.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, margins: { left: .4, right: .4, top: .5, bottom: .5, header: .3, footer: .3 } };
      sh.headerFooter = { oddFooter: `&L&8Sorti · Report ESG${org ? " · " + org.replace(/&/g, "&&") : ""}&R&8Pagina &P di &N` };
    }

    return wb;
  }

  async function downloadWorkbook(wb, filename) {
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- Avvio ----------
  async function generateEsgReport(btn) {
    const { customAlert, customPrompt, getRangeDays } = S();
    const saved = localStorage.getItem(LS_ORG) || "";
    const org = await customPrompt(
      `Nome dell'organizzazione o del sito (comparirà nel report).\nPeriodo: ultimi ${getRangeDays()} giorni, come selezionato in dashboard.`,
      saved, "Report ESG"
    );
    if (org === null) return;
    const orgName = String(org).trim();
    localStorage.setItem(LS_ORG, orgName);

    const label = btn?.querySelector("span");
    const old = label?.textContent;
    if (btn) { btn.disabled = true; btn.classList.add("busy"); }
    if (label) label.textContent = "Generazione…";
    try {
      const days = getRangeDays();
      const [data] = await Promise.all([collectData(days), ensureExcelJS()]);
      const wb = await buildWorkbook(data, orgName);
      const name = `Sorti_Report_ESG${orgName ? "_" + slug(orgName) : ""}_${ymd(data.start)}_${ymd(data.end)}.xlsx`;
      await downloadWorkbook(wb, name);
    } catch (e) {
      await customAlert("Impossibile generare il report ESG:\n\n" + (e?.message || String(e)), "Errore");
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove("busy"); }
      if (label) label.textContent = old;
    }
  }

  window.__sortiReport = { generateEsgReport, collectData, buildWorkbook };

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-esg-report]").forEach(btn => {
      btn.addEventListener("click", () => {
        const settings = document.getElementById("settingsModal");
        if (settings?.open && settings.contains(btn)) settings.close();
        generateEsgReport(btn);
      });
    });
  });
})();
