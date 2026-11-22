// =========================================================
// Sorti · Notifiche push su questo dispositivo
// Safari (Mac e iPhone/iPad dalla schermata Home), Chrome, Edge, Firefox.
// Richiede il server Sorti API v2 con supporto push (/api/push/public_key).
// =========================================================
(() => {
  const S = () => window.__sorti;
  const $ = (id) => document.getElementById(id);

  let swReg = null;
  let publicKey = null;   // chiave VAPID del server (precaricata, così il clic resta un "gesto" valido per Safari)

  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  function deviceLabel() {
    const dev = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (isIOS && !/iPhone/.test(ua)) ? "iPad"
      : /Android/.test(ua) ? "Android" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Computer";
    const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) && !/Edg\//.test(ua) ? "Chrome"
      : /Safari\//.test(ua) ? "Safari" : "Browser";
    return `${dev} · ${isStandalone ? "app Sorti" : br}`;
  }

  function b64ToUint8(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  function errMessage(e) {
    const raw = String(e?.message || e || "");
    const nl = raw.indexOf("\n");
    if (nl >= 0) {
      try { const j = JSON.parse(raw.slice(nl + 1)); if (typeof j?.detail === "string") return j.detail; } catch { }
      return raw.slice(0, nl);
    }
    return raw;
  }

  async function api(path, { method = "GET", body } = {}) {
    const opts = { method, headers: { "X-API-Key": S().adminKey() } };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return S().fetchJSON(S().apiUrl(path), opts);
  }

  // --- Service worker: registrato sempre, serve a ricevere le notifiche ---
  async function registerSW() {
    if (!("serviceWorker" in navigator)) return null;
    try {
      swReg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      return swReg;
    } catch (e) {
      console.warn("[push] service worker non registrato:", e);
      return null;
    }
  }

  async function currentSubscription() {
    if (!supported) return null;
    const reg = swReg || await navigator.serviceWorker.ready;
    return reg ? reg.pushManager.getSubscription() : null;
  }

  // --- Interfaccia nelle Impostazioni ---
  function setUI({ status, on = false, help = "", buttons = [] }) {
    const st = $("pushStatus");
    st.textContent = status;
    st.classList.toggle("on", on);
    $("pushHelp").innerHTML = help;
    for (const id of ["btnPushOn", "btnPushTest", "btnPushOff"]) {
      $(id).style.display = buttons.includes(id) ? "" : "none";
    }
  }

  async function renderPushSettings() {
    if (!$("pushStatus")) return;
    $("pushDevices").innerHTML = "";

    if (!supported) {
      if (isIOS && !isStandalone) {
        setUI({ status: "Da attivare", help:
          "Su iPhone e iPad le notifiche arrivano solo dall'app Sorti nella schermata Home:<br>" +
          "1. tocca <b>Condividi</b> (il quadrato con la freccia) in Safari;<br>" +
          "2. scegli <b>Aggiungi alla schermata Home</b>;<br>" +
          "3. apri Sorti dall'icona e torna qui. Serve iOS 16.4 o successivo." });
      } else {
        setUI({ status: "Non supportate", help: "Questo browser non supporta le notifiche push. Usa Safari (macOS 13 o successivo), Chrome, Edge o Firefox." });
      }
      return;
    }

    const info = await (window.__sortiRegistry?.serverInfo?.() || Promise.resolve({ v2: false }));
    let keyInfo = null;
    try { keyInfo = info.v2 ? await S().fetchJSON(S().apiUrl("/api/push/public_key")) : null; } catch { keyInfo = null; }
    if (!keyInfo) {
      setUI({ status: "Server da aggiornare", help: "Le notifiche push richiedono il server Sorti aggiornato." });
      return;
    }
    if (!keyInfo.enabled) {
      setUI({ status: "Non disponibili", help: `Il server non riesce a usare le notifiche push: ${S().escapeHtml(keyInfo.error || "errore sconosciuto")}` });
      return;
    }
    publicKey = keyInfo.public_key;

    if (!S().adminKey()) {
      setUI({ status: "—", help: "Salva la Admin key (qui sopra) per attivare le notifiche su questo dispositivo." });
      return;
    }

    if (Notification.permission === "denied") {
      setUI({ status: "Bloccate", help: isIOS
        ? "Le notifiche sono bloccate: riattivale in <b>Impostazioni › Notifiche › Sorti</b> sull'iPhone."
        : "Le notifiche sono bloccate per questo sito: riattivale dalle impostazioni del browser (Safari: <b>Impostazioni › Siti web › Notifiche</b>)." });
      return;
    }

    const sub = await currentSubscription();
    if (sub) {
      setUI({ status: "Attive", on: true, buttons: ["btnPushTest", "btnPushOff"],
        help: `Questo dispositivo (<b>${S().escapeHtml(deviceLabel())}</b>) riceve una notifica quando un cestino è pieno.` });
    } else {
      setUI({ status: "Non attive", buttons: ["btnPushOn"],
        help: "Ricevi una notifica su questo dispositivo quando un cestino è pieno, anche con la dashboard chiusa." });
    }
    renderDevices();
  }

  async function renderDevices() {
    try {
      const list = await api("/api/push/devices");
      if (!list.length) return;
      const fmt = (iso) => { const d = S().isoToDate(iso); return d ? d.toLocaleDateString("it-IT", { day: "2-digit", month: "short" }) : "—"; };
      $("pushDevices").innerHTML = `<div class="notifyLogTitle">Dispositivi attivi (${list.length})</div>` + list.map(d => `
        <div class="notifyItem ${d.last_error ? "error" : "sent"}">
          <span class="nDot"></span>
          <div class="nMain">
            <div class="nSubj">${S().escapeHtml(d.label || "Dispositivo")}</div>
            <div class="nMeta">attivato il ${fmt(d.created_at)}${d.last_ok_at ? ` · ultima notifica ${fmt(d.last_ok_at)}` : ""}${d.last_error ? ` · errore: ${S().escapeHtml(d.last_error.slice(0, 140))}` : ""}</div>
          </div>
        </div>`).join("");
    } catch { /* elenco facoltativo */ }
  }

  async function enablePush() {
    const btn = $("btnPushOn");
    btn.disabled = true;
    try {
      // Primo passo nel gesto dell'utente (obbligatorio su Safari)
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        await S().customAlert(perm === "denied"
          ? "Hai bloccato le notifiche. Puoi riattivarle dalle impostazioni del browser (o dell'iPhone)."
          : "Permesso non concesso: nessuna notifica verrà inviata a questo dispositivo.", "Notifiche");
        return;
      }
      const reg = swReg || await navigator.serviceWorker.ready;
      if (!publicKey) throw new Error("Chiave del server non disponibile: riapri le Impostazioni.");
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(publicKey) });
      }
      await api("/api/push/subscribe", { method: "POST", body: { subscription: sub.toJSON(), label: deviceLabel() } });
      await renderPushSettings();
      await testPush(true);
    } catch (e) {
      await S().customAlert("Attivazione non riuscita:\n\n" + errMessage(e), "Errore");
      renderPushSettings();
    } finally {
      btn.disabled = false;
    }
  }

  async function testPush(silentOk = false) {
    const btn = $("btnPushTest");
    btn.disabled = true;
    try {
      const sub = await currentSubscription();
      if (!sub) throw new Error("Notifiche non attive su questo dispositivo.");
      await api("/api/push/test", { method: "POST", body: { endpoint: sub.endpoint } });
      if (!silentOk) await S().customAlert("Notifica di prova inviata: dovrebbe comparire tra pochi secondi.", "Notifiche");
    } catch (e) {
      await S().customAlert("Notifica di prova non riuscita:\n\n" + errMessage(e), "Errore");
    } finally {
      btn.disabled = false;
      renderDevices();
    }
  }

  async function disablePush() {
    const btn = $("btnPushOff");
    btn.disabled = true;
    try {
      const sub = await currentSubscription();
      if (sub) {
        try { await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }); } catch { }
        await sub.unsubscribe();
      }
    } finally {
      btn.disabled = false;
      renderPushSettings();
    }
  }

  window.__sortiPush = { renderPushSettings };

  document.addEventListener("DOMContentLoaded", () => {
    registerSW();
    $("btnSettings")?.addEventListener("click", () => renderPushSettings());
    $("btnPushOn")?.addEventListener("click", enablePush);
    $("btnPushTest")?.addEventListener("click", () => testPush(false));
    $("btnPushOff")?.addEventListener("click", disablePush);

    // Tocco su una notifica con la dashboard già aperta: apri il cestino
    navigator.serviceWorker?.addEventListener("message", (ev) => {
      if (ev.data?.type === "sorti-open-bin" && ev.data.bin_id) window.__openBin?.(ev.data.bin_id);
    });
  });
})();
