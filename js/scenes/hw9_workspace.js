// Floating windows that you type into with your computer's keyboard.
// Look at a window to type in it. The trackpad moves windows. Alt keys do the rest.
// Code windows run each line right away and change the shape above them.
// Alt+K: keyboard on/off.

import * as cg from "../render/core/cg.js";
import { G2 } from "../util/g2.js";

const MAX_WINDOWS = 6;
const W = 1024, H = 768;
const SX = 0.4, SY = 0.3;
const DOCK = [0, -0.4, -0.5];
const DWELL = 0.35;
const SHAPES = ["cube", "sphere", "donut", "coneY", "octahedron", "tubeY"];

// Window layout, in canvas pixels
const TITLE_H = 70, FOOT_H = 90, TOP = TITLE_H + 14, LINE_H = 40;
const ROWS = Math.floor((H - TOP - FOOT_H) / LINE_H);
const FONT = "30px Consolas, Menlo, monospace";

const START_TEXT = [
   "Look at a window to type in it.",
   "Looking away (like at your keys) keeps focus.",
   "",
   "Trackpad drag: move the window",
   "Shift + drag: move it closer or farther",
   "Trackpad tap: put the cursor where you look",
   "",
   "Alt+B: bring the window to the keyboard",
   "Alt+L: lock typing to this window",
   "Alt+C: pick up a line, Alt+V: drop it",
   "Alt+N: new note, Alt+X: close, Alt+O: reopen",
   "Alt+T: rename, Alt+Enter: run code",
   "Alt+U: undo, Ctrl+V: paste (Cmd on a Mac)",
   "Alt+K: keyboard on/off (Alt is Option on Mac)",
];

const CODE_TEXT = [
   "// Each line runs on its own, every frame.",
   "// t is the time. Math works: sin, cos...",
   "shape = \"cube\"",
   "color = [0.3, 0.7, 1]",
   "size = 0.1",
   "spin = t",
   "bounce = 0.04 * sin(3 * t)",
];

const TODO_TEXT = [
   "Things to try:",
   "[ ] Change the shape to \"donut\"",
   "[ ] Make the color change with sin(t)",
   "[ ] Carry a line here with Alt+C, Alt+V",
   "[ ] Bring this window to the keyboard",
   "[ ] Make a new note with Alt+N",
   "[ ] Write code in it and run it with Alt+Enter",
];

const makeWindow = (title, kind, lines, yaw, h) => ({
   id: Math.random().toString(36).slice(2, 8),
   title, kind, lines: lines.slice(), yaw, h, dist: 1.1, docked: false, row: 0, col: 0,
});

const freshState = () => ({
   windows: [
      makeWindow("Start here", "notes", START_TEXT, 0.8, -0.05),
      makeWindow("Live code", "code", CODE_TEXT, 0, -0.05),
      makeWindow("To-do", "notes", TODO_TEXT, -0.8, -0.05),
   ],
   closed: [],
   center: null,
   rename: null,
   lock: -1,
   carry: null,
   keyboard: false,
   notes: 0,
   toast: { text: "", n: 0 },
});

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// Alt+K turns the keyboard on and off
const toggleKeyboard = e => {
   if (e.altKey && e.code === "KeyK") {
      e.preventDefault();
      window.interactMode = window.interactMode === 4 ? 0 : 4;
   }
};

// Only one listener of each kind, even after the scene reloads
const listen = (type, f) => {
   const key = "hw9_" + type;
   if (window[key])
      document.removeEventListener(type, window[key]);
   window[key] = f;
   if (f)
      document.addEventListener(type, f);
};

// Live code runs one line at a time, so a bad line doesn't stop the rest
const compiled = {};
const compile = text => {
   if (Object.keys(compiled).length > 300)
      for (const k in compiled)
         delete compiled[k];
   if (!(text in compiled))
      try {
         compiled[text] = new Function("scope", `with (scope) { ${text}\n}`);
      }
      catch (e) {
         compiled[text] = /'\}'|end of input/.test(e.message) ? "this line looks unfinished" : e.message;
      }
   return compiled[text];
};

const runCode = (lines, t) => {
   const vars = { shape: "cube", color: [1, 1, 1], size: 0.1, spin: 0, bounce: 0, t };
   const setBy = {}, errors = {};
   let row = -1;
   const scope = new Proxy(vars, {
      has: () => true,
      get: (o, k) => {
         if (k === Symbol.unscopables)
            return undefined;
         if (k in o)
            return o[k];
         if (k === "Math")
            return Math;
         if (typeof k === "string" && k in Math)
            return Math[k];
         if (k === "undefined")
            return undefined;
         throw new ReferenceError(`${String(k)} is not defined`);
      },
      set: (o, k, v) => {
         o[k] = v;
         setBy[k] = row;
         return true;
      },
   });
   lines.forEach((text, i) => {
      const s = text.trim();
      if (!s || s.startsWith("//"))
         return;
      row = i;
      const f = compile(text);
      if (typeof f === "string")
         errors[i] = f;
      else
         try {
            f(scope);
         }
         catch (e) {
            errors[i] = e.message;
         }
   });

   // Bad values fall back to the defaults
   const isNum = x => typeof x === "number" && isFinite(x);
   const check = (k, ok, msg, fallback) => {
      if (!ok) {
         if (setBy[k] !== undefined && errors[setBy[k]] === undefined)
            errors[setBy[k]] = msg;
         vars[k] = fallback;
      }
   };
   check("shape", SHAPES.includes(vars.shape), `shape can be: ${SHAPES.join(", ")}`, "cube");
   check("color", Array.isArray(vars.color) && vars.color.length === 3 && vars.color.every(isNum),
         "color needs 3 numbers, like [1, 0.5, 0]", [1, 1, 1]);
   check("size", isNum(vars.size), "size needs to be a number", 0.1);
   check("spin", isNum(vars.spin), "spin needs to be a number", 0);
   check("bounce", isNum(vars.bounce), "bounce needs to be a number", 0);
   vars.size = clamp(vars.size, 0.01, 0.4);
   return { vars, errors };
};

export const init = async model => {
   // Shared state
   if (!window.hw9State || !("closed" in window.hw9State)) {
      window.hw9State = freshState();
      window.hw9History = [];
   }
   const S = () => window.hw9State;
   let shared = false;
   const share = () => {
      shared = true;
      server.broadcastGlobal("hw9State");
   };

   // Short messages
   const say = text => {
      const g = S();
      g.toast = { text, n: g.toast.n + 1 };
   };
   let toastSeen = 0, toastUntil = 0;

   // Where each window is, measured from where you stood and your eye height
   const windowMatrix = w => {
      const c = S().center || { x: 0, y: 1.5, z: 0, yaw: 0 };
      const base = cg.mMultiply(cg.mTranslate(c.x, c.y, c.z), cg.mRotateY(c.yaw));
      if (w.docked)
         return cg.mMultiply(base, cg.mMultiply(cg.mTranslate(DOCK),
                cg.mMultiply(cg.mRotateX(-0.55), cg.mScale(SX * 0.8, SY * 0.8, 1))));
      const p = [-w.dist * Math.sin(w.yaw), w.h, -w.dist * Math.cos(w.yaw)];
      return cg.mMultiply(base, cg.mMultiply(cg.mTranslate(p),
             cg.mMultiply(cg.mRotateY(w.yaw), cg.mScale(SX, SY, 1))));
   };

   // Which way a head faces, left to right
   const headYaw = m => Math.atan2(m[8], m[10]);
   const recenter = () => {
      const m = gazeHead();
      S().center = { x: m[12], y: m[13], z: m[14], yaw: headYaw(m) };
   };

   // Focus follows your head in VR, or else the first person in VR
   const myHead = () => {
      const root = clay.root();
      const view = window.isXR && window.isXR()
                 ? cg.mix(root.inverseViewMatrix(0), root.inverseViewMatrix(1), 0.5)
                 : root.inverseViewMatrix(0);
      return cg.mMultiply(clay.inverseRootMatrix || cg.mIdentity(), view);
   };
   const gazeHead = () => {
      if (window.isXR && window.isXR())
         return myHead();
      for (const id of window.clients || [])
         if (id !== window.clientID && clientState.isXR(id))
            return clientState.head(id);
      return myHead();
   };

   // Where a ray hits a window, in window coordinates (-1 to 1)
   const hitWindow = (M, o, d) => {
      const inv = cg.mInverse(M);
      const lo = cg.mTransform(inv, o);
      const ld = cg.mTransform(inv, [d[0], d[1], d[2], 0]);
      if (Math.abs(ld[2]) < 1e-6)
         return null;
      const t = -lo[2] / ld[2];
      const x = lo[0] + t * ld[0], y = lo[1] + t * ld[1];
      return t > 0 && Math.abs(x) <= 1 && Math.abs(y) <= 1 ? { x, y, t } : null;
   };

   // Focus
   let focus = 1, hover = -1, hoverStart = 0, gaze = { i: -1 };
   const scroll = [];

   // Text layout
   const ctxFor = g2 => {
      const ctx = g2.getContext();
      ctx.font = FONT;
      return ctx;
   };
   const layout = (w, i, ctx) => {
      const left = w.kind === "code" ? 74 : 30;
      const cw = ctx.measureText("M").width;
      const cols = Math.floor((W - left - 24) / cw);
      const s = scroll[i] || (scroll[i] = { x: 0, y: 0 });
      if (w.row < s.y)
         s.y = w.row;
      if (w.row >= s.y + ROWS)
         s.y = w.row - ROWS + 1;
      if (w.col < s.x)
         s.x = w.col;
      if (w.col >= s.x + cols)
         s.x = w.col - cols + 1;
      return { left, cw, cols, s };
   };

   // Live code results, for each window that runs code
   let results = [];

   // Windows
   const g2s = [], panels = [];
   for (let i = 0; i < MAX_WINDOWS; i++) {
      const g2 = new G2(false, W, H);
      model.txtrSrc(2 + i, g2.getCanvas());
      g2s.push(g2);
      panels.push(model.add("square").txtr(2 + i));
      g2.render = () => drawWindow(i);
   }

   const drawWindow = i => {
      const g = S(), w = g.windows[i];
      if (!w)
         return;
      const ctx = ctxFor(g2s[i]);
      const L = layout(w, i, ctx);
      const isFocus = i === focus;
      const locked = g.lock === i;

      // Background and frame
      ctx.fillStyle = "rgba(18, 20, 28, 0.95)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#262b3a";
      ctx.fillRect(0, 0, W, TITLE_H);
      ctx.lineWidth = isFocus ? 12 : 4;
      ctx.strokeStyle = isFocus ? (locked ? "#ffb347" : "#4da3ff") : "#3a3f4f";
      ctx.strokeRect(0, 0, W, H);

      // Title and status
      ctx.textBaseline = "middle";
      ctx.font = "bold 34px Helvetica, Arial, sans-serif";
      ctx.fillStyle = "white";
      ctx.textAlign = "left";
      const naming = g.rename && g.rename.i === i;
      if (naming) {
         ctx.fillStyle = "#ffd27a";
         ctx.fillText(g.rename.text + (model.time % 1 < 0.6 ? "|" : ""), 24, TITLE_H / 2);
      }
      else
         ctx.fillText(w.title + (w.docked ? "  (at the keyboard)" : ""), 24, TITLE_H / 2);
      ctx.font = "26px Helvetica, Arial, sans-serif";
      ctx.textAlign = "right";
      if (naming) {
         ctx.fillStyle = "#ffd27a";
         ctx.fillText("Enter: save   Esc: cancel", W - 24, TITLE_H / 2);
      }
      else if (isFocus) {
         ctx.fillStyle = !g.keyboard ? "#aab" : locked ? "#ffb347" : "#7cc4ff";
         ctx.fillText(!g.keyboard ? "Keyboard off: press Alt+K" : locked ? "Typing here (locked)" : "Typing here",
                      W - 24, TITLE_H / 2);
      }
      if (i === hover) {
         const p = clamp((model.time - hoverStart) / DWELL, 0, 1);
         ctx.fillStyle = "#4da3ff";
         ctx.fillRect(0, TITLE_H - 8, W * p, 8);
      }

      // Text
      ctx.font = FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const errors = w.kind === "code" && results[i] ? results[i].errors : {};
      for (let r = 0; r < ROWS; r++) {
         const row = L.s.y + r;
         if (row >= w.lines.length)
            break;
         const y = TOP + r * LINE_H;
         if (errors[row] !== undefined) {
            ctx.fillStyle = "rgba(255, 70, 70, 0.3)";
            ctx.fillRect(6, y - 4, W - 12, LINE_H);
         }
         if (w.kind === "code") {
            ctx.fillStyle = "#667";
            ctx.textAlign = "right";
            ctx.fillText(row + 1, L.left - 16, y);
            ctx.textAlign = "left";
         }
         const text = w.lines[row];
         ctx.fillStyle = text.trim().startsWith("//") ? "#7a8" : "#e8e8f0";
         ctx.fillText(text.slice(L.s.x, L.s.x + L.cols), L.left, y);
      }

      // Cursor
      if (isFocus && g.keyboard && model.time % 1 < 0.6) {
         ctx.fillStyle = "#7cc4ff";
         ctx.fillRect(L.left + (w.col - L.s.x) * L.cw - 1, TOP + (w.row - L.s.y) * LINE_H - 4, 4, LINE_H);
      }

      // Footer: errors, tips and messages
      ctx.font = "26px Helvetica, Arial, sans-serif";
      ctx.textBaseline = "middle";
      const y1 = H - FOOT_H + 22, y2 = H - 26;
      const firstError = Object.keys(errors)[0];
      if (firstError !== undefined) {
         ctx.fillStyle = "#ff8080";
         ctx.fillText(`Line ${+firstError + 1}: ${errors[firstError]}`.slice(0, 70), 24, y1);
      }
      else if (w.kind === "code") {
         ctx.fillStyle = "#8a8f9f";
         ctx.fillText("shape, color, size, spin and bounce change the shape above", 24, y1);
      }
      if (isFocus) {
         const toast = model.time < toastUntil;
         ctx.fillStyle = toast ? "#ffd27a" : "#8a8f9f";
         ctx.fillText(toast ? g.toast.text
                            : "Alt+B bring   Alt+L lock   Alt+C/V carry   Alt+Enter run   Alt+U undo", 24, y2);
      }

      // Where you're looking
      if (gaze.i === i) {
         ctx.strokeStyle = "white";
         ctx.lineWidth = 4;
         ctx.beginPath();
         ctx.arc((gaze.x + 1) / 2 * W, (1 - gaze.y) / 2 * H, 12, 0, 2 * Math.PI);
         ctx.stroke();
      }
   };

   // The line you're carrying
   const cardG2 = new G2(false, 768, 160);
   model.txtrSrc(8, cardG2.getCanvas());
   const card = model.add("square").txtr(8);
   cardG2.render = () => {
      const ctx = cardG2.getContext();
      ctx.fillStyle = "rgba(60, 45, 15, 0.95)";
      ctx.fillRect(0, 0, 768, 160);
      ctx.strokeStyle = "#ffb347";
      ctx.lineWidth = 8;
      ctx.strokeRect(0, 0, 768, 160);
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillStyle = "#ffd27a";
      ctx.font = "24px Helvetica, Arial, sans-serif";
      ctx.fillText("Carrying a line. Look at a window and press Alt+V. Esc cancels.", 20, 36);
      ctx.fillStyle = "white";
      ctx.font = FONT;
      ctx.fillText((S().carry || "").slice(0, 40) || "(empty line)", 20, 100);
   };

   // Live code shapes, one for each window
   const previews = [];
   for (let i = 0; i < MAX_WINDOWS; i++) {
      const preview = model.add();
      const shapes = {};
      for (const s of SHAPES)
         shapes[s] = preview.add(s);
      previews.push({ preview, shapes });
   }

   // Typing
   const edit = (w, e) => {
      const line = w.lines[w.row];
      switch (e.key) {
      case "Enter": {
         const indent = line.match(/^ */)[0];
         w.lines.splice(w.row + 1, 0, indent + line.slice(w.col));
         w.lines[w.row] = line.slice(0, w.col);
         w.row++;
         w.col = indent.length;
         break;
      }
      case "Backspace":
         if (w.col > 0) {
            w.lines[w.row] = line.slice(0, w.col - 1) + line.slice(w.col);
            w.col--;
         }
         else if (w.row > 0) {
            w.col = w.lines[w.row - 1].length;
            w.lines[w.row - 1] += line;
            w.lines.splice(w.row, 1);
            w.row--;
         }
         break;
      case "Delete":
         if (w.col < line.length)
            w.lines[w.row] = line.slice(0, w.col) + line.slice(w.col + 1);
         else if (w.row < w.lines.length - 1) {
            w.lines[w.row] += w.lines[w.row + 1];
            w.lines.splice(w.row + 1, 1);
         }
         break;
      case "ArrowLeft":
         if (w.col > 0)
            w.col--;
         else if (w.row > 0)
            w.col = w.lines[--w.row].length;
         break;
      case "ArrowRight":
         if (w.col < line.length)
            w.col++;
         else if (w.row < w.lines.length - 1) {
            w.row++;
            w.col = 0;
         }
         break;
      case "ArrowUp":
         w.row = Math.max(0, w.row - 1);
         break;
      case "ArrowDown":
         w.row = Math.min(w.lines.length - 1, w.row + 1);
         break;
      case "Home":
         w.col = 0;
         break;
      case "End":
         w.col = line.length;
         break;
      case "Tab":
         w.lines[w.row] = line.slice(0, w.col) + "   " + line.slice(w.col);
         w.col += 3;
         break;
      case "Escape":
         if (S().carry === null)
            return false;
         S().carry = null;
         say("Put the line back.");
         break;
      default:
         if (e.key.length !== 1)
            return false;
         w.lines[w.row] = line.slice(0, w.col) + e.key + line.slice(w.col);
         w.col++;
      }
      w.col = Math.min(w.col, w.lines[w.row].length);
      return true;
   };

   // Alt commands use the window you're looking at, or else the focused one
   const target = () => {
      if (gaze.i >= 0) {
         focus = gaze.i;
         hover = -1;
      }
      return focus;
   };
   const commands = {
      KeyB: () => {
         const g = S(), w = g.windows[target()];
         const dock = !w.docked;
         g.windows.forEach(o => o.docked = false);
         w.docked = dock;
         say(dock ? "Brought the window to the keyboard. Alt+B sends it back." : "Sent the window back.");
      },
      KeyL: () => {
         const g = S();
         g.lock = g.lock >= 0 ? -1 : target();
         say(g.lock >= 0 ? "Typing is locked to this window. Alt+L unlocks it."
                         : "Unlocked. Focus follows your eyes again.");
      },
      KeyC: () => {
         const g = S(), w = g.windows[focus];
         g.carry = w.lines[w.row];
         say("Picked up the line. Look at a window and press Alt+V.");
      },
      KeyV: () => {
         const g = S(), w = g.windows[target()];
         if (g.carry === null)
            return say("Nothing to drop. Press Alt+C to pick up a line first.");
         w.lines.splice(w.row + 1, 0, g.carry);
         w.row++;
         w.col = g.carry.length;
         g.carry = null;
         say("Dropped the line here.");
      },
      KeyN: () => {
         const g = S();
         if (g.windows.length >= MAX_WINDOWS)
            return say(`You can have up to ${MAX_WINDOWS} windows. Close one with Alt+X.`);
         const m = gazeHead();
         const yaw = headYaw(m) - (g.center ? g.center.yaw : 0);
         const w = makeWindow(`Note ${++g.notes}`, "notes", [""], yaw, clamp(-m[9] * 1.1, -0.7, 0.7));
         g.windows.push(w);
         g.lock = -1;
         focus = g.windows.length - 1;
         say("New note. Start typing.");
      },
      KeyT: () => {
         const i = target();
         S().rename = { i, text: S().windows[i].title };
         say("Type a new name for this window.");
      },
      Enter: () => {
         const w = S().windows[target()];
         w.kind = w.kind === "code" ? "notes" : "code";
         say(w.kind === "code" ? "This window's code runs now. Alt+Enter stops it."
                               : "Stopped running this window's code.");
      },
      KeyO: () => {
         const g = S();
         if (!g.closed.length)
            return say("There are no closed windows to reopen.");
         if (g.windows.length >= MAX_WINDOWS)
            return say(`You can have up to ${MAX_WINDOWS} windows. Close one with Alt+X.`);
         const w = g.closed.pop();
         w.docked = false;
         g.windows.push(w);
         g.lock = -1;
         focus = g.windows.length - 1;
         say("Reopened the window.");
      },
      KeyX: () => {
         const g = S();
         target();
         if (g.windows.length <= 1)
            return say("Keep at least one window open.");
         g.closed.push(g.windows[focus]);
         if (g.closed.length > 10)
            g.closed.shift();
         g.windows.splice(focus, 1);
         scroll.splice(focus, 1);
         if (g.lock === focus)
            g.lock = -1;
         else if (g.lock > focus)
            g.lock--;
         focus = Math.min(focus, g.windows.length - 1);
         say("Closed the window. Alt+O reopens it.");
      },
   };

   // Undo. Typing in a row counts as one change. The history lasts through scene reloads.
   const history = window.hw9History || (window.hw9History = []);
   let lastKind = "", lastTime = 0;
   const remember = (before, kind = "") => {
      const grouped = kind && kind === lastKind && model.time - lastTime < 1;
      lastKind = kind;
      lastTime = model.time;
      if (grouped)
         return;
      history.push(before);
      if (history.length > 100)
         history.shift();
   };
   const undo = () => {
      if (!history.length)
         return say("Nothing to undo.");
      const g = S();
      g.windows = JSON.parse(history.pop());
      const ids = g.windows.map(w => w.id);
      g.closed = g.closed.filter(w => !ids.includes(w.id));
      g.rename = null;
      lastKind = "";
      if (g.lock >= g.windows.length)
         g.lock = -1;
      focus = clamp(focus, 0, g.windows.length - 1);
      say("Undid the last change.");
   };
   commands.KeyU = undo;
   commands.NumpadEnter = commands.Enter;

   // Keyboard
   window.keydown = e => {
      const g = S(), w = g.windows[focus];
      if (!w)
         return;
      const before = JSON.stringify(g.windows);

      // Renaming a window
      const n = g.rename;
      if (n && !e.altKey && !e.ctrlKey && !e.metaKey) {
         const r = g.windows[n.i];
         if (e.key === "Enter" && r && n.text.trim()) {
            r.title = n.text.trim();
            remember(before);
            say("Renamed the window.");
         }
         if (e.key === "Enter" || e.key === "Escape" || !r)
            g.rename = null;
         else if (e.key === "Backspace")
            n.text = n.text.slice(0, -1);
         else if (e.key.length === 1 && n.text.length < 30)
            n.text += e.key;
         e.preventDefault();
         share();
         return;
      }
      if (n && e.altKey && commands[e.code] && e.code !== "KeyT")
         g.rename = null;

      if (e.altKey && !e.ctrlKey && !e.metaKey) {
         if (commands[e.code]) {
            e.preventDefault();
            commands[e.code]();
            if (e.code !== "KeyU" && JSON.stringify(S().windows) !== before)
               remember(before);
            share();
         }
         return;
      }
      if (e.ctrlKey || e.metaKey) {
         if (e.code === "KeyZ") {
            e.preventDefault();
            undo();
            share();
         }
         return;
      }
      const text = JSON.stringify(w.lines);
      if (edit(w, e)) {
         e.preventDefault();
         let kind = "";
         if (e.key.length === 1 && e.key !== " ")
            kind = "type";
         else if (e.key === "Backspace" || e.key === "Delete")
            kind = "erase";
         if (JSON.stringify(w.lines) !== text)
            remember(before, kind);
         share();
      }
   };
   window.keyup = () => {};
   listen("keydown", toggleKeyboard);

   // Paste from the computer
   const pasteText = e => {
      const w = S().windows[focus];
      const text = e.clipboardData && e.clipboardData.getData("text");
      if (window.interactMode !== 4 || !w || !text)
         return;
      e.preventDefault();
      const n = S().rename;
      if (n) {
         n.text = (n.text + text.split("\n")[0].trim()).slice(0, 30);
         share();
         return;
      }
      remember(JSON.stringify(S().windows));
      lastKind = "";
      const parts = text.replace(/\r/g, "").replace(/\t/g, "   ").split("\n").slice(0, 200);
      const line = w.lines[w.row], after = line.slice(w.col);
      w.lines[w.row] = line.slice(0, w.col) + parts[0];
      w.lines.splice(w.row + 1, 0, ...parts.slice(1));
      w.row += parts.length - 1;
      w.col = w.lines[w.row].length;
      w.lines[w.row] += after;
      say(parts.length > 1 ? `Pasted ${parts.length} lines.` : "Pasted.");
      share();
   };
   listen("paste", pasteText);

   // Trackpad: drag moves the window, tap moves the cursor
   let drag = null;
   window.mousedown = e => drag = { x: e.clientX, y: e.clientY, moved: 0, before: JSON.stringify(S().windows) };
   window.mousemove = e => {
      if (!drag)
         return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      const w = S().windows[focus];
      if (!w || drag.moved < 5)
         return;
      if (drag.before) {
         remember(drag.before);
         drag.before = null;
      }
      if (w.docked) {
         w.docked = false;
         say("Sent the window back.");
      }
      if (e.shiftKey)
         w.dist = clamp(w.dist - dy * 0.004, 0.5, 3);
      else {
         w.yaw -= dx * 0.003;
         w.h = clamp(w.h - dy * 0.003, -0.9, 0.9);
      }
      share();
   };
   window.mouseup = () => {
      if (drag && drag.moved < 5 && gaze.i === focus) {
         const w = S().windows[focus];
         const L = layout(w, focus, ctxFor(g2s[focus]));
         const px = (gaze.x + 1) / 2 * W, py = (1 - gaze.y) / 2 * H;
         w.row = clamp(Math.floor((py - TOP) / LINE_H) + L.s.y, 0, w.lines.length - 1);
         w.col = clamp(Math.round((px - L.left) / L.cw) + L.s.x, 0, w.lines[w.row].length);
         share();
      }
      drag = null;
   };

   let keyboardWasOn = false, clientCount = 0, centerUntil = 0;

   model.animate(() => {
      window.hw9State = server.synchronize("hw9State");
      const g = S(), n = g.windows.length;

      // Keyboard on or off
      const on = window.interactMode === 4;
      if (on !== keyboardWasOn) {
         keyboardWasOn = on;
         g.keyboard = on;
         share();
      }

      // Center the windows on you once, when they first appear in VR.
      // It follows your head for half a second while the headset settles, then stays put.
      const xrHead = (window.isXR && window.isXR()) || (window.clients || []).some(id => clientState.isXR(id));
      if (!g.center || (xrHead && !g.center.xr)) {
         centerUntil = model.time + 0.5;
         recenter();
         g.center.xr = xrHead;
      }
      else if (model.time < centerUntil) {
         recenter();
         g.center.xr = xrHead;
      }

      // Catch up anyone who joins late
      const count = (window.clients || []).length;
      if (count > clientCount && shared)
         share();
      clientCount = count;

      if (g.toast.n !== toastSeen) {
         toastSeen = g.toast.n;
         toastUntil = model.time + 3;
      }

      // What you're looking at
      const head = gazeHead();
      const o = head.slice(12, 15), d = [-head[8], -head[9], -head[10]];
      const mats = g.windows.map(windowMatrix);
      gaze = { i: -1, t: Infinity };
      mats.forEach((M, i) => {
         const hit = hitWindow(M, o, d);
         if (hit && hit.t < gaze.t)
            gaze = { i, ...hit };
      });

      // Focus moves after a short look, unless it's locked
      if (g.lock >= 0 && g.lock < n) {
         focus = g.lock;
         hover = -1;
      }
      else if (gaze.i >= 0 && gaze.i !== focus) {
         if (hover !== gaze.i) {
            hover = gaze.i;
            hoverStart = model.time;
         }
         if (model.time - hoverStart > DWELL) {
            focus = gaze.i;
            hover = -1;
         }
      }
      else
         hover = -1;
      focus = clamp(focus, 0, n - 1);

      // Live code
      results = g.windows.map(w => w.kind === "code" ? runCode(w.lines, model.time) : null);

      // Draw the windows
      for (let i = 0; i < MAX_WINDOWS; i++)
         if (i < n) {
            panels[i].setMatrix(mats[i]);
            g2s[i].update();
         }
         else
            panels[i].identity().scale(0);

      // Live code shapes. A shape turns a dull red while a line is broken.
      previews.forEach(({ preview, shapes }, i) => {
         const r = results[i];
         if (!r) {
            preview.identity().scale(0);
            return;
         }
         const v = r.vars, broken = Object.keys(r.errors).length > 0;
         const top = cg.mTransform(mats[i], [0, 1, 0]);
         preview.identity().move(top[0], top[1] + 0.06 + v.size + v.bounce, top[2])
                .turnY(v.spin).scale(v.size);
         for (const s of SHAPES)
            shapes[s].identity().scale(s === v.shape ? 1 : 0)
                     .color(broken ? [0.7, 0.3, 0.3] : v.color);
      });

      // The carried line
      if (g.carry !== null) {
         card.setMatrix(cg.mMultiply(head, cg.mMultiply(cg.mTranslate(0, -0.16, -0.6), cg.mScale(0.2, 0.042, 1))));
         cardG2.update();
      }
      else
         card.identity().scale(0);
   });
};

export const deinit = () => {
   listen("keydown", null);
   listen("paste", null);
   window.keydown = window.keyup = null;
   window.mousedown = window.mousemove = window.mouseup = null;
};
