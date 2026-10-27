// Lens grading site. Graders see candidates in their own shuffled order, without detector, rank or score.
// Backend: Supabase (auth, tables `graders`, `candidates`, `votes`, private bucket `cutouts`); see supabase/schema.sql.
// Demo mode (config without a URL, or ?demo in the address): sample images from ./demo, votes kept in this browser only.
"use strict";

const GRADES = [
  { g: "A", title: "Grade A", text: "Clear evidence of strong lensing, e.g. distinct multiple images in a typical lensing configuration." },
  { g: "B", title: "Grade B", text: "Likely a strong lens, but not certain, e.g. too little signal-to-noise to be confident, or an atypical configuration." },
  { g: "C", title: "Grade C", text: "Possibly a strong lens, but unlikely, e.g. poor signal-to-noise, or could be a spiral, merger, etc." },
  { g: "S", title: "Singly imaged", text: "" },
  { g: "X", title: "Not a lens", text: "" },
];
const CFG = window.GRADING_CONFIG || {};
const DEMO = !CFG.supabaseUrl || new URLSearchParams(location.search).has("demo");
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ backends (same interface)
function supabaseBackend() {
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const urls = new Map();
  const must = ({ data, error }) => { if (error) throw error; return data; };
  return {
    async currentUser() { const { data } = await sb.auth.getSession(); return data.session ? data.session.user : null; },
    async signIn(email, password) { return must(await sb.auth.signInWithPassword({ email, password })).user; },
    async signOut() { await sb.auth.signOut(); },
    async grader(uid) { return must(await sb.from("graders").select("display_name,is_admin").eq("user_id", uid).maybeSingle()); },
    async candidates() { return must(await sb.from("candidates").select("id,image_path,ra,dec,viewer_url,sed_url").order("id")); },
    async myVotes(uid) { return must(await sb.from("votes").select("candidate_id,grade,note,updated_at").eq("user_id", uid)); },
    async saveVote(uid, id, grade, note) {
      return must(await sb.from("votes").upsert({ candidate_id: id, user_id: uid, grade, note: note || null }, { onConflict: "candidate_id,user_id" }).select("updated_at").single());
    },
    async imageUrl(path) {
      const hit = urls.get(path); if (hit && hit.until > Date.now()) return hit.url;
      const d = must(await sb.storage.from("cutouts").createSignedUrl(path, 3600));
      urls.set(path, { url: d.signedUrl, until: Date.now() + 50 * 60 * 1000 }); return d.signedUrl;
    },
    // admins only (the database rules return nothing to other graders). Supabase returns at most 1,000 rows per request: read in pages.
    async adminData() {
      const all = async (table, cols, order) => {
        const out = [];
        for (let from = 0; ; from += 1000) {
          const page = must(await sb.from(table).select(cols).order(order).range(from, from + 999));
          out.push(...page); if (page.length < 1000) return out;
        }
      };
      const [graders, votes, meta] = await Promise.all([
        all("graders", "user_id,display_name,is_admin,created_at", "created_at"),
        all("votes", "candidate_id,user_id,grade,note,created_at,updated_at", "candidate_id"),
        all("candidate_meta", "id,in_v1,rank_v1,score_v1,in_v11,rank_v11,score_v11,sky_region", "id"),
      ]);
      return { graders, votes, meta };
    },
  };
}

function demoBackend() {
  const KEY = "lensgrading.demo.votes";
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
  const store = (o) => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* storage unavailable: keep in memory */ } };
  let mem = load();
  return {
    async currentUser() { return { id: "demo-user", email: "demo" }; },
    async signIn() { return { id: "demo-user" }; },
    async signOut() {},
    async grader() { return { display_name: "Demo grader", is_admin: true }; },
    async candidates() { const r = await fetch("demo/candidates.json"); return r.json(); },
    async myVotes() { return Object.entries(mem).map(([candidate_id, v]) => ({ candidate_id, ...v })); },
    async saveVote(uid, id, grade, note) { const v = { grade, note: note || null, updated_at: new Date().toISOString() }; mem[id] = v; store(mem); return v; },
    async imageUrl(path) { return "demo/" + path; },
    async adminData() {
      return { graders: [{ user_id: "demo-user", display_name: "Demo grader", is_admin: true }],
               votes: Object.entries(mem).map(([candidate_id, v]) => ({ candidate_id, user_id: "demo-user", ...v })), meta: [] };
    },
  };
}

// ------------------------------------------------------------------ deterministic per-grader order
function hash32(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffled(items, seedText) { const a = items.slice(), r = rng(hash32(seedText)); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ------------------------------------------------------------------ state
const api = DEMO ? demoBackend() : supabaseBackend();
const S = { user: null, grader: null, items: [], votes: new Map(), idx: 0, skipped: new Set(), reviewSkipped: false };
const prefKey = (k) => `lensgrading.${S.user ? S.user.id : "anon"}.${k}`;
function pref(k, fallback) { try { const v = localStorage.getItem(prefKey(k)); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } }
function setPref(k, v) { try { localStorage.setItem(prefKey(k), JSON.stringify(v)); } catch { /* not kept: fine */ } }

function show(view) { for (const v of ["loginView", "messageView", "gradeView", "adminView"]) $(v).hidden = v !== view; }
function message(text) { $("message").textContent = text; show("messageView"); }
function saveState(text, cls) { const el = $("saveState"); el.textContent = text; el.className = "saveState" + (cls ? " " + cls : ""); }

// ------------------------------------------------------------------ start
async function start() {
  if (!DEMO && !window.supabase) { message("Could not load the Supabase library. Check the network and reload."); return; }
  S.user = await api.currentUser();
  if (!S.user) { show("loginView"); return; }
  await enter();
}

async function enter() {
  try {
    S.grader = await api.grader(S.user.id);
    if (!S.grader) { message("You are signed in, but this account is not registered as a grader. Ask the project admin to add you."); $("who").hidden = false; $("whoName").textContent = S.user.email || ""; return; }
    $("who").hidden = false; $("whoName").textContent = S.grader.display_name + (DEMO ? " (demo: votes stay in this browser)" : "");
    $("adminBtn").hidden = !S.grader.is_admin;
    const [cands, votes] = await Promise.all([api.candidates(), api.myVotes(S.user.id)]);
    if (!cands.length) { message("No candidates are loaded yet."); return; }
    S.items = shuffled(cands, S.user.id);
    S.votes = new Map(votes.map((v) => [v.candidate_id, v]));
    S.skipped = new Set(pref("skipped", []));
    $("autoAdvance").checked = pref("autoAdvance", true);
    setFullWidth(pref("fullWidth", false));
    buildGradeButtons();
    show("gradeView");
    const firstOpen = S.items.findIndex((c) => !S.votes.has(c.id) && !S.skipped.has(c.id));
    go(firstOpen >= 0 ? firstOpen : 0);
  } catch (e) { message("Could not load the grading data: " + (e.message || e)); }
}

// ------------------------------------------------------------------ rendering
function buildGradeButtons() {
  const box = $("grades"); box.textContent = "";
  for (const { g, title, text } of GRADES) {
    const b = document.createElement("button"); b.type = "button"; b.className = "grade"; b.dataset.grade = g;
    b.setAttribute("role", "radio"); b.setAttribute("aria-checked", "false");
    const k = document.createElement("span"); k.className = "key"; k.textContent = g;
    const t = document.createElement("span"); t.className = "txt";
    const tb = document.createElement("b"); tb.textContent = `${g}: ${title}`; t.append(tb);
    if (text) { const ts = document.createElement("span"); ts.textContent = text; t.append(ts); }
    b.append(k, t); b.addEventListener("click", () => vote(g)); box.append(b);
  }
}

async function go(i) {
  if (!S.items.length) return;
  S.idx = (i + S.items.length) % S.items.length;
  const c = S.items[S.idx], v = S.votes.get(c.id);
  $("candId").textContent = `${S.idx + 1} / ${S.items.length} · COSMOS2025 ${c.id}`;
  $("position").textContent = c.ra != null ? `RA ${Number(c.ra).toFixed(5)}  Dec ${Number(c.dec).toFixed(5)}` : "";
  for (const [id, url] of [["viewerLink", c.viewer_url], ["sedLink", c.sed_url]]) { const a = $(id); a.hidden = !url; if (url) a.href = url; }
  for (const b of document.querySelectorAll(".grade")) b.setAttribute("aria-checked", String(!!v && b.dataset.grade === v.grade));
  $("note").value = v && v.note ? v.note : "";
  saveState(v ? `Saved: grade ${v.grade}` : (S.skipped.has(c.id) ? "Skipped earlier" : "Not graded yet"), v ? "ok" : "");
  updateStats();
  const img = $("cutout"); $("imgLoading").hidden = false; img.removeAttribute("src");
  try {
    const url = await api.imageUrl(c.image_path);
    if (S.items[S.idx] !== c) return;                       // moved on meanwhile
    img.onload = () => { $("imgLoading").hidden = true; }; img.src = url;
    for (const k of [1, 2]) { const n = S.items[(S.idx + k) % S.items.length]; api.imageUrl(n.image_path).then((u) => { new Image().src = u; }).catch(() => {}); }
  } catch (e) { $("imgLoading").textContent = "Image could not be loaded: " + (e.message || e); }
}

function updateStats() {
  const total = S.items.length, done = S.items.filter((c) => S.votes.has(c.id)).length;
  const skipped = S.items.filter((c) => S.skipped.has(c.id) && !S.votes.has(c.id)).length;
  $("sTotal").textContent = total; $("sDone").textContent = done; $("sLeft").textContent = total - done;
  $("sPct").textContent = (total ? Math.round(100 * done / total) : 0) + " %"; $("sSkip").textContent = skipped; $("nSkipped").textContent = skipped;
}

// ------------------------------------------------------------------ actions
let saving = false;
async function vote(grade, noteOnly = false) {
  const c = S.items[S.idx]; if (!c || saving) return;
  const prev = S.votes.get(c.id); if (noteOnly && !prev) return;
  const g = noteOnly ? prev.grade : grade, note = $("note").value.trim();
  saving = true; saveState("Saving…");
  try {
    const r = await api.saveVote(S.user.id, c.id, g, note);
    S.votes.set(c.id, { candidate_id: c.id, grade: g, note, updated_at: r && r.updated_at });
    S.skipped.delete(c.id); setPref("skipped", [...S.skipped]);
    for (const b of document.querySelectorAll(".grade")) b.setAttribute("aria-checked", String(b.dataset.grade === g));
    saveState(`Saved: grade ${g}`, "ok"); updateStats();
    if (!noteOnly && $("autoAdvance").checked) nextOpen();
  } catch (e) { saveState("Not saved: " + (e.message || e), "err"); }
  finally { saving = false; }
}

function nextOpen() {
  const n = S.items.length, wantSkipped = S.reviewSkipped;
  for (let k = 1; k <= n; k++) {
    const c = S.items[(S.idx + k) % n];
    if (S.votes.has(c.id)) continue;
    if (wantSkipped ? S.skipped.has(c.id) : !S.skipped.has(c.id)) { go((S.idx + k) % n); return; }
  }
  if (wantSkipped) { S.reviewSkipped = false; saveState("No skipped candidates left.", "ok"); return; }
  const anySkipped = S.items.some((c) => !S.votes.has(c.id));
  saveState(anySkipped ? "Everything is graded except the skipped ones (Review skipped)." : "All candidates are graded. Thank you!", "ok");
}

function skip() { const c = S.items[S.idx]; if (!c) return; if (!S.votes.has(c.id)) { S.skipped.add(c.id); setPref("skipped", [...S.skipped]); } nextOpen(); }
function setFullWidth(on) { $("grid").classList.toggle("full", on); $("fullWidthBtn").setAttribute("aria-pressed", String(on)); setPref("fullWidth", on); }

function csv(rows, cols) {
  const q = (x) => { const s = x == null ? "" : String(x); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => q(r[c])).join(","))].join("\n") + "\n";
}
function download(name, text) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

// ------------------------------------------------------------------ admin dashboard
// Everything is computed here from three tables an admin may read: graders, votes, candidate_meta (detector lists, ranks, scores).
const SCORE = { A: 3, B: 2, C: 1, S: 0, X: 0 };
const GL = ["A", "B", "C", "S", "X"];
const BINS = [[1, 25], [26, 50], [51, 100], [101, 150], [151, 200]];
const ADM = { rows: [], graders: [], votes: [], filter: "graded", sort: { key: "pos", dir: 1 } };

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v); }
  e.append(...kids.filter((x) => x != null)); return e;
}
const avg = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const fmt = (x, d = 2) => x == null ? "—" : Number(x).toFixed(d);
const pct = (k, n) => n ? `${k} (${Math.round(100 * k / n)} %)` : "—";
const lensLike = (r) => r.total > 0 && r.top.every((g) => g === "A" || g === "B");
function rankdata(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = new Array(a.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; }
  return r;
}
function spearman(x, y) {
  if (x.length < 3) return null;
  const rx = rankdata(x), ry = rankdata(y), mx = avg(rx), my = avg(ry); let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < rx.length; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

function buildRows(cands, { graders, votes, meta }) {
  const name = new Map(graders.map((g) => [g.user_id, g.display_name])), M = new Map(meta.map((m) => [m.id, m]));
  const by = new Map(cands.map((c) => [c.id, []]));
  for (const v of votes) if (by.has(v.candidate_id)) by.get(v.candidate_id).push(v);
  const rows = cands.map((c) => {
    const vs = by.get(c.id), m = M.get(c.id) || {}, n = { A: 0, B: 0, C: 0, S: 0, X: 0 };
    for (const v of vs) n[v.grade]++;
    const total = vs.length, max = Math.max(...Object.values(n)), top = total ? GL.filter((g) => n[g] === max) : [];
    const rank_v1 = m.in_v1 ? m.rank_v1 : null, rank_v11 = m.in_v11 ? m.rank_v11 : null, rs = [rank_v1, rank_v11].filter((r) => r != null);
    return { id: c.id, c, n, total, top, majority: top.join("/"), agree: total ? max / total : null,
      mean: total ? avg(vs.map((v) => SCORE[v.grade])) : null, rank_v1, rank_v11, score_v1: m.score_v1, score_v11: m.score_v11,
      in_v1: !!m.in_v1, in_v11: !!m.in_v11, best: rs.length ? Math.min(...rs) : null,
      notes: vs.filter((v) => v.note).map((v) => `${name.get(v.user_id) || "unknown grader"}: ${v.note}`) };
  });
  // overall position: graded candidates by mean score, then number of votes, then best detector rank
  const graded = rows.filter((r) => r.total).sort((a, b) => b.mean - a.mean || b.total - a.total || (a.best ?? 1e9) - (b.best ?? 1e9));
  graded.forEach((r, i) => { r.pos = i + 1; }); rows.forEach((r) => { if (!r.total) r.pos = null; });
  return rows;
}

const FILTERS = [
  ["graded", "Graded", (r) => r.total > 0],
  ["lens", "Mostly A or B (lens)", lensLike],
  ["mean2", "Mean score ≥ 2", (r) => r.total > 0 && r.mean >= 2],
  ["single", "Mostly S (singly imaged)", (r) => r.total > 0 && r.top.length === 1 && r.top[0] === "S"],
  ["nonlens", "Mostly X (not a lens)", (r) => r.total > 0 && r.top.length === 1 && r.top[0] === "X"],
  ["split", "Graders disagree", (r) => r.total >= 2 && r.agree < 0.6],
  ["open", "Not graded yet", (r) => r.total === 0],
  ["all", "All candidates", () => true],
];
const COLS = [
  ["pos", "#", "num"], ["id", "COSMOS2025 id"], ["total", "votes", "num"], ...GL.map((g) => [g, g, "num"]),
  ["mean", "mean score", "num"], ["majority", "most frequent"], ["agree", "agreement", "num"],
  ["rank_v1", "v1 rank", "num"], ["rank_v11", "v1.1 rank", "num"], ["best", "best detector rank", "num"], ["notes", "notes"],
];
function sortValue(r, key) {
  if (GL.includes(key)) return r.n[key];
  if (key === "notes") return r.notes.length;
  if (key === "id") return Number(r.id);
  return r[key];
}

async function showAdmin() {
  show("adminView"); $("adminError").textContent = ""; $("adminStamp").textContent = "Loading…";
  try {
    const data = await api.adminData();
    ADM.graders = data.graders; ADM.votes = data.votes; ADM.rows = buildRows(S.items, data);
    renderTiles(); renderGraders(); renderRanks(); renderChips(); renderTable();
    $("adminStamp").textContent = `Updated ${new Date().toLocaleString()} · ${data.meta.length} candidates with detector information`;
  } catch (e) { $("adminError").textContent = "Could not load the admin data: " + (e.message || e); $("adminStamp").textContent = ""; }
}

function renderTiles() {
  const R = ADM.rows, nC = R.length, voters = new Set(ADM.votes.map((v) => v.user_id)), graded = R.filter((r) => r.total);
  const nG = ADM.graders.length, admins = ADM.graders.filter((g) => g.is_admin).length;
  const tiles = [
    [nG, "graders with an account", `${admins} admin${admins === 1 ? "" : "s"}; ${voters.size} have voted`],
    [ADM.votes.length, "votes cast", nG ? `${Math.round(100 * ADM.votes.length / (nG * nC))} % of ${nG} × ${nC} possible` : ""],
    [`${graded.length} / ${nC}`, "candidates graded at least once", `${R.filter((r) => r.total >= 2).length} by two or more graders`],
    [R.filter((r) => voters.size && r.total >= voters.size).length, "graded by every grader who has voted", ""],
    [R.filter(lensLike).length, "mostly A or B (lens)", `${R.filter((r) => r.total && r.mean >= 2).length} with mean score ≥ 2`],
    [R.filter((r) => r.total && r.top.length === 1 && r.top[0] === "S").length, "mostly S (singly imaged)", ""],
    [R.filter((r) => r.total && r.top.length === 1 && r.top[0] === "X").length, "mostly X (not a lens)", ""],
    [R.filter((r) => r.total >= 2 && r.agree < 0.6).length, "graders disagree", "two or more votes, under 60 % on the most frequent grade"],
  ];
  $("adminTiles").replaceChildren(...tiles.map(([b, s, small]) => el("div", { class: "tile" }, el("b", { text: String(b) }), el("span", { text: s }), small ? el("small", { text: small }) : null)));
}

function renderGraders() {
  const nC = ADM.rows.length, body = $("progressTable").querySelector("tbody");
  const rows = ADM.graders.map((g) => {
    const vs = ADM.votes.filter((v) => v.user_id === g.user_id), last = vs.reduce((m, v) => (v.updated_at > m ? v.updated_at : m), "");
    return el("tr", {}, el("td", { text: g.display_name + (g.is_admin ? " (admin)" : "") }), el("td", { class: "num", text: String(vs.length) }),
      el("td", { class: "num", text: nC ? `${Math.round(100 * vs.length / nC)} %` : "—" }),
      ...GL.map((x) => el("td", { class: "num", text: String(vs.filter((v) => v.grade === x).length) })),
      el("td", { text: last ? new Date(last).toLocaleString() : "—" }));
  });
  body.replaceChildren(...(rows.length ? rows : [el("tr", {}, el("td", { colspan: "9", text: "No graders yet." }))]));
}

function renderRanks() {
  const body = $("rankTable").querySelector("tbody"), trs = [], rho = [];
  for (const [label, key] of [["MIRAGE-v1", "rank_v1"], ["MIRAGE-v1.1", "rank_v11"]]) {
    for (const [lo, hi] of BINS) {
      const sub = ADM.rows.filter((r) => r[key] != null && r[key] >= lo && r[key] <= hi), g = sub.filter((r) => r.total);
      trs.push(el("tr", {}, el("td", { text: label }), el("td", { text: `${lo}–${hi}` }), el("td", { class: "num", text: String(sub.length) }),
        el("td", { class: "num", text: String(g.length) }), el("td", { class: "num", text: fmt(avg(g.map((r) => r.mean))) }),
        el("td", { class: "num", text: pct(g.filter(lensLike).length, g.length) }),
        el("td", { class: "num", text: pct(g.filter((r) => r.top.length === 1 && r.top[0] === "X").length, g.length) })));
    }
    const g = ADM.rows.filter((r) => r[key] != null && r.total), s = spearman(g.map((r) => -r[key]), g.map((r) => r.mean));
    rho.push(`${label}: ρ = ${s == null ? "— (needs 3 graded candidates)" : s.toFixed(2)} over ${g.length} graded candidates`);
  }
  body.replaceChildren(...trs); $("rankRho").textContent = "Spearman ρ, detector order vs mean score · " + rho.join(" · ");
}

function renderChips() {
  $("filterChips").replaceChildren(...FILTERS.map(([k, label, f]) => {
    const b = el("button", { type: "button", role: "tab", "aria-selected": String(ADM.filter === k), text: `${label} (${ADM.rows.filter(f).length})` });
    b.addEventListener("click", () => { ADM.filter = k; renderChips(); renderTable(); }); return b;
  }));
}

function renderTable() {
  const t = $("consensusTable"), f = FILTERS.find((x) => x[0] === ADM.filter)[2], { key, dir } = ADM.sort;
  t.querySelector("thead").replaceChildren(el("tr", {}, ...COLS.map(([k, label, cls]) => {
    const th = el("th", { class: "sortable" + (cls ? " " + cls : ""), text: label, scope: "col" });
    if (k === key) th.setAttribute("aria-sort", dir > 0 ? "ascending" : "descending");
    th.addEventListener("click", () => { ADM.sort = { key: k, dir: k === key ? -dir : (["pos", "id", "rank_v1", "rank_v11", "best", "majority"].includes(k) ? 1 : -1) }; renderTable(); });
    return th;
  })));
  const rows = ADM.rows.filter(f).sort((a, b) => {
    const x = sortValue(a, key), y = sortValue(b, key);
    if (x == null && y == null) return (a.pos ?? 1e9) - (b.pos ?? 1e9); if (x == null) return 1; if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir || (a.pos ?? 1e9) - (b.pos ?? 1e9);
  });
  t.querySelector("tbody").replaceChildren(...(rows.length ? rows.map((r) => {
    const idBtn = el("button", { type: "button", class: "link mono", text: r.id }); idBtn.addEventListener("click", () => openImage(r));
    const notes = r.notes.length ? el("details", { class: "notes" }, el("summary", { text: `${r.notes.length} note${r.notes.length > 1 ? "s" : ""}` }), el("ul", {}, ...r.notes.map((n) => el("li", { text: n })))) : "—";
    const num = (v, d) => el("td", { class: "num" + (v === 0 ? " zero" : ""), text: v == null ? "—" : (d == null ? String(v) : fmt(v, d)) });
    return el("tr", {}, num(r.pos), el("td", {}, idBtn), num(r.total), ...GL.map((g) => num(r.n[g])), num(r.mean, 2),
      el("td", { text: r.majority || "—" }), el("td", { class: "num", text: r.agree == null ? "—" : `${Math.round(100 * r.agree)} %` }),
      num(r.rank_v1), num(r.rank_v11), num(r.best), el("td", {}, notes));
  }) : [el("tr", {}, el("td", { colspan: String(COLS.length), text: "No candidates in this list." }))]));
}

async function openImage(r) {
  const d = $("imgDialog"), img = $("imgDlgImg");
  $("imgDlgTitle").textContent = `COSMOS2025 ${r.id}`; img.removeAttribute("src"); $("imgDlgLoading").hidden = false; $("imgDlgLoading").textContent = "Loading image…";
  const parts = [`votes ${r.total}`, r.total ? `A ${r.n.A} · B ${r.n.B} · C ${r.n.C} · S ${r.n.S} · X ${r.n.X} · mean ${fmt(r.mean)}` : null,
    `v1 rank ${r.rank_v1 ?? "—"} (score ${fmt(r.score_v1, 3)})`, `v1.1 rank ${r.rank_v11 ?? "—"} (score ${fmt(r.score_v11, 3)})`].filter(Boolean);
  const info = $("imgDlgInfo"); info.replaceChildren(parts.join(" · "));
  if (r.c.viewer_url) info.append(" · ", el("a", { href: r.c.viewer_url, target: "_blank", rel: "noopener", text: "COSMOS-Web viewer ↗" }));
  d.showModal();
  try { const u = await api.imageUrl(r.c.image_path); img.onload = () => { $("imgDlgLoading").hidden = true; }; img.src = u; }
  catch (e) { $("imgDlgLoading").textContent = "Image could not be loaded: " + (e.message || e); }
}

function exportConsensus() {
  const cols = ["position", "id", "n_votes", "n_A", "n_B", "n_C", "n_S", "n_X", "mean_score", "most_frequent", "agreement",
    "in_v1", "rank_v1", "score_v1", "in_v11", "rank_v11", "score_v11", "best_rank", "ra", "dec", "viewer_url", "notes"];
  const rows = [...ADM.rows].sort((a, b) => (a.pos ?? 1e9) - (b.pos ?? 1e9) || Number(a.id) - Number(b.id)).map((r) => ({
    position: r.pos, id: r.id, n_votes: r.total, n_A: r.n.A, n_B: r.n.B, n_C: r.n.C, n_S: r.n.S, n_X: r.n.X,
    mean_score: r.mean == null ? "" : r.mean.toFixed(3), most_frequent: r.majority, agreement: r.agree == null ? "" : r.agree.toFixed(3),
    in_v1: r.in_v1, rank_v1: r.rank_v1, score_v1: r.score_v1, in_v11: r.in_v11, rank_v11: r.rank_v11, score_v11: r.score_v11, best_rank: r.best,
    ra: r.c.ra, dec: r.c.dec, viewer_url: r.c.viewer_url, notes: r.notes.join(" | ") }));
  download(`candidate_summary_${stamp()}.csv`, csv(rows, cols));
}
function exportAllVotes() {
  const name = new Map(ADM.graders.map((g) => [g.user_id, g.display_name]));
  const rows = ADM.votes.map((v) => ({ ...v, grader: name.get(v.user_id) || v.user_id }));
  download(`all_votes_${stamp()}.csv`, csv(rows, ["candidate_id", "grader", "grade", "note", "created_at", "updated_at"]));
}

// ------------------------------------------------------------------ wiring
$("loginForm").addEventListener("submit", async (ev) => {
  ev.preventDefault(); $("loginError").textContent = "";
  try { S.user = await api.signIn($("email").value.trim(), $("password").value); $("password").value = ""; await enter(); }
  catch (e) { $("loginError").textContent = e.message || String(e); }
});
$("logoutBtn").addEventListener("click", async () => { await api.signOut(); location.reload(); });
$("prevBtn").addEventListener("click", () => go(S.idx - 1));
$("nextBtn").addEventListener("click", () => go(S.idx + 1));
$("nextOpenBtn").addEventListener("click", () => { S.reviewSkipped = false; nextOpen(); });
$("skipBtn").addEventListener("click", skip);
$("reviewSkippedBtn").addEventListener("click", () => { S.reviewSkipped = true; nextOpen(); });
$("fullWidthBtn").addEventListener("click", () => setFullWidth(!$("grid").classList.contains("full")));
$("autoAdvance").addEventListener("change", (e) => setPref("autoAdvance", e.target.checked));
$("note").addEventListener("change", () => vote(null, true));
$("exportMineBtn").addEventListener("click", () => {
  const rows = [...S.votes.values()].map((v) => ({ candidate_id: v.candidate_id, grade: v.grade, note: v.note, updated_at: v.updated_at }));
  download(`my_votes_${stamp()}.csv`, csv(rows, ["candidate_id", "grade", "note", "updated_at"]));
});
$("adminBtn").addEventListener("click", showAdmin);
$("backBtn").addEventListener("click", () => { show("gradeView"); go(S.idx); });
$("refreshBtn").addEventListener("click", showAdmin);
$("exportAllBtn").addEventListener("click", exportAllVotes);
$("exportConsensusBtn").addEventListener("click", exportConsensus);
$("helpBtn").addEventListener("click", () => $("helpDialog").showModal());
$("cutout").addEventListener("click", () => { const s = $("cutout").src; if (s) window.open(s, "_blank", "noopener"); });

document.addEventListener("keydown", (e) => {
  if ($("gradeView").hidden || e.target.closest("textarea, input") || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toUpperCase(), byNum = { 1: "A", 2: "B", 3: "C", 4: "S", 5: "X" };
  if (GRADES.some((x) => x.g === k)) { e.preventDefault(); vote(k); }
  else if (byNum[e.key]) { e.preventDefault(); vote(byNum[e.key]); }
  else if (e.key === "ArrowRight") go(S.idx + 1);
  else if (e.key === "ArrowLeft") go(S.idx - 1);
  else if (k === "N") nextOpen();
  else if (k === "K") skip();
  else if (k === "F") setFullWidth(!$("grid").classList.contains("full"));
  else if (e.key === "?") $("helpDialog").showModal();
});

start();
