// Flash Jump: press s, type a few characters, then the label shown on the match you want.
// Normal and visual mode (visual: the selection grows to the target). One match left: it jumps
// by itself. Enter = the closest match, Backspace = one character less, Esc = cancel.
//
// Maths: when rendered maths is on screen, the jump switches the note to Source mode, so every
// formula shows as written and any character inside it can be a target; Live Preview comes back
// when the jump ends, with the cursor's line kept at the same height on screen.
//
// The key is a CodeMirror Vim action (a vimrc `vnoremap s :…` would leave visual mode first and lose
// the selection). It works with Obsidian's built-in Vim and with Vim Motions.

const obsidian = (() => { try { return require("obsidian"); } catch { return {}; } })(); // node tests
const { Plugin = class {}, PluginSettingTab = class {}, Setting, MarkdownView } = obsidian;
const cm6 = name => { try { return require(name); } catch { return null; } };
const CMState = cm6("@codemirror/state"), CMView = cm6("@codemirror/view");

const ALPHABET = "asdfghjklqwertyuiopzxcvbnm";
const DEFAULTS = { key: "s", labels: ALPHABET, mathsAware: true, dim: true, idleSeconds: 20 };

// ─── Pure core (unit-tested in test.js) ──────────────────────────────────────

// Every match of `pattern` in the visible ranges. Smart case: lower case pattern ignores case.
function findMatches(doc, ranges, pattern) {
  if (!pattern) return [];
  const exact = /[A-Z]/.test(pattern), p = exact ? pattern : pattern.toLowerCase(), out = [];
  for (const { from, to } of ranges) {
    const text = exact ? doc.slice(from, to) : doc.slice(from, to).toLowerCase();
    for (let i = text.indexOf(p); i !== -1; i = text.indexOf(p, i + 1)) out.push(from + i);
  }
  return out;
}

// Closest matches first; labels skip every character that could continue the pattern (so typing
// on never gets eaten as a label). A position keeps its label from the previous keystroke if it can.
function assignLabels(doc, matches, cursor, patternLen, previous = new Map(), alphabet = ALPHABET) {
  const sorted = [...new Set(matches)].sort((a, b) => Math.abs(a - cursor) - Math.abs(b - cursor) || a - b);
  const next = new Set(sorted.map(m => doc.charAt(m + patternLen).toLowerCase()));
  const free = [...new Set(alphabet.toLowerCase())].filter(c => !next.has(c));
  const out = [], used = new Set();
  for (const m of sorted) {                        // keep last keystroke's label where possible
    const l = previous.get(m);
    if (l && free.includes(l) && !used.has(l)) { out.push({ pos: m, label: l }); used.add(l); }
  }
  const rest = free.filter(c => !used.has(c));
  for (const m of sorted) {
    if (!rest.length) break;
    if (!out.some(o => o.pos === m)) out.push({ pos: m, label: rest.shift() });
  }
  return out.sort((a, b) => Math.abs(a.pos - cursor) - Math.abs(b.pos - cursor) || a.pos - b.pos);
}

// Where a jump lands: in visual mode the selection grows from its anchor to the target
// (one past it when going forward, so the target character is included, like flash.nvim).
function jumpSelection(target, anchor, docLength) {
  if (anchor === null) return { anchor: target };
  return { anchor, head: target >= anchor ? Math.min(target + 1, docLength) : target };
}

// What a key does while a jump is open. "cancel" ends the jump and lets the key do its normal job
// (arrows, Tab, Ctrl-…). Modifier-only and dead keys are ignored so capitals and accents still type;
// AltGr + key is a character (\ { on AZERTY), even when the OS also reports Ctrl+Alt.
const IGNORED = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "Dead", "Compose", "Unidentified"]);
function keyAction(e) {
  if (IGNORED.has(e.key)) return "ignore";
  const altGr = e.getModifierState && e.getModifierState("AltGraph");
  if ((e.ctrlKey || e.metaKey || e.altKey) && !altGr) return "cancel";
  if (e.key === "Escape") return "esc";
  if (e.key === "Enter") return "enter";
  if (e.key === "Backspace") return "back";
  return e.key.length === 1 ? "char" : "cancel";
}

// The settings, cleaned: one key, at least two distinct label letters, a sane idle time.
function cleanSettings(s) {
  const out = { ...DEFAULTS, ...s };
  out.key = typeof out.key === "string" && out.key.trim() ? out.key.trim() : DEFAULTS.key;
  const labels = [...new Set(String(out.labels).toLowerCase().replace(/[^a-z0-9]/g, ""))].join("");
  out.labels = labels.length >= 2 ? labels : ALPHABET;
  out.idleSeconds = Math.min(600, Math.max(2, Number(out.idleSeconds) || DEFAULTS.idleSeconds));
  return out;
}

// ─── Editor side ─────────────────────────────────────────────────────────────

const setLabels = CMState && CMState.StateEffect.define();
const labelField = CMState && CMState.StateField.define({
  create: () => CMView.Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setLabels)) deco = e.value;
    return deco;
  },
  provide: f => CMView.EditorView.decorations.from(f),
});

class LabelWidget extends (CMView ? CMView.WidgetType : class {}) {
  constructor(label, pos) { super(); this.label = label; this.pos = pos; }
  eq(o) { return o.label === this.label && o.pos === this.pos; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "flash-jump-label";
    el.textContent = this.label;
    el.dataset.flashLabel = this.label;
    el.dataset.pos = this.pos;
    return el;
  }
  ignoreEvent() { return true; }
}

const setSource = (view, on) => view.setState({ ...view.getState(), source: on }, { history: false });

// Switch mode without the text jumping: the cursor's line stays at the same height on screen.
async function keepLine(cm, change) {
  const pos = cm.state.selection.main.head, before = cm.coordsAtPos(pos);
  const top = cm.scrollDOM.getBoundingClientRect().top;
  await change();
  if (before) cm.dispatch({ effects: CMView.EditorView.scrollIntoView(pos, { y: "start", yMargin: Math.max(0, before.top - top) }) });
}

// Rendered maths inside the visible part of the editor (Live Preview draws it as .math widgets).
function mathOnScreen(cm) {
  const box = cm.scrollDOM.getBoundingClientRect();
  return [...cm.contentDOM.querySelectorAll(".math")].some(el => {
    const r = el.getBoundingClientRect();
    return r.bottom > box.top && r.top < box.bottom;
  });
}

// One jump session on one editor.
//
//   key ─► start() ── maths on screen? ── no ──► plain jump
//                         │ yes
//                         ▼
//        toRaw(): leaf id → localStorage, then Source mode                   ┐ one queue:
//   ...label / Enter / letters / Backspace handled by key()                  │ switches never
//   any other key, click, blur, tab/note change, idle time ─► end()          │ overtake each
//        end() ─► toRendered(): Live Preview, then forget the leaf id        ┘ other
//   plugin load/unload ─► restoreLeftovers(): any leaf still listed → rendered
class Jump {
  constructor(plugin, cm) {
    this.plugin = plugin; this.cm = cm;
    const sel = cm.state.selection.main;
    this.anchor = sel.empty ? null : sel.anchor;
    this.cursor = sel.head;
    this.pattern = ""; this.labels = []; this.previous = new Map();
    cm.dom.classList.add("flash-jump-active");
    cm.dom.classList.toggle("flash-jump-dim", plugin.settings.dim);
    // Every way out ends the jump: its own keys below, any other key, a click, the window
    // losing focus, a note/tab change (plugin), and the idle time without a key.
    this.onKey = e => this.key(e);
    this.onOut = () => this.end();
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("mousedown", this.onOut, true);
    window.addEventListener("blur", this.onOut);
    this.idle();
  }

  idle() {
    clearTimeout(this.timer);
    this.timer = setTimeout(this.onOut, this.plugin.idleMs);
  }

  key(e) {
    const action = keyAction(e);
    if (action === "ignore") return;
    if (action === "cancel") { this.end(); return; }            // the key still does its normal job
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    this.idle();
    if (action === "esc") this.end();
    else if (action === "enter") this.labels.length ? this.go(this.labels[0].pos) : this.end();
    else if (action === "back") this.pattern ? this.search(this.pattern.slice(0, -1)) : this.end();
    else {
      const hit = this.pattern && this.labels.find(l => l.label === e.key.toLowerCase());
      if (hit) this.go(hit.pos); else this.search(this.pattern + e.key);
    }
  }

  search(pattern) {
    this.pattern = pattern;
    const doc = this.cm.state.doc.toString();
    const matches = findMatches(doc, [this.onScreen()], pattern);
    if (pattern && matches.length === 1) { this.go(matches[0]); return; }
    this.labels = pattern ? assignLabels(doc, matches, this.cursor, pattern.length, this.previous, this.plugin.settings.labels) : [];
    this.previous = new Map(this.labels.map(l => [l.pos, l.label]));
    this.render();
  }

  // What is on screen, as one doc range. Not visibleRanges: those leave out the source of block
  // widgets ($$ formulas), which is exactly what we want to search too.
  onScreen() {
    const cm = this.cm, sc = cm.scrollDOM, off = cm.documentTop - sc.getBoundingClientRect().top + sc.scrollTop;
    const from = cm.lineBlockAtHeight(Math.max(0, sc.scrollTop - off)).from;
    const to = cm.lineBlockAtHeight(Math.max(0, sc.scrollTop + sc.clientHeight - off)).to;
    return { from, to };
  }

  // A label right after each labelled match (only those: typing \ in raw LaTeX matches hundreds).
  render() {
    const doc = this.cm.state.doc, len = this.pattern.length, deco = [];
    for (const l of this.labels) {
      const end = Math.min(l.pos + len, doc.length);
      deco.push(CMView.Decoration.mark({ class: "flash-jump-match" }).range(l.pos, end));
      deco.push(CMView.Decoration.widget({ widget: new LabelWidget(l.label, l.pos), side: 1 }).range(end));
    }
    this.cm.dispatch({ effects: setLabels.of(CMView.Decoration.set(deco, true)) });
  }

  // Land like `zz`: the target line goes to the middle of the screen (keepLine then holds it
  // there through the switch back to Live Preview).
  go(target) {
    const selection = jumpSelection(target, this.anchor, this.cm.state.doc.length);
    this.cm.dispatch({ selection, effects: CMView.EditorView.scrollIntoView(selection.head ?? selection.anchor, { y: "center" }) });
    this.end();
  }

  end() {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("mousedown", this.onOut, true);
    window.removeEventListener("blur", this.onOut);
    this.cm.dom.classList.remove("flash-jump-active", "flash-jump-dim");
    this.cm.dispatch({ effects: setLabels.of(CMView.Decoration.none) });
    if (this.plugin.jump === this) this.plugin.jump = null;
    if (this.view) this.plugin.toRendered(this.view);
  }
}

// The Vim object is looked up fresh each time (Vim Motions deletes it when it unloads).
const vimApi = () => window.CodeMirrorAdapter && window.CodeMirrorAdapter.Vim;
const CONTEXTS = ["normal", "visual"];

// Tabs a jump switched to Source mode, by leaf id, kept in localStorage: Obsidian saves the mode per
// tab (even across restarts), so a tab left raw by a crash is put back when the plugin loads.
const RAW_KEY = "flash-jump-raw";

class FlashJump extends Plugin {
  async onload() {
    this.settings = cleanSettings(await this.loadData());
    this.patched = [];
    this.mapped = null;                       // the key mapped in the current Vim keymap
    this.queue = Promise.resolve();
    this.registerEditorExtension(labelField);
    this.addSettingTab(new FlashJumpSettings(this.app, this));
    this.addCommand({ id: "jump", name: "Jump", editorCallback: () => this.start() });
    this.app.workspace.onLayoutReady(() => { this.patchReloads(); this.register(); this.restoreLeftovers(); });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => { this.jump && this.jump.end(); this.patchReloads(); this.register(); }));
    this.registerEvent(this.app.workspace.on("file-open", () => { this.jump && this.jump.end(); }));
  }

  onunload() {
    this.jump && this.jump.end();
    this.restoreLeftovers();
    this.unregister();
    for (const [obj, name, orig] of this.patched) obj[name] = orig;
  }

  get idleMs() { return this._idleMs ?? this.settings.idleSeconds * 1000; }
  set idleMs(ms) { this._idleMs = ms; }      // e2e tests shorten it

  async saveSettings() {
    this.settings = cleanSettings(this.settings);
    await this.saveData(this.settings);
    this.unregister();
    this.register();
  }

  // Map the key to the jump in normal and visual mode. Idempotent: the map is added again only
  // when Vim's keymap lost it (Vim Motions rebuilds its keymap on every config reload).
  register() {
    const Vim = vimApi();
    if (!Vim) return;
    Vim.defineAction("flashJump", () => { this.start(); });
    if (this.mapped === this.settings.key && Vim === this.mappedIn) return;
    for (const context of CONTEXTS) Vim.mapCommand(this.settings.key, "action", "flashJump", {}, { context });
    this.mapped = this.settings.key; this.mappedIn = Vim;
  }

  // Vim's unmap takes out the newest map of that key and mode: ours, and Vim's own key is back.
  unregister() {
    const Vim = vimApi();
    if (Vim && this.mapped && Vim === this.mappedIn) for (const context of CONTEXTS) Vim.unmap(this.mapped, context);
    this.mapped = null; this.mappedIn = null;
  }

  // Mode switches run one after the other: back-to-rendered can never be overtaken by a
  // switch-to-raw that started earlier.
  switchMode(view, raw) {
    const cm = view.editor.cm;
    this.queue = this.queue.then(() => view.editor && keepLine(cm, () => setSource(view, raw))).catch(e => console.error("flash-jump", e));
    return this.queue;
  }

  rawIds() { try { return this.app.loadLocalStorage(RAW_KEY) || []; } catch { return []; } }
  setRawIds(ids) { this.app.saveLocalStorage(RAW_KEY, ids.length ? ids : null); }

  toRaw(view) {
    this.setRawIds([...new Set([...this.rawIds(), view.leaf.id])]);
    return this.switchMode(view, true);
  }

  toRendered(view) {
    const id = view.leaf.id;
    return this.switchMode(view, false).then(() => this.setRawIds(this.rawIds().filter(x => x !== id)));
  }

  // Tabs still marked raw from a jump that never ended (crash, reload): back to rendered.
  restoreLeftovers() {
    const ids = new Set(this.rawIds());
    if (!ids.size) return;
    this.app.workspace.iterateAllLeaves(leaf => {
      if (ids.has(leaf.id) && leaf.view instanceof MarkdownView && leaf.view.getState().source) this.switchMode(leaf.view, false);
    });
    this.setRawIds([]);
  }

  async start() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView), cm = view?.editor?.cm;
    if (!cm) return;
    this.jump && this.jump.end();
    const jump = this.jump = new Jump(this, cm);
    if (this.settings.mathsAware && view.getMode() === "source" && !view.getState().source && mathOnScreen(cm)) {
      jump.view = view;                      // end() puts this tab back to rendered
      await this.toRaw(view);
      if (!jump.done) cm.focus();
    }
  }

  // Re-register after Vim Motions (re)loads its vimrc / init.lua: that rebuilds the keymap.
  patchReloads() {
    const vm = this.app.plugins.plugins["vim-motions"], self = this;
    if (!vm || vm.__flashJump) return;
    vm.__flashJump = true;
    for (const name of ["reloadAllConfigs", "softReloadVimrc", "softReloadLuaConfig"]) {
      const orig = vm[name];
      if (typeof orig !== "function") continue;
      vm[name] = async function (...args) { try { return await orig.apply(this, args); } finally { self.mapped = null; self.register(); } };
      this.patched.push([vm, name, orig]);
    }
    this.patched.push([vm, "__flashJump", undefined]);
  }
}

class FlashJumpSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this, s = this.plugin.settings;
    containerEl.empty();
    const save = async () => { await this.plugin.saveSettings(); };
    new Setting(containerEl).setName("Key").setDesc("Vim key that starts a jump, in normal and visual mode. It replaces Vim's own use of that key (for s, substitute: use cl instead). The command \"Jump\" works without Vim too.")
      .addText(t => t.setPlaceholder("s").setValue(s.key).onChange(async v => { if (v.trim()) { s.key = v.trim(); await save(); } }));
    new Setting(containerEl).setName("Label characters").setDesc("Letters used as labels, the easiest to reach first. Letters that could continue what you typed are skipped, so typing on never picks a label by mistake.")
      .addText(t => t.setPlaceholder(ALPHABET).setValue(s.labels).onChange(async v => { s.labels = v; await save(); }));
    new Setting(containerEl).setName("Jump inside rendered maths").setDesc("When rendered maths is on screen, show the note as written (Source mode) during the jump, so any character of a formula can be a target. Live Preview comes back when the jump ends.")
      .addToggle(t => t.setValue(s.mathsAware).onChange(async v => { s.mathsAware = v; await save(); }));
    new Setting(containerEl).setName("Dim the note").setDesc("Fade the text during a jump so the matches and labels stand out.")
      .addToggle(t => t.setValue(s.dim).onChange(async v => { s.dim = v; await save(); }));
    new Setting(containerEl).setName("Give up after (seconds)").setDesc("A jump with no key pressed for this long ends by itself.")
      .addText(t => t.setPlaceholder("20").setValue(String(s.idleSeconds)).onChange(async v => { s.idleSeconds = v; await save(); }));
  }
}

module.exports = FlashJump;
module.exports.core = { findMatches, assignLabels, jumpSelection, keyAction, cleanSettings, DEFAULTS, ALPHABET };
