// Real key presses in a running Obsidian. Run it through e2e-isolated.mjs (its own Obsidian, a
// throwaway vault), or against an Obsidian started with --remote-debugging-port=PORT (default 9222).
// Uses the scratch notes zz-flash.md and zz-other.md (deleted at the end).
const PORT = process.env.PORT || 9222;
const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
const ws = new WebSocket(list.find(p => p.type === "page" && p.url.endsWith("/index.html")).webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));
let id = 0; const pend = {};
ws.onmessage = e => { const m = JSON.parse(e.data); pend[m.id]?.(m); };
const call = (method, params) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => (await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NOTE = "zz-flash.md", OTHER = "zz-other.md";
async function key(k) {
  const special = { "<Esc>": ["Escape", 27], "<Down>": ["ArrowDown", 40], "<Shift>": ["Shift", 16] }[k];
  const ctrl = /^<C-(.)>$/.exec(k);
  if (ctrl) { const K = ctrl[1].toUpperCase(); for (const type of ["keyDown", "keyUp"]) await call("Input.dispatchKeyEvent", { type, key: ctrl[1], code: "Key" + K, windowsVirtualKeyCode: K.charCodeAt(0), modifiers: 2 }); }
  else if (special) for (const type of ["keyDown", "keyUp"]) await call("Input.dispatchKeyEvent", { type, key: special[0], code: special[0], windowsVirtualKeyCode: special[1] });
  else { await call("Input.dispatchKeyEvent", { type: "keyDown", key: k, text: k, unmodifiedText: k }); await call("Input.dispatchKeyEvent", { type: "keyUp", key: k }); }
  await sleep(120);
}
const keys = async s => { for (const k of s.match(/<[^>]+>|./gu)) await key(k); };
const st = () => ev(`(()=>{const v=app.workspace.activeLeaf.view,cm=v.editor.cm,h=cm.state.selection.main;return {source:!!v.getState().source,active:cm.dom.classList.contains("flash-jump-active"),head:h.head,anchor:h.anchor,doc:cm.state.doc.toString()}})()`);
const labels = () => ev(`[...app.workspace.activeLeaf.view.editor.cm.dom.querySelectorAll("[data-flash-label]")].map(e=>[e.dataset.flashLabel,+e.dataset.pos])`);
// s, then the pattern one character at a time; press the label of the match near `target` as soon
// as there is one (it also jumps on its own when one match is left).
async function jump(pattern, target) {
  await keys("s"); await sleep(500);
  for (const ch of pattern) {
    await keys(ch); await sleep(250);
    if (!(await st()).active) return "auto";
    const lab = (await labels()).find(([, p]) => p >= target && p <= target + pattern.length + 1);
    if (lab) { await keys(lab[0]); await sleep(700); return lab[0]; }
  }
  return null;
}
let fails = 0; const report = (ok, name, d) => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "\n      " + JSON.stringify(d)}`); };
const DOC = "Soit la somme suivante, avec un texte assez long pour la ligne.\n\n$$\n\\sum_{k=0}^{n} \\frac{a_{k}}{b} = S\n$$\n\nFin du texte ici : $x^{2}+y$ et la suite.";
await ev(`(async()=>{const f=app.vault.getAbstractFileByPath('${NOTE}')||await app.vault.create('${NOTE}','');const leaf=app.workspace.getLeaf(false);await leaf.openFile(f);await leaf.setViewState({type:"markdown",state:{file:'${NOTE}',mode:"source",source:false}});await new Promise(r=>setTimeout(r,500))})()`);
async function fresh(pos = 0) {
  if ((await ev(`app.workspace.getActiveFile()?.path`)) !== NOTE) throw new Error("not on the scratch note");
  await ev(`(()=>{const e=app.workspace.activeEditor.editor;e.setValue(${JSON.stringify(DOC)});e.focus()})()`);
  await keys("<Esc>"); await ev(`(()=>{const cm=app.workspace.activeLeaf.view.editor.cm;cm.dispatch({selection:{anchor:${pos}}})})()`); await sleep(400);
}
try {
  await fresh(0);
  // 1. jump into the display formula from the first line
  await fresh(0);
  const math0 = await ev(`app.workspace.activeLeaf.view.editor.cm.contentDOM.querySelectorAll(".math").length`);
  await keys("s"); await sleep(500);
  let s1 = await st();
  report(s1.source && s1.active && math0 > 0, "s with maths on screen: formulas show as written (Source mode) during the jump", { math0, ...s1 });
  await keys("<Esc>"); await sleep(600);
  const target = DOC.indexOf("^{n}");
  const how = await jump("^{n", target);
    let s2 = await st();
  report(!s2.active && !s2.source && s2.head === target, "jump into the formula (^{n}), back to Live Preview", { how, target, ...s2 });
  // 2. Esc cancels and restores Live Preview
  await fresh(0); await keys("s"); await sleep(400); await keys("<Esc>"); await sleep(600);
  let s3 = await st();
  report(!s3.active && !s3.source && s3.head === 0, "Esc: cancelled, back to Live Preview, cursor unchanged", s3);
  // 3. visual mode extends the selection
  await fresh(0); await keys("vl"); await sleep(200);
  const fin = DOC.indexOf("Fin");
  const how4 = await jump("Fin", fin);
  let s4 = await st();
  report(s4.anchor === 0 && s4.head >= fin && s4.head <= fin + 2, "visual: s extends the selection to the target", { how4, ...s4 });
  await keys("<Esc>");
  // ── every way out restores rendered maths (D1, D2, D3) ──
  const P = `app.plugins.plugins["flash-jump"]`;
  const raw = async () => (await st()).source;
  // click
  await fresh(0); await keys("s"); await sleep(500);
  const box = await ev(`(()=>{const r=app.workspace.activeLeaf.view.editor.cm.contentDOM.getBoundingClientRect();return {x:r.left+40,y:r.top+15}})()`);
  for (const type of ["mousePressed", "mouseReleased"]) await call("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(700); let x1 = await st();
  report(!x1.active && !x1.source, "a click ends the jump, maths rendered again", x1);
  // arrow key: ends the jump AND still moves the cursor
  await fresh(0); await keys("s"); await sleep(500); await keys("<Down>"); await sleep(700);
  let x2 = await st(), line2 = await ev(`app.workspace.activeEditor.editor.getCursor().line`);
  report(!x2.active && !x2.source && line2 === 1, "an arrow ends the jump and still moves the cursor", { line2, ...x2 });
  // Shift alone does not cancel (capitals)
  await fresh(0); await keys("s"); await sleep(500); await keys("<Shift>"); await sleep(150);
  let x3 = await st();
  report(x3.active, "Shift alone keeps the jump open", x3);
  await keys("<Esc>"); await sleep(600);
  // Esc straight away, while the switch to raw is still running
  await fresh(0); await keys("s"); await keys("<Esc>"); await sleep(900);
  let x4 = await st();
  report(!x4.active && !x4.source, "Esc during the switch: ends rendered (switches queued)", x4);
  // idle timeout
  await ev(`${P}.idleMs = 500`);
  await fresh(0); await keys("s"); await sleep(1500);
  let x5 = await st();
  report(!x5.active && !x5.source, "no key for the idle time: jump ends, rendered", x5);
  await ev(`${P}.idleMs = 20000`);
  // note change while a jump is open
  await fresh(0); await keys("s"); await sleep(500);
  await ev(`(async()=>{const l=app.workspace.activeLeaf;await l.openFile((app.vault.getAbstractFileByPath("${OTHER}")||await app.vault.create("${OTHER}","another note")));})()`); await sleep(900);
  let x6 = await st(), jumpLeft = await ev(`!!app.plugins.plugins["flash-jump"].jump`);
  report(!jumpLeft && !x6.source, "changing note ends the jump; the tab is rendered", { jumpLeft, ...x6 });
  await ev(`(async()=>{const l=app.workspace.activeLeaf;await l.openFile(app.vault.getAbstractFileByPath("${NOTE}"));app.workspace.activeEditor.editor.focus()})()`); await sleep(600);
  // leftover raw tab (crash mid-jump) is put back when the plugin loads
  await ev(`(async()=>{const v=app.workspace.activeLeaf.view;window.__flashLeaf=v.leaf;await v.setState({...v.getState(),source:true},{history:false});app.saveLocalStorage("flash-jump-raw",[v.leaf.id]);await app.plugins.disablePlugin("flash-jump");await app.plugins.enablePlugin("flash-jump");})()`);
  await sleep(1200);
  await ev(`(()=>{app.workspace.setActiveLeaf(window.__flashLeaf,{focus:true});app.workspace.activeEditor.editor.focus()})()`); await sleep(300);
  let x7 = await st(), left = await ev(`app.loadLocalStorage("flash-jump-raw")`);
  report(!x7.source && !left, "a tab left raw by a crash is rendered again when the plugin loads", { left, ...x7 });
  // 4. no maths on screen: stays in Live Preview
  await ev(`(()=>{const e=app.workspace.activeEditor.editor;e.setValue("un texte sans maths\\nune deuxième ligne");e.focus()})()`); await keys("<Esc>gg"); await sleep(300);
  await keys("s"); await sleep(400); let s5 = await st();
  report(s5.active && !s5.source, "s without maths: plain jump", s5);
  await keys("<Esc>"); await sleep(300);
  // 4b. the jump lands like zz: target line in the middle of the screen (with and without maths)
  for (const maths of [false, true]) {
    const lines = Array.from({ length: 200 }, (_, i) => i === 1 && maths ? "avec $x^{2}$ ici" : i === 22 ? "le mot qwzk est ici" : `ligne ${i}`);
    await ev(`(()=>{const e=app.workspace.activeEditor.editor;e.setValue(${JSON.stringify(lines.join("\n"))});e.focus()})()`); await keys("<Esc>gg"); await sleep(400);
    const target = lines.slice(0, 22).join("\n").length + 1 + "le mot ".length;
    await jump("qwzk", target); await sleep(400);
    const c = await ev(`(()=>{const cm=app.workspace.activeLeaf.view.editor.cm,r=cm.scrollDOM.getBoundingClientRect(),y=cm.coordsAtPos(cm.state.selection.main.head);return {line:cm.state.doc.lineAt(cm.state.selection.main.head).number,off:Math.round((y.top+y.bottom)/2-(r.top+r.bottom)/2),lh:Math.round(cm.defaultLineHeight)}})()`);
    report(c.line === 23 && Math.abs(c.off) <= 2 * c.lh, `jump centres the target line (zz)${maths ? ", maths on screen" : ""}`, c);
  }
  // 5. Ctrl-x decrements again
  await ev(`(()=>{const e=app.workspace.activeEditor.editor;e.setValue("n = 5");e.focus()})()`); await keys("<Esc>0"); await sleep(200);
  await keys("<C-x>"); await sleep(300);
  let s6 = await st();
  report(s6.doc === "n = 4" && !s6.active, "Ctrl-x decrements (5 → 4)", s6);
  // 6. the key setting: another key jumps, s is Vim's substitute again; unload gives s back too
  await ev(`(async()=>{const p=${P};p.settings.key="gs";await p.saveSettings()})()`);
  await ev(`(()=>{const e=app.workspace.activeEditor.editor;e.setValue("abc");e.focus()})()`); await keys("<Esc>0"); await sleep(200);
  await keys("s"); await sleep(300); let k1 = await st(), ins1 = await ev(`!!app.workspace.activeEditor.editor.cm.cm.state.vim.insertMode`);
  report(!k1.active && ins1 && k1.doc === "bc", "key set to gs: s is Vim's substitute again", { ins1, ...k1 });
  await keys("<Esc>"); await sleep(200);
  await keys("gs"); await sleep(300); let k2 = await st();
  report(k2.active, "key set to gs: gs starts a jump", k2);
  await keys("<Esc>"); await sleep(300);
  await ev(`(async()=>{const p=${P};p.settings.key="s";await p.saveSettings()})()`);
  await keys("s"); await sleep(300); let k3 = await st();
  report(k3.active, "key back to s: s jumps again", k3);
  await keys("<Esc>"); await sleep(300);
  await ev(`app.plugins.disablePlugin("flash-jump")`); await sleep(500);
  await ev(`(()=>{const e=app.workspace.activeEditor.editor;e.setValue("abc");e.focus()})()`); await keys("<Esc>0"); await sleep(200);
  await keys("s"); await sleep(300); let k4 = await st();
  report(k4.doc === "bc", "plugin disabled: s is Vim's substitute again", k4);
  await keys("<Esc>"); await ev(`app.plugins.enablePlugin("flash-jump")`); await sleep(800);
  await ev(`app.workspace.activeEditor.editor.focus()`);
  // 7. maths switch off: s with maths on screen stays in Live Preview
  await ev(`(async()=>{const p=${P};p.settings.mathsAware=false;await p.saveSettings()})()`);
  await fresh(0); await keys("s"); await sleep(500); let k5 = await st();
  report(k5.active && !k5.source, "maths switch off: no Source mode", k5);
  await keys("<Esc>"); await sleep(300);
  await ev(`(async()=>{const p=${P};p.settings.mathsAware=true;await p.saveSettings()})()`);
} catch (e) { fails++; console.log("CRASH", e.message); }
finally {
  await keys("<Esc>");
  await ev(`(async()=>{const v=app.workspace.activeLeaf.view;if(v.getState().source)await v.setState({...v.getState(),source:false},{history:false});if(app.workspace.getActiveFile()?.path==='${NOTE}')app.workspace.activeEditor.editor.setValue("");for(const p of ['${NOTE}','${OTHER}']){const f=app.vault.getAbstractFileByPath(p);if(f){await app.vault.modify(f,"");await app.vault.delete(f)}}})()`);
  console.log(fails ? `${fails} FAILED` : "all passed", "· note left:", await ev(`!!app.vault.getAbstractFileByPath('${NOTE}')`));
}
ws.close();
process.exit(fails ? 1 : 0);
