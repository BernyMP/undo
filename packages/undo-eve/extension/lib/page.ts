// The ledger page: one HTML file, no build step. It polls /undo/api/rows.

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>undo ledger</title>
<style>
  :root { --bg:#fff; --fg:#111; --muted:#666; --line:#e5e5e5; --held:#9a6700; --bad:#cf222e; --good:#1a7f37; --chip:#f4f4f4; --btn:#111; --btnfg:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d0d0d; --fg:#eee; --muted:#999; --line:#2a2a2a; --held:#d29922; --bad:#ff7b72; --good:#3fb950; --chip:#1c1c1c; --btn:#eee; --btnfg:#111; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; color: var(--muted); }
  form { display:flex; gap:8px; margin-bottom: 12px; }
  input[type=text] { flex:1; padding:9px 11px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font:inherit; }
  button { padding:8px 12px; border-radius:8px; border:1px solid var(--btn); background:var(--btn); color:var(--btnfg); font:inherit; cursor:pointer; }
  button.ghost { background:transparent; color:var(--fg); border-color:var(--line); }
  button:disabled { opacity:.4; cursor:default; }
  #plan { margin: 0 0 20px; padding: 10px 12px; border:1px solid var(--line); border-radius:8px; display:none; }
  table { width:100%; border-collapse: collapse; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  td.mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .chip { display:inline-block; padding:1px 8px; border-radius: 999px; background: var(--chip); font-size:12px; white-space:nowrap; }
  .s-held, .s-running, .s-awaiting_person { color: var(--held); }
  .s-blocked, .s-failed, .s-conflict { color: var(--bad); }
  .s-done, .s-undone, .s-cancelled { color: var(--good); }
  .muted { color: var(--muted); }
  .wrap { overflow-x:auto; }
  @media (max-width: 640px) { .hide-sm { display:none; } }
</style>
</head>
<body>
<main>
  <h1>undo ledger</h1>
  <p class="sub">Every call your agent made. Undo a row with its button, or say what to undo.</p>
  <form id="say">
    <input type="text" id="sentence" placeholder='e.g. "cancel the email to Bob"' autocomplete="off" />
    <button type="submit">Find</button>
  </form>
  <div id="plan"></div>
  <div class="wrap">
  <table>
    <thead><tr><th>Row</th><th>Action</th><th>State</th><th class="hide-sm">Reviewer</th><th class="hide-sm">Session</th><th></th></tr></thead>
    <tbody id="rows"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody>
  </table>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
let rows = [];
function left(row) {
  if (row.state !== "held" || !row.undoUntil) return "";
  const s = Math.max(0, Math.round((row.undoUntil - Date.now()) / 1000));
  return " · " + s + "s left";
}
function render() {
  if (!rows.length) { $("rows").innerHTML = '<tr><td colspan="6" class="muted">No calls yet.</td></tr>'; return; }
  $("rows").innerHTML = rows.map((r) => \`<tr>
    <td class="mono">\${esc(r.rowId)}</td>
    <td><div>\${esc(r.summary)}</div><div class="mono muted">\${esc(r.tool)}\${r.undoes ? " · undoes " + esc(r.undoes) : ""}</div>\${r.error ? '<div class="s-failed">' + esc(r.error) + '</div>' : ""}</td>
    <td><span class="chip s-\${esc(r.state)}">\${esc(r.state)}\${left(r)}</span><div class="muted">\${esc(r.strategy)}</div></td>
    <td class="hide-sm">\${r.reviewVerdict ? esc(r.reviewVerdict) + ": " : ""}<span class="muted">\${esc(r.reviewReason)}</span></td>
    <td class="hide-sm mono muted">\${esc(r.sessionId).slice(0, 14)}</td>
    <td>\${r.canUndo ? '<button data-undo="' + esc(r.rowId) + '">Undo</button>' : ""}</td>
  </tr>\`).join("");
}
async function load() {
  try { rows = await (await fetch("/undo/api/rows")).json(); render(); } catch {}
}
document.addEventListener("click", async (e) => {
  const id = e.target?.dataset?.undo;
  if (id) {
    e.target.disabled = true;
    const res = await (await fetch("/undo/api/rows/" + encodeURIComponent(id) + "/undo", { method: "POST" })).json();
    showResult([res]);
    load();
  }
  const planId = e.target?.dataset?.confirm;
  if (planId) {
    e.target.disabled = true;
    const res = await (await fetch("/undo/api/plan/" + encodeURIComponent(planId) + "/confirm", { method: "POST" })).json();
    showResult(res.results ?? [res]);
    load();
  }
});
function showResult(results) {
  const p = $("plan");
  p.style.display = "block";
  p.innerHTML = results.map((r) => "<div><b>" + esc(r.rowId ?? "") + "</b> " + esc(r.status ?? r.error) + (r.followUp ? " — " + esc(r.followUp) : "") + (r.reason ? " — " + esc(r.reason) : "") + (r.current ? " — current: <span class='mono'>" + esc(JSON.stringify(r.current)) + "</span>" : "") + "</div>").join("");
}
$("say").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sentence = $("sentence").value.trim();
  if (!sentence) return;
  const res = await (await fetch("/undo/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sentence }) })).json();
  const p = $("plan");
  p.style.display = "block";
  if (res.planId) {
    p.innerHTML = "<div>Undo this?</div>" + res.rows.map((r) => "<div class='mono'>" + esc(r.rowId) + " · " + esc(r.summary) + "</div>").join("") +
      "<div style='margin-top:8px'><button data-confirm='" + esc(res.planId) + "'>Confirm</button></div>";
  } else {
    p.innerHTML = "<div>" + esc(res.question) + "</div>" + (res.candidates || []).map((r) => "<div class='mono'>" + esc(r.rowId) + " · " + esc(r.summary) + " (" + esc(r.state) + ")</div>").join("");
  }
});
load();
setInterval(load, 1000);
setInterval(render, 250);
</script>
</body>
</html>`;
