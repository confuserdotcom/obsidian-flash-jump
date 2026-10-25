// Unit tests for the pure parts:  npm test   (e2e.mjs: real keys in Obsidian)
const assert = require("assert");
const { findMatches, assignLabels, jumpSelection, keyAction, cleanSettings, ALPHABET } = require("./main.js").core;
let n = 0, failed = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); } };
const all = d => [{ from: 0, to: d.length }];

t("smart case: lower case ignores case", () => assert.deepStrictEqual(findMatches("Ab ab AB", all("Ab ab AB"), "ab"), [0, 3, 6]));
t("smart case: an upper case letter makes it exact", () => assert.deepStrictEqual(findMatches("Ab ab AB", all("Ab ab AB"), "Ab"), [0]));
t("only the visible ranges are searched", () => assert.deepStrictEqual(findMatches("xa xa xa", [{ from: 3, to: 5 }], "x"), [3]));
t("overlapping matches all count", () => assert.deepStrictEqual(findMatches("aaa", all("aaa"), "aa"), [0, 1]));
t("backslash and braces are ordinary characters", () => {
  const d = "$\\exists x, \\forall y$";
  assert.deepStrictEqual(findMatches(d, all(d), "\\e"), [1]);
});
t("empty pattern → nothing", () => assert.deepStrictEqual(findMatches("abc", all("abc"), ""), []));

t("closest match gets the first label", () => {
  const d = "ab ab ab ab";
  const l = assignLabels(d, [0, 3, 6, 9], 7, 2);
  assert.strictEqual(l[0].pos, 6);
});
t("labels skip letters that could continue the pattern", () => {
  const d = "as ad af";                     // next chars after "a": s, d, f
  const l = assignLabels(d, [0, 3, 6], 0, 1);
  assert(!l.some(x => "sdf".includes(x.label)), JSON.stringify(l));
});
t("labels are unique and capped by the alphabet", () => {
  const d = "x".repeat(100);
  const l = assignLabels(d, [...Array(100).keys()], 0, 1);
  assert(l.length <= 26 && new Set(l.map(x => x.label)).size === l.length);
});
t("a position keeps its label while the pattern grows", () => {
  const d = "exq exr ext";               // after "ex": q r t, none of them a label
  const first = assignLabels(d, [0, 4, 8], 0, 1);
  const prev = new Map(first.map(x => [x.pos, x.label]));
  const second = assignLabels(d, [0, 4, 8], 0, 2, prev);
  for (const x of second) assert.strictEqual(x.label, prev.get(x.pos));
});

t("jump without selection moves the cursor", () => assert.deepStrictEqual(jumpSelection(10, null, 50), { anchor: 10 }));
t("visual forward includes the target character", () => assert.deepStrictEqual(jumpSelection(10, 2, 50), { anchor: 2, head: 11 }));
t("visual backward stops on the target", () => assert.deepStrictEqual(jumpSelection(1, 5, 50), { anchor: 5, head: 1 }));

// key rules while a jump is open (D1): unused keys cancel and still do their normal job
const k = (key, mods = {}) => keyAction({ key, ctrlKey: false, metaKey: false, altKey: false, getModifierState: m => !!mods[m], ...mods });
t("letters, digits, \\ and { extend the pattern", () => { for (const c of ["a", "Z", "7", "\\", "{", "^"]) assert.strictEqual(k(c), "char", c); });
t("Esc, Enter, Backspace are the jump's own keys", () => assert.deepStrictEqual([k("Escape"), k("Enter"), k("Backspace")], ["esc", "enter", "back"]));
t("Shift, CapsLock, dead keys, AltGr alone are ignored (capitals and accents still type)", () => {
  for (const c of ["Shift", "CapsLock", "Dead", "AltGraph", "Compose"]) assert.strictEqual(k(c), "ignore", c);
});
t("AltGr + key types a character (\\ on AZERTY), even if the OS reports Ctrl+Alt", () =>
  assert.strictEqual(k("\\", { ctrlKey: true, altKey: true, AltGraph: true }), "char"));
t("arrows, Tab, Home, F-keys cancel", () => { for (const c of ["ArrowDown", "Tab", "Home", "PageDown", "F5"]) assert.strictEqual(k(c), "cancel", c); });
t("Ctrl / Alt / Meta shortcuts cancel", () => {
  assert.strictEqual(k("s", { ctrlKey: true }), "cancel");
  assert.strictEqual(k("x", { altKey: true }), "cancel");
  assert.strictEqual(k("p", { metaKey: true }), "cancel");
});

// label characters and settings
t("custom label characters are used, in order", () => {
  const d = "x1 x2 x3";
  const l = assignLabels(d, [0, 3, 6], 0, 1, new Map(), "jkl");
  assert.deepStrictEqual(l.map(x => x.label), ["j", "k", "l"]);
});
t("custom labels still skip letters that continue the pattern", () => {
  const d = "aj ak al";
  const l = assignLabels(d, [0, 3, 6], 0, 1, new Map(), "jklm");
  assert.deepStrictEqual(l.map(x => x.label), ["m"]);
});
t("settings: empty key and too few labels fall back to the defaults", () => {
  const s = cleanSettings({ key: "  ", labels: "a", idleSeconds: "x" });
  assert.deepStrictEqual([s.key, s.labels, s.idleSeconds], ["s", ALPHABET, 20]);
});
t("settings: labels are lower-cased, deduplicated, letters and digits only", () =>
  assert.strictEqual(cleanSettings({ labels: "AsDf a;" }).labels, "asdf"));
t("settings: idle time is kept between 2 s and 10 min", () => {
  assert.strictEqual(cleanSettings({ idleSeconds: 0.5 }).idleSeconds, 2);
  assert.strictEqual(cleanSettings({ idleSeconds: 9999 }).idleSeconds, 600);
});
t("settings: missing ones get their defaults", () => {
  const s = cleanSettings(null);
  assert.deepStrictEqual([s.key, s.mathsAware, s.dim], ["s", true, true]);
});

if (failed) { console.log(`${failed} failed, ${n} passed`); process.exit(1); }
console.log(`ok — ${n} tests`);
