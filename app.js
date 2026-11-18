// Pega aquí tu Client ID de Google Cloud
const CLIENT_ID = "685413975165-tgeug7mgpu3p7ku8it4eh8l31cj5kfni.apps.googleusercontent.com";
// Pega aquí tu Client ID de Google Cloud
const CLIENT_ID = "TU_CLIENT_ID.apps.googleusercontent.com";
const SCOPE = "https://www.googleapis.com/auth/drive";
const DRIVE = "https://www.googleapis.com/drive/v3";
const PALETTE = ["#f5a524", "#3b82f6", "#22c55e", "#ec4899", "#a855f7", "#06b6d4"];
const IDLE_MS = 15 * 60 * 1000;

let tokenClient = null;
let pending = null;
let queue = Promise.resolve();
let key = null;          // clave AES en memoria, solo mientras la app está desbloqueada
let accounts = [];
let files = [];
let shown = [];
let lastActive = Date.now();

const $ = id => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function fmt(n) {
  if (n == null || isNaN(n)) return "?";
  const u = ["B","KB","MB","GB","TB"];
  let i = 0; n = Number(n);
  while (n >= 1024 && i < 4) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + " " + u[i];
}

function colorOf(email) {
  const i = accounts.findIndex(a => a.email === email);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}

function escQ(s) { return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
function setSummary(msg) { $("summary").textContent = msg; }
const byName = (a, b) => a.name.localeCompare(b.name);

// ---------- Cifrado ----------

async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Guarda las cuentas cifradas. El token nunca queda en texto plano.
async function persist() {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = enc.encode(JSON.stringify(
    accounts.map(a => ({ email: a.email, token: a.token, exp: a.exp }))
  ));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  localStorage.setItem("vault", JSON.stringify({ iv: b64(iv), data: b64(data) }));
}

function persistSafe() {
  persist().catch(e => setSummary("No se pudo guardar: " + e.message));
}

// ---------- Bloqueo ----------

function hasVault() { return !!localStorage.getItem("vault"); }

function showLock() {
  const setup = !hasVault();
  $("lock").style.display = "flex";
  $("lockTitle").textContent = setup ? "Crea una contraseña" : "Desbloquear";
  $("lockHint").textContent = setup
    ? "Protege tus cuentas. Si la olvidas no hay forma de recuperarla; tendrías que volver a agregar las cuentas."
    : "Introduce tu contraseña para ver tus cuentas.";
  $("lockPass2").style.display = setup ? "block" : "none";
  $("lockBtn").textContent = setup ? "Crear" : "Entrar";
  $("lockPass").value = "";
  $("lockPass2").value = "";
  $("lockMsg").textContent = "";
  $("lockPass").focus();
}

async function submitLock() {
  const pass = $("lockPass").value;
  const setup = !hasVault();
  $("lockMsg").textContent = "";
  if (!pass) { $("lockMsg").textContent = "Escribe la contraseña"; return; }
  $("lockBtn").disabled = true;
  try {
    if (setup) {
      if (pass.length < 8) throw new Error("Usa al menos 8 caracteres (recomendado 12 o más)");
      if (pass !== $("lockPass2").value) throw new Error("Las contraseñas no coinciden");
      const salt = crypto.getRandomValues(new Uint8Array(16));
      localStorage.setItem("vsalt", b64(salt));
      key = await deriveKey(pass, salt);
      accounts = [];
      await persist();
    } else {
      const salt = unb64(localStorage.getItem("vsalt"));
      const k = await deriveKey(pass, salt);
      const v = JSON.parse(localStorage.getItem("vault"));
      let plain;
      try {
        plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(v.iv) }, k, unb64(v.data));
      } catch {
        throw new Error("Contraseña incorrecta");
      }
      key = k;
      accounts = JSON.parse(dec.decode(plain));
    }
    $("lock").style.display = "none";
    lastActive = Date.now();
    renderAccounts();
    if (accounts.length) refreshAll();
    else setSummary("Agrega una cuenta de Google para empezar.");
  } catch (e) {
    $("lockMsg").textContent = e.message;
  } finally {
    $("lockBtn").disabled = false;
  }
}

function lock() {
  key = null;
  accounts = [];
  files = [];
  shown = [];
  $("results").innerHTML = "";
  setSummary("");
  renderAccounts();
  showLock();
}

setInterval(() => {
  if (key && Date.now() - lastActive > IDLE_MS) lock();
}, 30000);

["pointerdown", "keydown", "scroll"].forEach(ev =>
  document.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true })
);

// ---------- Autenticación Google ----------

function initGis() {
  if (!window.google) return setTimeout(initGis, 300);
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: onToken
  });
}

async function onToken(r) {
  const p = pending;
  pending = null;
  if (r.error) {
    if (p) p.reject(new Error("Google: " + r.error));
    else setSummary("Google no dio acceso: " + r.error);
    return;
  }
  try {
    const info = await (await fetch(`${DRIVE}/about?fields=user(emailAddress)`, {
      headers: { Authorization: "Bearer " + r.access_token }
    })).json();
    const email = info.user && info.user.emailAddress;
    if (!email) throw new Error("No se pudo leer el correo de la cuenta");

    let acc = accounts.find(a => a.email === email);
    if (!acc) { acc = { email }; accounts.push(acc); }
    acc.token = r.access_token;
    acc.exp = Date.now() + Number(r.expires_in) * 1000;
    acc.error = "";
    persistSafe();

    if (p && p.email && p.email !== email) {
      p.reject(new Error("Se conectó " + email + " pero se esperaba " + p.email));
      refreshAll();
    } else if (p) {
      p.resolve(acc.token);
    } else {
      refreshAll();
    }
  } catch (e) {
    if (p) p.reject(e);
    else setSummary(e.message);
  }
}

function connect() {
  if (!key) return;
  if (!tokenClient) return setSummary("Google todavía está cargando, intenta de nuevo.");
  pending = null;
  tokenClient.requestAccessToken({ prompt: "select_account" });
}

// Pide tokens de una cuenta de una en una, con límite de tiempo.
// Así una cuenta que no responde no bloquea a las demás.
function tokenFor(acc) {
  if (acc.token && Date.now() < acc.exp - 60000) return Promise.resolve(acc.token);
  const job = () => new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error("Google todavía está cargando"));
    const timer = setTimeout(() => {
      if (pending && pending.email === acc.email) pending = null;
      reject(new Error("Sesión caducada. Pulsa Agregar cuenta y elígela de nuevo."));
    }, 15000);
    pending = {
      email: acc.email,
      resolve: t => { clearTimeout(timer); resolve(t); },
      reject: e => { clearTimeout(timer); reject(e); }
    };
    tokenClient.requestAccessToken({ prompt: "", hint: acc.email });
  });
  const run = queue.then(job);
  queue = run.catch(() => {});
  return run;
}

function removeAccount(email) {
  if (!confirm("Quitar " + email + " de la app?")) return;
  const acc = accounts.find(a => a.email === email);
  if (acc && acc.token && window.google) google.accounts.oauth2.revoke(acc.token, () => {});
  accounts = accounts.filter(a => a.email !== email);
  files = files.filter(f => f.acc !== email);
  persistSafe();
  renderAccounts();
  runSearch();
}

// ---------- Llamadas a Drive ----------

async function api(acc, url, opts = {}) {
  const send = t => fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + t } });
  let r = await send(await tokenFor(acc));
  if (r.status === 401) {
    acc.token = "";
    r = await send(await tokenFor(acc));
  }
  if (!r.ok) throw new Error(acc.email + ": " + r.status + " " + (await r.text()).slice(0, 150));
  return r;
}

async function listNames(acc) {
  const out = [];
  let pt = "";
  do {
    const q = new URLSearchParams({
      pageSize: "200",
      fields: "nextPageToken,files(id,name,size)",
      q: "trashed=false and not mimeType contains 'application/vnd.google-apps'"
    });
    if (pt) q.set("pageToken", pt);
    const j = await (await api(acc, `${DRIVE}/files?` + q)).json();
    out.push(...(j.files || []).map(f => ({ id: f.id, name: f.name, size: Number(f.size), acc: acc.email })));
    pt = j.nextPageToken;
  } while (pt && out.length < 5000);
  return out;
}

async function refreshAll() {
  files = [];
  for (const acc of accounts) {
    try {
      const j = await (await api(acc, `${DRIVE}/about?fields=storageQuota`)).json();
      acc.quota = {
        used: Number(j.storageQuota.usage),
        total: j.storageQuota.limit ? Number(j.storageQuota.limit) : null
      };
      acc.error = "";
      files.push(...await listNames(acc));
    } catch (e) {
      acc.quota = null;
      acc.error = e.message;
    }
    renderAccounts();
  }
  persistSafe();
  renderAccounts();
  if ($("mode").value !== "content") runSearch();
}

// ---------- Cuentas ----------

function renderAccounts() {
  const el = $("accounts");
  if (!accounts.length) {
    el.innerHTML = '<p class="muted">Sin cuentas conectadas.</p>';
    $("totals").textContent = "";
    return;
  }
  el.innerHTML = accounts.map(a => {
    const q = a.quota;
    const pct = q && q.total ? Math.min(100, q.used / q.total * 100) : 0;
    const cls = pct > 90 ? "danger" : pct > 70 ? "warn" : "";
    const info = a.error
      ? `<p class="err">${esc(a.error)}</p>`
      : q ? `<p class="muted">${fmt(q.used)} de ${q.total ? fmt(q.total) : "?"}</p>`
          : `<p class="muted">Cargando...</p>`;
    return `<div class="acc" style="--c:${colorOf(a.email)}">
      <div class="acc-top"><span class="dot"></span>${esc(a.email)}</div>
      ${info}
      <div class="bar ${cls}"><div style="width:${pct}%"></div></div>
      <button class="ghost small" data-rm="${esc(a.email)}">Quitar</button>
    </div>`;
  }).join("");

  const used = accounts.reduce((s, a) => s + ((a.quota && a.quota.used) || 0), 0);
  const total = accounts.reduce((s, a) => s + ((a.quota && a.quota.total) || 0), 0);
  $("totals").textContent = total ? `${fmt(used)} de ${fmt(total)} usados` : "";
}

// ---------- Búsqueda ----------

async function runSearch() {
  const term = $("q").value.trim();
  const mode = $("mode").value;

  if (!accounts.length) {
    shown = [];
    renderResults(false);
    setSummary("Agrega una cuenta de Google para empezar.");
    return;
  }

  if (mode === "content") {
    if (!term) {
      shown = [];
      renderResults(false);
      setSummary("Escribe una palabra y pulsa Buscar.");
      return;
    }
    setSummary("Buscando en el contenido de tus archivos...");
    shown = [];
    const errs = [];
    for (const acc of accounts) {
      try {
        const q = new URLSearchParams({
          pageSize: "100",
          fields: "files(id,name,size)",
          q: `trashed=false and not mimeType contains 'application/vnd.google-apps' and fullText contains '${escQ(term)}'`
        });
        const j = await (await api(acc, `${DRIVE}/files?` + q)).json();
        shown.push(...(j.files || []).map(f => ({ id: f.id, name: f.name, size: Number(f.size), acc: acc.email })));
      } catch (e) {
        errs.push(e.message);
      }
    }
    shown.sort(byName);
    renderResults(false);
    let msg = `${shown.length} coincidencias en el contenido.`;
    if (errs.length) msg += " Errores: " + errs.join(" | ");
    setSummary(msg);
    return;
  }

  const t = term.toLowerCase();
  if (!t) {
    shown = files.slice().sort(byName);
    renderResults(false);
    setSummary(`${files.length} archivos en total.`);
    return;
  }

  if (mode === "exact") {
    shown = files.filter(f => f.name.toLowerCase() === t).sort(byName);
    renderResults(true);
    const emails = [...new Set(shown.map(f => f.acc))];
    setSummary(shown.length
      ? `Encontrado en ${emails.length} cuenta(s): ${emails.join(", ")}`
      : "No aparece en ninguna cuenta conectada.");
  } else {
    shown = files.filter(f => f.name.toLowerCase().includes(t)).sort(byName);
    renderResults(false);
    setSummary(`${shown.length} coincidencias por nombre.`);
  }
}

function renderResults(highlight) {
  const list = shown.slice(0, 300);
  if (!list.length) {
    $("results").innerHTML = '<p class="empty">Sin resultados</p>';
    return;
  }
  $("results").innerHTML = list.map((f, i) => `
    <div class="item${highlight ? " hit" : ""}" style="--c:${colorOf(f.acc)}">
      <div class="side"></div>
      <div class="info">
        <div class="name">${esc(f.name)}</div>
        <div class="meta"><span class="badge">${esc(f.acc)}</span><span>${fmt(f.size)}</span></div>
      </div>
      <button class="ghost small" data-dl="${i}">Descargar</button>
    </div>`).join("") +
    (shown.length > 300 ? `<p class="muted">Mostrando 300 de ${shown.length}. Afina la búsqueda.</p>` : "");
}

// ---------- Descargar y subir ----------

async function download(i) {
  const f = shown[i];
  const acc = accounts.find(a => a.email === f.acc);
  try {
    const r = await api(acc, `${DRIVE}/files/${f.id}?alt=media`);
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    alert(e.message);
  }
}

async function uploadFile() {
  const file = $("file").files[0];
  const st = $("uploadStatus");
  if (!file) return alert("Elige un archivo");
  const best = accounts
    .filter(a => a.quota && a.quota.total)
    .map(a => ({ a, free: a.quota.total - a.quota.used }))
    .filter(x => x.free >= file.size)
    .sort((x, y) => y.free - x.free)[0];
  if (!best) return alert("Ninguna cuenta tiene espacio suficiente para este archivo");
  const acc = best.a;
  st.textContent = "Subiendo a " + acc.email + "...";
  try {
    const init = await api(acc, "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name })
    });
    const up = await fetch(init.headers.get("Location"), { method: "PUT", body: file });
    if (!up.ok) throw new Error("Error al subir: " + up.status);
    st.textContent = "Subido a " + acc.email;
    $("file").value = "";
    await refreshAll();
  } catch (e) {
    st.textContent = "";
    alert(e.message);
  }
}

// ---------- Arranque ----------

document.addEventListener("click", e => {
  const dl = e.target.closest("[data-dl]");
  if (dl) return download(Number(dl.dataset.dl));
  const rm = e.target.closest("[data-rm]");
  if (rm) removeAccount(rm.dataset.rm);
});

window.addEventListener("load", () => {
  $("addBtn").onclick = connect;
  $("upBtn").onclick = uploadFile;
  $("go").onclick = runSearch;
  $("mode").onchange = runSearch;
  $("q").oninput = () => { if ($("mode").value !== "content") runSearch(); };
  $("q").onkeydown = e => { if (e.key === "Enter") runSearch(); };

  $("lockBtn").onclick = submitLock;
  $("lockPass").onkeydown = e => { if (e.key === "Enter") submitLock(); };
  $("lockPass2").onkeydown = e => { if (e.key === "Enter") submitLock(); };

  const lockBtn = document.createElement("button");
  lockBtn.className = "ghost";
  lockBtn.textContent = "Bloquear";
  lockBtn.style.marginLeft = "8px";
  lockBtn.onclick = lock;
  $("addBtn").insertAdjacentElement("afterend", lockBtn);

  initGis();
  showLock();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
});
