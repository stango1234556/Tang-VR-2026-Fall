import * as cg from "../render/core/cg.js";
import { AIQuery } from "../util/aiquery.js";

/*
   AI Alchemy: grab items from the shelf, drop one onto another to combine them,
   and the AI invents the result (name, description, and a 3D model).
   Drop an item back on the shelf to discard it.

   Console helpers for testing without a headset:
      craft("Fire", "Water")
      resetCraft()
*/

const TABLE_POS = [0, 0.95, 0];
const TABLE_SIZE = [0.45, 0.02, 0.22];
const SHELF_Z = -0.32;
const SHELF_TOP_Y = 1.62;
const SHELF_COLS = 12;
const SHELF_ROWS = 5;
const SHELF_DX = 0.085;
const SHELF_DY = 0.11;
const ITEM_SIZE = 0.032;
const GRAB_R = 0.06;
const COMBINE_R = 0.07;
const SHELF_PER_PAGE = SHELF_COLS * SHELF_ROWS;
const SHELF_HALF_W = SHELF_COLS * SHELF_DX / 2 + 0.02;
const PANEL_POS = [-0.95, 1.8, -0.25];
const PANEL_SCALE = 0.7;
const PANEL_WIDTH = 34;
const BUTTON_POS = [SHELF_HALF_W + 0.09, SHELF_TOP_Y - 2 * SHELF_DY, SHELF_Z + 0.06];
const STORAGE_KEY = "hw4_alchemy_v1";
const AI_MODEL = "gpt-4.1-mini";
const AI_TIMEOUT = 90000;

const BASE_ITEMS = {
   "Water": {
      description: "Wet, clear and always flowing.",
      parts: [
         { form: "sphere", pos: [0, -0.2, 0], scale: [0.7, 0.7, 0.7], color: [0.2, 0.5, 1] },
         { form: "coneY", pos: [0, 0.55, 0], scale: [0.5, 0.45, 0.5], color: [0.2, 0.5, 1] },
      ],
   },
   "Fire": {
      description: "Hot, bright and hungry.",
      parts: [
         { form: "coneY", pos: [0, 0, 0], scale: [0.6, 0.9, 0.6], color: [1, 0.35, 0] },
         { form: "coneY", pos: [0, -0.15, 0], scale: [0.35, 0.6, 0.35], color: [1, 0.9, 0.1] },
      ],
   },
   "Earth": {
      description: "Solid ground beneath your feet.",
      parts: [
         { form: "cube", pos: [0, -0.3, 0], scale: [0.8, 0.4, 0.8], color: [0.45, 0.28, 0.12] },
         { form: "cube", pos: [0, 0.2, 0], scale: [0.8, 0.12, 0.8], color: [0.2, 0.6, 0.2] },
      ],
   },
   "Air": {
      description: "Invisible, but you can feel it.",
      parts: [
         { form: "torusY", pos: [0, 0.35, 0], scale: [0.7, 0.7, 0.7], color: [0.85, 0.95, 1] },
         { form: "torusY", pos: [0, -0.1, 0], scale: [0.5, 0.5, 0.5], color: [0.85, 0.95, 1] },
         { form: "torusY", pos: [0, -0.5, 0], scale: [0.3, 0.3, 0.3], color: [0.85, 0.95, 1] },
      ],
   },
};

const ALLOWED_FORMS = new Set([
   "coneX", "coneY", "coneZ", "cube", "cubeXZ", "pyramidX", "pyramidY", "pyramidZ",
   "ringX", "ringY", "ringZ", "sphere", "octahedron", "torusX", "torusY", "torusZ",
   "tubeX", "tubeY", "tubeZ", "diskX", "diskY", "diskZ",
]);

const SYSTEM_PROMPT =
   "You are the crafting engine of a VR alchemy game, like Little Alchemy or Infinite Craft. " +
   "The player combines two items and you decide what they make. " +
   "The result is a single thing, 1 to 3 words, Title Case, usually a concrete object, " +
   "material, creature, place or phenomenon. Be logical first, playful second. " +
   "Combining an item with itself is allowed (e.g. Water + Water = Puddle). " +
   "If one of the known items is a good answer, reuse its exact name. " +
   "Also design a tiny 3D model of the result from 2 to 8 primitive shapes. " +
   "The model fits in a box from -1 to 1 on each axis; +Y is up and the viewer looks from +Z. " +
   "Allowed forms: " + [...ALLOWED_FORMS].join(", ") + ". " +
   "'pos' is the shape center, 'scale' is its half-size per axis (0.05 to 1), " +
   "'rot' is an optional [x,y,z] rotation in degrees, and 'color' is [r,g,b] from 0 to 1. " +
   "Respond with JSON only, in exactly this shape: " +
   '{"name": string, "description": string (one short fun sentence), ' +
   '"parts": [{"form": string, "pos": [x,y,z], "scale": [x,y,z], "rot": [x,y,z], "color": [r,g,b]}]}';

export const init = async model => {
   const aiQuery = new AIQuery();

   let discovered = {};   // name -> { description, parts }
   let order = [];        // discovery order, used for the shelf layout
   let recipes = {};      // "a + b" -> result name, so a pair always gives the same result
   let workspace = [];    // items out on the table
   let grabbed = { left: null, right: null };
   let status = "Grab an item from the shelf to start.";
   let lastRecipe = "";
   let lastDescription = "";
   let newFlashTime = -10;

   const save = () => {
      try {
         localStorage.setItem(STORAGE_KEY, JSON.stringify({ discovered, order, recipes }));
      } catch (e) {}
   };

   const load = () => {
      try {
         const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
         if (data && data.discovered && data.order) {
            discovered = data.discovered;
            order = data.order;
            recipes = data.recipes || {};
            return;
         }
      } catch (e) {}
      discovered = JSON.parse(JSON.stringify(BASE_ITEMS));
      order = Object.keys(BASE_ITEMS);
      recipes = {};
   };

   model.add("cube").move(TABLE_POS).scale(TABLE_SIZE).color(0.35, 0.22, 0.12);
   model.add("cube").move(0, TABLE_POS[1] - 0.48, 0).scale(0.05, 0.47, 0.05).color(0.25, 0.15, 0.08);

   // Bookcase: items sit on a plank under each row, with name tags on the plank's front edge.
   const plankTopY = row => SHELF_TOP_Y - row * SHELF_DY - ITEM_SIZE * 0.8;
   const shelfTopY = plankTopY(-1);
   const wood = [0.45, 0.3, 0.18];
   const darkWood = [0.3, 0.19, 0.1];
   for (let row = -1; row < SHELF_ROWS; row++)
      model.add("cube").move(0, plankTopY(row) - 0.006, SHELF_Z).scale(SHELF_HALF_W, 0.006, 0.05).color(...wood);
   model.add("cube").move(0, 0.01, SHELF_Z).scale(SHELF_HALF_W, 0.01, 0.05).color(...wood);
   for (const side of [-1, 1])
      model.add("cube").move(side * (SHELF_HALF_W + 0.01), shelfTopY / 2, SHELF_Z)
         .scale(0.01, shelfTopY / 2, 0.05).color(...darkWood);
   model.add("cube").move(0, shelfTopY / 2, SHELF_Z - 0.052)
      .scale(SHELF_HALF_W, shelfTopY / 2, 0.003).color(...darkWood);

   const shelfRoot = model.add();
   const workRoot = model.add();

   const panelHolder = model.add().move(PANEL_POS).turnY(0.5);
   panelHolder.add("cube").move(0.15, -0.15, -0.01).scale(0.18, 0.18, 0.004).color(0.08, 0.08, 0.12);
   const panelRoot = panelHolder.add();

   const pageButtons = [-1, 1].map(dir => {
      const pos = [dir * BUTTON_POS[0], BUTTON_POS[1], BUTTON_POS[2]];
      const node = model.add().move(pos);
      const disk = node.add("diskZ").scale(0.035, 0.035, 0.005);
      node.add().move(-0.0064, 0.0127, 0.006).add(clay.text(dir < 0 ? "<" : ">")).color(1, 1, 1);
      return { dir, pos, disk };
   });

   const toRad = deg => deg * Math.PI / 180;

   const buildBody = (node, parts) => {
      for (const p of parts) {
         const rot = p.rot || [0, 0, 0];
         node.add(p.form)
            .move(p.pos)
            .turnX(toRad(rot[0])).turnY(toRad(rot[1])).turnZ(toRad(rot[2]))
            .scale(p.scale)
            .color(p.color[0], p.color[1], p.color[2]);
      }
   };

   // clay.text glyphs are half an inch wide, so this centers the label horizontally.
   const addLabel = (node, text, size) => {
      const inch = 0.0254;
      node.add().move(-text.length * inch / 4 * size, 0, 0).scale(size)
         .add(clay.text(text)).color(1, 1, 1);
   };

   const shelfSlot = i => {
      const col = i % SHELF_COLS;
      const row = Math.floor(i / SHELF_COLS);
      return [(col - (SHELF_COLS - 1) / 2) * SHELF_DX, SHELF_TOP_Y - row * SHELF_DY, SHELF_Z];
   };

   let shelfNodes = [];
   let page = 0;

   const pageCount = () => Math.max(1, Math.ceil(order.length / SHELF_PER_PAGE));

   const rebuildShelf = () => {
      while (shelfRoot.nChildren()) shelfRoot.remove(0);
      shelfNodes = [];
      page = clamp(page, 0, pageCount() - 1);
      const first = page * SHELF_PER_PAGE;
      const n = Math.min(order.length - first, SHELF_PER_PAGE);
      for (let i = 0; i < n; i++) {
         const name = order[first + i];
         const holder = shelfRoot.add().move(shelfSlot(i));
         const body = holder.add();
         buildBody(body, discovered[name].parts);
         addLabel(holder.add().move(0, -ITEM_SIZE * 0.8 - 0.0025, 0.051), name, 0.28);
         shelfNodes.push({ name, body, index: first + i });
      }
   };

   // An item with no name is a placeholder shown while the AI is thinking.
   const makeWorkItem = (name, pos) => {
      const root = workRoot.add();
      const body = root.add();
      const label = root.add().move(0, -ITEM_SIZE - 0.015, 0);
      const item = { name, pos: pos.slice(), root, body, label, loading: !name, phase: Math.random() * 6 };
      if (name) {
         buildBody(body, discovered[name].parts);
         addLabel(label, name, 0.3);
      } else {
         body.add("octahedron").scale(0.6);
         addLabel(label, "...", 0.3);
      }
      workspace.push(item);
      return item;
   };

   const removeWorkItem = item => {
      workRoot.remove(item.root);
      workspace = workspace.filter(w => w !== item);
   };

   const fillWorkItem = (item, name) => {
      while (item.body.nChildren()) item.body.remove(0);
      while (item.label.nChildren()) item.label.remove(0);
      item.name = name;
      item.loading = false;
      buildBody(item.body, discovered[name].parts);
      addLabel(item.label, name, 0.3);
   };

   // cg.split loops forever on long words with no spaces, so wrap text ourselves.
   const wrap = (text, width) => {
      const lines = [];
      let line = "";
      for (let word of text.split(/\s+/)) {
         while (word.length > width) {
            if (line) {
               lines.push(line);
               line = "";
            }
            lines.push(word.substring(0, width));
            word = word.substring(width);
         }
         if (line && line.length + 1 + word.length > width) {
            lines.push(line);
            line = word;
         } else {
            line = line ? line + " " + word : word;
         }
      }
      if (line)
         lines.push(line);
      return lines.join("\n");
   };

   // clay.text creates a new mesh every call, so only rebuild the panel when the text changes.
   let panelText = "";

   const refreshPanel = () => {
      let text = `AI ALCHEMY\nDiscovered: ${order.length}   Shelf page ${page + 1}/${pageCount()}\n\n`;
      if (lastRecipe)
         text += wrap(lastRecipe, PANEL_WIDTH) + "\n" + wrap(lastDescription, PANEL_WIDTH) + "\n\n";
      text += wrap(status, PANEL_WIDTH) + "\n\n";
      text += "Trigger: grab\nDrop on an item: combine\nDrop on the shelf: discard\n< > buttons: change shelf page";
      if (text === panelText)
         return;
      panelText = text;
      while (panelRoot.nChildren()) panelRoot.remove(0);
      panelRoot.add().scale(PANEL_SCALE).add(clay.text(text)).color(1, 1, 1);
   };

   const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

   const vec3 = (v, lo, hi, fallback) => {
      if (!Array.isArray(v) || v.length < 3 || !v.every(x => Number.isFinite(+x)))
         return fallback.slice();
      return [clamp(+v[0], lo, hi), clamp(+v[1], lo, hi), clamp(+v[2], lo, hi)];
   };

   // Don't trust the AI's model blindly: keep only valid shapes and clamp every number.
   const sanitizeParts = parts => {
      const out = [];
      for (const p of Array.isArray(parts) ? parts.slice(0, 10) : []) {
         if (!p || !ALLOWED_FORMS.has(p.form))
            continue;
         out.push({
            form: p.form,
            pos: vec3(p.pos, -1, 1, [0, 0, 0]),
            scale: vec3(p.scale, 0.05, 1, [0.5, 0.5, 0.5]),
            rot: vec3(p.rot, -360, 360, [0, 0, 0]),
            color: vec3(p.color, 0, 1, [0.8, 0.8, 0.8]),
         });
      }
      if (!out.length)
         out.push({ form: "sphere", pos: [0, 0, 0], scale: [0.7, 0.7, 0.7], rot: [0, 0, 0], color: [0.8, 0.5, 1] });
      return out;
   };

   const parseJson = text => {
      try {
         return JSON.parse(text);
      } catch (e) {}
      const a = text.indexOf("{");
      const b = text.lastIndexOf("}");
      if (a >= 0 && b > a) {
         try {
            return JSON.parse(text.substring(a, b + 1));
         } catch (e) {}
      }
      return null;
   };

   const titleCase = s => s.trim().replace(/\s+/g, " ").split(" ")
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
      .substring(0, 24);

   const recipeKey = (a, b) => [a.toLowerCase(), b.toLowerCase()].sort().join(" + ");

   const getRecipe = async (a, b) => {
      const key = recipeKey(a, b);
      if (recipes[key] && discovered[recipes[key]])
         return { name: recipes[key], isNew: false };

      const ask = model => aiQuery.askAI("", {
         model,
         timeout: AI_TIMEOUT,
         messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `Known items: ${order.slice(-80).join(", ")}.\nCombine: ${a} + ${b}` },
         ],
         response_format: { type: "json_object" },
      });

      // Try the fast model first; if the server rejects it, fall back to the server's default model.
      const start = Date.now();
      let content;
      try {
         content = await ask(AI_MODEL);
      } catch (err) {
         if (/timed out/i.test(err.message))
            throw err;
         console.warn(`[hw4] ${AI_MODEL} failed (${err.message}), retrying with the default model`);
         content = await ask(undefined);
      }
      console.log(`[hw4] ${a} + ${b} took ${((Date.now() - start) / 1000).toFixed(1)}s`);

      const data = parseJson(content || "");
      if (!data || typeof data.name !== "string" || !data.name.trim())
         throw new Error("AI returned no usable item");

      let name = titleCase(data.name);
      let isNew = false;

      // If the AI picked an existing item, reuse it so it keeps its original look.
      const existing = order.find(n => n.toLowerCase() === name.toLowerCase());
      if (existing) {
         name = existing;
      } else {
         discovered[name] = {
            description: String(data.description || "").substring(0, 140),
            parts: sanitizeParts(data.parts),
         };
         order.push(name);
         isNew = true;
      }

      recipes[key] = name;
      save();
      return { name, isNew };
   };

   const combine = async (itemA, itemB) => {
      const a = itemA.name;
      const b = itemB.name;
      const mid = cg.mix(itemA.pos, itemB.pos, 0.5);
      removeWorkItem(itemA);
      removeWorkItem(itemB);
      const pending = makeWorkItem(null, mid);
      status = `Combining ${a} + ${b}...`;

      try {
         const { name, isNew } = await getRecipe(a, b);
         if (!workspace.includes(pending))
            return;
         fillWorkItem(pending, name);
         lastRecipe = `${a} + ${b} = ${name}`;
         lastDescription = discovered[name].description || "";
         status = isNew ? `NEW DISCOVERY: ${name}!` : `You already know ${name}.`;
         if (isNew) {
            newFlashTime = model.time;
            page = pageCount() - 1;
            rebuildShelf();
         }
      } catch (err) {
         console.error("[hw4] combine failed:", err);
         status = `The AI fizzled (${String(err.message).substring(0, 80)}). Your items are back.`;
         if (workspace.includes(pending))
            removeWorkItem(pending);
         makeWorkItem(a, cg.add(mid, [-0.05, 0, 0]));
         makeWorkItem(b, cg.add(mid, [0.05, 0, 0]));
      }
   };

   const nearest = (list, p, r, skip) => {
      let best = null;
      let dMin = r;
      for (const it of list) {
         if (it === skip || it.loading)
            continue;
         const d = cg.distance(it.pos, p);
         if (d < dMin) {
            dMin = d;
            best = it;
         }
      }
      return best;
   };

   const isHeld = item => item === grabbed.left || item === grabbed.right;

   inputEvents.onPress = hand => {
      const p = inputEvents.pos(hand);
      if (!p)
         return;

      const button = nearest(pageButtons, p, GRAB_R);
      if (button) {
         const next = clamp(page + button.dir, 0, pageCount() - 1);
         if (next !== page) {
            page = next;
            rebuildShelf();
         }
         return;
      }

      let item = nearest(workspace, p, GRAB_R);
      if (!item) {
         const shelfItems = shelfNodes.map((s, i) => ({ name: s.name, pos: shelfSlot(i) }));
         const s = nearest(shelfItems, p, GRAB_R);
         if (s)
            item = makeWorkItem(s.name, p);
      }
      if (item && !isHeld(item))
         grabbed[hand] = item;
   };

   inputEvents.onDrag = hand => {
      const p = inputEvents.pos(hand);
      if (grabbed[hand] && p)
         grabbed[hand].pos = p.slice();
   };

   inputEvents.onRelease = hand => {
      const item = grabbed[hand];
      grabbed[hand] = null;
      if (!item || !workspace.includes(item))
         return;

      if (item.pos[2] < SHELF_Z + 0.08) {
         removeWorkItem(item);
         return;
      }
      const other = nearest(workspace, item.pos, COMBINE_R, item);
      if (other && !isHeld(other))
         combine(item, other);
   };

   window.craft = async (a, b) => {
      const find = n => order.find(x => x.toLowerCase() === String(n || "").toLowerCase());
      const A = find(a);
      const B = find(b);
      if (!A || !B) {
         console.error(`craft: both items must be discovered. Known: ${order.join(", ")}`);
         return;
      }
      const pos = [(Math.random() - 0.5) * 0.5, TABLE_POS[1] + 0.06, 0];
      await combine(makeWorkItem(A, pos), makeWorkItem(B, pos));
      return lastRecipe;
   };

   window.resetCraft = () => {
      try {
         localStorage.removeItem(STORAGE_KEY);
      } catch (e) {}
      while (workspace.length) removeWorkItem(workspace[0]);
      load();
      page = 0;
      rebuildShelf();
      lastRecipe = "";
      lastDescription = "";
      status = "Reset. Back to the four elements.";
   };

   load();
   rebuildShelf();

   model.animate(() => {
      const t = model.time;

      // The newest shelf item pulses for a few seconds after it's discovered.
      for (const s of shelfNodes) {
         const isFresh = s.index === order.length - 1 && t - newFlashTime < 3;
         const pulse = isFresh ? 1 + 0.3 * Math.sin((t - newFlashTime) * 10) : 1;
         s.body.identity().turnY(t * 0.6 + s.index).scale(ITEM_SIZE * 0.8 * pulse);
      }

      // Page buttons are dimmed when there's no page in that direction.
      for (const b of pageButtons) {
         const usable = page + b.dir >= 0 && page + b.dir < pageCount();
         b.disk.color(...(usable ? [0.2, 0.5, 0.9] : [0.25, 0.25, 0.3]));
      }

      // Highlight whatever a held item would combine with if dropped now.
      const targets = new Set();
      for (const hand of ["left", "right"]) {
         if (grabbed[hand]) {
            const other = nearest(workspace, grabbed[hand].pos, COMBINE_R, grabbed[hand]);
            if (other)
               targets.add(other);
         }
      }

      for (const it of workspace) {
         const held = isHeld(it);
         const bob = held ? 0 : 0.006 * Math.sin(t * 2 + it.phase);
         it.root.identity().move(it.pos[0], it.pos[1] + bob, it.pos[2]);

         if (it.loading) {
            it.body.identity().turnY(t * 6).turnX(t * 4).scale(ITEM_SIZE * (0.8 + 0.2 * Math.sin(t * 8)));
            it.body.child(0).color(0.5 + 0.5 * Math.sin(t * 5), 0.5 + 0.5 * Math.sin(t * 5 + 2), 1);
         } else {
            let s = ITEM_SIZE * (held ? 1.15 : 1);
            if (targets.has(it))
               s *= 1.2 + 0.1 * Math.sin(t * 12);
            it.body.identity().turnY(t * 0.8 + it.phase).scale(s);
         }
      }

      refreshPanel();
   });
};
