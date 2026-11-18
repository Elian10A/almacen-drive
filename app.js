// Pega aquí tu Client ID de Google Cloud
const CLIENT_ID = "685413975165-tgeug7mgpu3p7ku8it4eh8l31cj5kfni.apps.googleusercontent.com";
const SCOPE = "https://www.googleapis.com/auth/drive";

let tokenClient = null;
let accessToken = "";
let tokenExp = 0;
let pending = null;
let files = [];
let quota = null;

const $ = id => document.getElementById(id);

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
    callback: r => {
      const p = pending; pending = null;
      if (r.error) {
        if (p) p.reject(new Error(r.error));
        else status("Google no devolvió acceso: " + r.error + ". Pulsa Conectar.");
        return;
      }
      accessToken = r.access_token;
      tokenExp = Date.now() + Number(r.expires_in) * 1000;
      localStorage.setItem("connected", "1");
      if (p) p.resolve(accessToken);
      else refreshAll();
    }
  });
  if (localStorage.getItem("connected")) {
    getToken().then(refreshAll).catch(() => showDisconnected());
  } else {
    showDisconnected();
  }
}

function connect() {
  if (!tokenClient) return status("Google todavía está cargando, intenta de nuevo.");
  tokenClient.requestAccessToken({ prompt: "consent" });
}

function getToken() {
  if (accessToken && Date.now() < tokenExp - 60000) return Promise.resolve(accessToken);
  return new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error("Google no está listo"));
    pending = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

function logout() {
  if (accessToken && window.google) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = ""; tokenExp = 0;
  localStorage.removeItem("connected");
  files = []; quota = null;
  showDisconnected();
  render();
}

function showDisconnected() {
  $("quota").textContent = "No conectado.";
  $("bar").style.width = "0%";
  $("btnConnect").style.display = "";
  $("btnLogout").style.display = "none";
  status("Pulsa Conectar para ver tus archivos.");
}

// ---------- Llamadas a Drive ----------

async function api(url, opts = {}) {
  let t = await getToken();
  let r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + t } });
  if (r.status === 401) {
    accessToken = "";
    t = await getToken();
    r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + t } });
  }
  if (!r.ok) throw new Error("Drive respondió " + r.status + ": " + (await r.text()).slice(0, 200));
  return r;
}

async function listFiles() {
  const out = [];
  let pt = "";
  do {
    const q = new URLSearchParams({
      pageSize: "200",
      fields: "nextPageToken,files(id,name,size)",
      q: "trashed=false and not mimeType contains 'application/vnd.google-apps'"
    });
    if (pt) q.set("pageToken", pt);
    const j = await (await api("https://www.googleapis.com/drive/v3/files?" + q)).json();
    out.push(...(j.files || []).map(f => ({ id: f.id, name: f.name, size: Number(f.size) })));
    pt = j.nextPageToken;
  } while (pt && out.length < 5000);
  return out;
}

async function refreshAll() {
  try {
    const j = await (await api("https://www.googleapis.com/drive/v3/about?fields=storageQuota")).json();
    quota = {
      used: Number(j.storageQuota.usage),
      total: j.storageQuota.limit ? Number(j.storageQuota.limit) : null
    };
    files = await listFiles();
    $("btnConnect").style.display = "none";
    $("btnLogout").style.display = "";
    renderQuota();
    render();
  } catch (e) {
    status("Error: " + e.message);
  }
}

// ---------- Vista ----------

function renderQuota() {
  if (!quota) return;
  const pct = quota.total ? Math.min(100, quota.used / quota.total * 100) : 0;
  $("bar").style.width = pct + "%";
  $("quota").textContent = `${fmt(quota.used)} de ${quota.total ? fmt(quota.total) : "?"} usados (incluye Gmail y Fotos)`;
}

function render() {
  const term = $("search").value.trim().toLowerCase();
  const list = files
    .filter(f => f.name.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 500);
  $("files").innerHTML = list.map(f =>
    `<tr><td class="name">${esc(f.name)}</td><td>${fmt(f.size)}</td>
     <td><button class="sec" onclick="download('${f.id}','${esc(f.name).replace(/'/g, "")}')">Descargar</button></td></tr>`
  ).join("");
  if (files.length) status(`${files.length} archivos en total. Mostrando ${list.length}.`);
}

// ---------- Descargar y subir ----------

async function download(id, name) {
  try {
    const r = await api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
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
  if (!quota) return alert("Conecta Google Drive primero");
  if (quota.total && quota.total - quota.used < file.size) return alert("No hay espacio suficiente en la cuenta");
  st.textContent = "Subiendo " + file.name + "...";
  try {
    const init = await api("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name })
    });
    const up = await fetch(init.headers.get("Location"), { method: "PUT", body: file });
    if (!up.ok) throw new Error("Error al subir: " + up.status);
    st.textContent = "Subido: " + file.name;
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
