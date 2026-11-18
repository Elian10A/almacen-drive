// Pega aquí tu Client ID de Google Cloud
const CLIENT_ID = "685413975165-tgeug7mgpu3p7ku8it4eh8l31cj5kfni.apps.googleusercontent.com";
const SCOPE = "https://www.googleapis.com/auth/drive";
const DRIVE = "https://www.googleapis.com/drive/v3";

let tokenClient = null;
let pending = null;
let accounts = JSON.parse(localStorage.getItem("accounts") || "[]");
let files = [];

const $ = id => document.getElementById(id);

function save() {
  localStorage.setItem("accounts", JSON.stringify(
    accounts.map(a => ({ email: a.email, token: a.token, exp: a.exp }))
  ));
}

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

function status(msg) { $("status").textContent = msg; }

// ---------- Autenticación ----------

function initAuth() {
  if (!window.google) return setTimeout(initAuth, 300);
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: onToken
  });
  renderAccounts();
  if (accounts.length) refreshAll();
  else status("Pulsa Agregar cuenta de Google.");
}

// Se ejecuta cada vez que Google devuelve un token
async function onToken(r) {
  const p = pending;
  pending = null;
  if (r.error) {
    if (p) p.reject(new Error("Google: " + r.error));
    else status("Google no dio acceso: " + r.error);
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
    save();

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
    else status(e.message);
  }
}

// Abre el selector para agregar una cuenta nueva
function connect() {
  if (!tokenClient) return status("Google todavía está cargando, intenta de nuevo.");
  pending = null;
  tokenClient.requestAccessToken({ prompt: "select_account" });
}

// Devuelve un token válido de esa cuenta, renovándolo en silencio si hace falta
function tokenFor(acc) {
  if (acc.token && Date.now() < acc.exp - 60000) return Promise.resolve(acc.token);
  return new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error("Google no está listo"));
    pending = { email: acc.email, resolve: () => resolve(acc.token), reject };
    tokenClient.requestAccessToken({ prompt: "", hint: acc.email });
  });
}

function removeAccount(email) {
  const acc = accounts.find(a => a.email === email);
  if (acc && acc.token && window.google) google.accounts.oauth2.revoke(acc.token, () => {});
  accounts = accounts.filter(a => a.email !== email);
  save();
  refreshAll();
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

async function listFiles(acc) {
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
      files.push(...await listFiles(acc));
    } catch (e) {
      acc.quota = null;
      acc.error = e.message;
    }
  }
  save();
  renderAccounts();
  render();
}

// ---------- Vista ----------

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
    const info = a.error
      ? `<span class="err">${esc(a.error)}</span>`
      : q ? `<span class="muted">${fmt(q.used)} de ${q.total ? fmt(q.total) : "?"}</span>`
          : `<span class="muted">Cargando...</span>`;
    return `<div>
      <strong>${esc(a.email)}</strong> ${info}
      <button class="sec" onclick="removeAccount('${esc(a.email)}')">Quitar</button>
      <div class="bar"><div style="width:${pct}%"></div></div>
    </div>`;
  }).join("");
  const used = accounts.reduce((s, a) => s + ((a.quota && a.quota.used) || 0), 0);
  const total = accounts.reduce((s, a) => s + ((a.quota && a.quota.total) || 0), 0);
  $("totals").textContent = total ? `Total: ${fmt(used)} usados de ${fmt(total)}` : "";
}

function render() {
  const term = $("search").value.trim().toLowerCase();
  const list = files
    .map((f, i) => ({ f, i }))
    .filter(x => x.f.name.toLowerCase().includes(term))
    .sort((a, b) => a.f.name.localeCompare(b.f.name))
    .slice(0, 500);
  $("files").innerHTML = list.map(({ f, i }) =>
    `<tr><td class="name">${esc(f.name)}</td><td class="muted">${esc(f.acc)}</td><td>${fmt(f.size)}</td>
     <td><button class="sec" onclick="download(${i})">Descargar</button></td></tr>`
  ).join("");
  if (files.length) status(`${files.length} archivos en total. Mostrando ${list.length}.`);
}

// ---------- Descargar y subir ----------

async function download(i) {
  const f = files[i];
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

window.addEventListener("load", () => {
  initAuth();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
});
