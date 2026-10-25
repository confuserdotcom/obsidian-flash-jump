// Runs e2e.mjs in a separate Obsidian: its own profile and a throwaway vault with only the
// built-in Vim and this plugin, so the Obsidian you use is never touched (macOS).
//   node e2e-isolated.mjs
import { spawn, spawnSync } from "child_process";
import fs from "fs"; import os from "os"; import path from "path";
const REPO = path.dirname(new URL(import.meta.url).pathname), PORT = 9344;
const T = fs.mkdtempSync(path.join(os.tmpdir(), "flash-jump-e2e-")), V = path.join(T, "Test"), UD = path.join(T, "ud");
const PD = path.join(V, ".obsidian/plugins/flash-jump");
fs.mkdirSync(PD, { recursive: true }); fs.mkdirSync(UD);
for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(REPO, f), path.join(PD, f));
const J = (f, o) => fs.writeFileSync(path.join(V, ".obsidian", f), JSON.stringify(o));
J("community-plugins.json", ["flash-jump"]);
J("app.json", { vimMode: true, livePreview: true, readableLineLength: true, promptDelete: false });
J("appearance.json", { nativeMenus: false });
fs.writeFileSync(path.join(UD, "obsidian.json"), JSON.stringify({ vaults: { test1000000000000: { path: V, ts: Date.now(), open: true } } }));
const env = { HOME: os.homedir(), USER: os.userInfo().username, PATH: "/usr/bin:/bin", TMPDIR: os.tmpdir() };
const ob = spawn("/Applications/Obsidian.app/Contents/MacOS/Obsidian", [`--user-data-dir=${UD}`, `--remote-debugging-port=${PORT}`,
  "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"], { env, stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const done = async code => { ob.kill(); await sleep(500); fs.rmSync(T, { recursive: true, force: true }); process.exit(code); };
const evalIn = async (expression, i) => {
  const p = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === "page" && x.url.endsWith("/index.html"));
  if (!p) return undefined;
  const ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const v = await new Promise(r => { ws.onmessage = e => r(JSON.parse(e.data)); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); });
  ws.close();
  return v.result?.result?.value;
};
let ready = false;
for (let i = 0; i < 80 && !ready; i++) {
  await sleep(500);
  try {
    ready = await evalIn(`!!(window.app?.workspace?.layoutReady && app.plugins.plugins["flash-jump"])`, 1);
    // a fresh vault starts in restricted mode: turn community plugins on
    if (!ready) await evalIn(`(async()=>{if(!window.app?.workspace?.layoutReady)return;if(!app.plugins.isEnabled())await app.plugins.setEnable(true);await app.plugins.enablePlugin("flash-jump")})()`, 2);
  } catch {}
}
if (!ready) { console.log("Obsidian did not load the plugin"); await done(1); }
// a fresh vault asks whether to trust its plugins: say yes, close any other modal
await evalIn(`(async()=>{for(let i=0;i<20&&!document.querySelector(".modal-container button");i++)await new Promise(r=>setTimeout(r,250));
  const b=[...document.querySelectorAll(".modal-container button")].find(b=>/trust/i.test(b.textContent));b?.click();
  await new Promise(r=>setTimeout(r,800));document.querySelectorAll(".modal-container .modal-close-button").forEach(b=>b.click())})()`, 3);
await sleep(1500);
const r = spawnSync("node", ["e2e.mjs"], { cwd: REPO, env: { ...process.env, PORT: String(PORT) }, stdio: "inherit" });
await done(r.status);
