import * as cg from "../render/core/cg.js";
import { AIQuery } from "../util/aiquery.js";

/*
   AI Roller Coaster: the AI designs a ride as a list of track elements (lift hill, drop, loop, turn...),
   and the code turns it into a smooth 3D track, checks the physics, and lets you ride it.

   A menu floats above your left hand; press its buttons with the right trigger.
   - Idea: cycle through ride ideas.      Build: ask the AI to design that ride.
   - Fix: the AI redesigns using the problems found (keeping it true to your request), then a tuner
     adjusts the numbers to fix what's left. Problems are marked on the table model, colored by kind.
   - Ride: ride the coaster (press Ride again, or the left trigger, to stop).
   - Example: once a coaster passes the physics check, it becomes the example the AI learns from.
   - Hide: fold the menu away; the small "Menu" button above your hand brings it back.

   Console helpers
      build("a family coaster with gentle hills")
      fix() / fix("make the first drop taller")
      tune()                    fix problems with the tuner only, no AI
      ride() / stopRide()
      setModel("gpt-4.1")
      setCandidates(3)          ask for 3 designs per Build and keep the best one
      setExample() / resetExample()
      coasterLog                stats for every design
*/

const AI_MODEL = "gpt-4.1-mini";
const AI_TIMEOUT = 45000;
const DS = 0.5;                     // track is built in half-meter steps
const MAX_POINTS = 6000;            // safety limit for the AI's elements (3 km); the return to the station is always added on top
const G = 9.81;
const STATION = [0, 2, 0];
const TABLE_POS = [0, 0.75, -0.85];
const TABLE_HALF = 0.5;
const MODEL_SIZE = 0.9;
const MENU_WIDTH = 42;
const EYE_ABOVE_SEAT = 1.0;
const MAX_G = 5, MIN_G = -1, MAX_SIDE_G = 1.5;
const MIN_HEIGHT = 1.5;
const LIFT_SPEED = 6;
const RETURN_SPEED = 12;
const SLOW_SPEED = 5;
const MAX_SLOW_TIME = 6;
const CLEARANCE = 3;
const CLOUD_SQUASH = 0.7;

const IDEAS = [
   "a family coaster with gentle hills",
   "a giant hypercoaster with a 60 meter first drop",
   "a looping coaster with two loops and a corkscrew",
   "a twisty coaster full of helixes and banked turns",
   "the most intense coaster you can design",
   "a scenic coaster that circles the whole area",
];

const ELEMENT_TYPES = ["lift", "drop", "straight", "turn", "helix", "hill", "loop", "roll"];

const PROBLEM_KINDS = {
   collision: { one: "collision", many: "collisions", colorName: "red", color: [1, 0.15, 0.1] },
   force: { one: "force too strong", many: "forces too strong", colorName: "orange", color: [1, 0.6, 0.1] },
   stall: { one: "place the train stalls", many: "places the train stalls", colorName: "purple", color: [0.75, 0.35, 1] },
   slow: { one: "slow section", many: "slow sections", colorName: "purple", color: [0.75, 0.35, 1] },
   ground: { one: "part too close to the ground", many: "parts too close to the ground", colorName: "yellow", color: [1, 1, 0.2] },
};

const EXAMPLE_TRACK = {
   plan:
      "1 lift: from 2 m up to 32 m, the highest point. " +
      "2 drop 28 m down to 4 m: speed sqrt(19.6*28) = 23 m/s. " +
      "3 hill 14 m: top at 18 m, well below 32 m. " +
      "4 turn at 23 m/s: radius 18 >= 23^2/30 = 17.6; bank atan(529/(9.8*18)) = 72, use 72. " +
      "5 hill 8 m: top at 12 m. 6 straight 24 m to spread the layout. " +
      "7 loop at 23 m/s: radius 23^2/58 = 9.1, use 9; top about 4 + 2.3*9 = 25 m, below 32 m. " +
      "8 helix at 23 m/s, level: radius 18 >= 17.6, bank 72. " +
      "9 roll and 10 straight add no extra force. Turns add up to 180 + 180 = 360, so it ends near the station heading north.",
   name: "Thunder Ridge",
   description: "A classic ride with a big first drop, airtime hills, a loop and a corkscrew roll.",
   trackColor: [0.85, 0.2, 0.15],
   supportColor: [0.85, 0.85, 0.9],
   trainColor: [0.15, 0.4, 0.9],
   scenery: "forest",
   elements: [
      { type: "lift", height: 30 },
      { type: "drop", height: 28, angle: 55 },
      { type: "hill", height: 14 },
      { type: "turn", angle: 180, radius: 18, bank: 72 },
      { type: "hill", height: 8 },
      { type: "straight", length: 24 },
      { type: "loop", radius: 9 },
      { type: "helix", angle: 180, radius: 18, climb: 0, bank: 72 },
      { type: "roll", length: 20 },
      { type: "straight", length: 15 },
   ],
};

const SYSTEM_PROMPT = example =>
   "You design roller coasters for a VR theme park. A ride is a list of track elements, built in order from the station. " +
   "Element types: " +
   "lift {height} (chain lift that climbs this many meters), " +
   "drop {height, angle} (falls this many meters at this steepness in degrees, 20 to 90), " +
   "straight {length}, " +
   "turn {angle, radius, bank} (degrees, positive turns left, negative turns right; bank is how far the track leans into the turn, 0 to 90), " +
   "helix {angle, radius, climb, bank} (a long spiral turn; climb is meters up, negative goes down), " +
   "hill {height} (an airtime hill), " +
   "loop {radius} (a vertical loop), " +
   "roll {length} (a corkscrew: the track twists a full turn over this length). " +
   "Units are meters and degrees. Start with a lift. The train has no motor after the lift, so it only has the energy " +
   "from the height it has fallen: every hill, loop and climbing helix must be lower than where the train came from, " +
   "or it stalls. Keep the forces comfortable: under 5 g pushing down, above -1 g (lifting out of the seat), " +
   "and under 1.5 g sideways. Tighter loops and turns at high speed give stronger forces. " +
   "The track starts at the station heading north and must stay at least 1.5 m above the ground. " +
   "It must never run into itself: two parts closer than 3 m collide (crossing over or under with more than 3 m of height between them is fine). " +
   "Plan it as a circuit: the turn and helix angles should add up to about 360 or -360 degrees so the train ends near the station, " +
   "facing north again. Avoid turning back over earlier track. " +
   "Keep the ride compact and fast: about 400 to 800 m of track in total, straights under 40 m, turn and helix radii between 8 and 30 m, " +
   "and no slow sections; after the first drop the train should keep moving at a good speed (above 5 m/s). " +
   "Use 6 to 16 elements. Also pick trackColor, supportColor and trainColor ([r,g,b] from 0 to 1), " +
   "and a scenery theme: forest, snow, desert, autumn or tropical. " +
   "Make every ride feel different: vary the layout, the mix and order of elements, the colors and the scenery, " +
   "and don't reuse the example's sequence of elements. " +
   "Rules of thumb (v is speed in m/s, heights in meters): " +
   "the speed at any point is about sqrt(19.6 * (highest point so far - current height)); " +
   "a hill, loop or climbing helix must top out at least 3 m below the highest point so far or the train stalls; " +
   "a loop's radius should be about v^2 / 58 using the speed entering it (between v^2/63 and v^2/52), and its top is about 2.3 * radius above its bottom; " +
   "a turn or helix needs a radius of at least v^2 / 30 and a bank of about atan(v^2 / (9.8 * radius)), usually 50 to 85 degrees when fast; " +
   "a drop can be any height that fits above the ground. " +
   "Before the elements, write a short \"plan\": one brief line per element with its height, speed and the rule-of-thumb check " +
   "you used to choose its numbers. Then write the elements to match the plan. " +
   "Here is an example design (match its format and care, but design something new): " + JSON.stringify(example) +
   " Respond with JSON only: {\"plan\", \"name\", \"description\" (one short sentence), \"trackColor\", \"supportColor\", " +
   "\"trainColor\", \"scenery\", \"elements\": [...]}";

const LAYOUTS = [
   "an out-and-back: head far away from the station, turn around, and race back",
   "a figure-eight that crosses over itself, with at least 3 m of height between the crossings",
   "a compact twister with many alternating left and right turns",
   "a giant spiral: a long helix as the centerpiece",
   "a low, fast terrain ride with lots of small hills and quick direction changes",
   "a tall ride with one huge drop followed by big sweeping turns",
];

const SCENERY = {
   forest: { ground: [0.3, 0.45, 0.25], mountain: [0.35, 0.42, 0.35], tree: "cone", leaves: [[0.15, 0.45, 0.15], [0.22, 0.55, 0.2]] },
   snow: { ground: [0.9, 0.92, 0.96], mountain: [0.82, 0.85, 0.9], tree: "pine", leaves: [[0.1, 0.3, 0.2], [0.15, 0.36, 0.25]] },
   desert: { ground: [0.86, 0.72, 0.48], mountain: [0.75, 0.45, 0.3], tree: "cactus", leaves: [[0.3, 0.55, 0.25], [0.35, 0.6, 0.3]] },
   autumn: { ground: [0.5, 0.45, 0.25], mountain: [0.45, 0.4, 0.35], tree: "cone", leaves: [[0.9, 0.45, 0.1], [0.8, 0.2, 0.1], [0.95, 0.75, 0.2]] },
   tropical: { ground: [0.4, 0.62, 0.3], mountain: [0.3, 0.5, 0.3], tree: "palm", leaves: [[0.2, 0.6, 0.2], [0.25, 0.7, 0.25]] },
};

let startWorldCoords = null;

export const init = async model => {
   const aiQuery = new AIQuery();

   const saved = window.hw5CoasterState = window.hw5CoasterState || {};
   let aiModel = saved.aiModel || AI_MODEL;
   let example = saved.example || EXAMPLE_TRACK;
   let candidates = saved.candidates || 1;
   let ideaIndex = saved.ideaIndex || 0;
   let busy = false;
   let status = "Press Build, or try build(\"...\") in the console.";
   let coaster = null;
   let meshCount = 0;
   let riding = false;
   let rideS = 0;
   let miniS = 0;
   window.coasterLog = [];

   const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
   const num = (v, lo, hi, fallback) => Number.isFinite(+v) ? clamp(+v, lo, hi) : fallback;
   const rgb = (v, fallback) =>
      Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(x => Number.isFinite(+x))
         ? [0, 1, 2].map(i => clamp(+v[i], 0, 1)) : fallback.slice();
   const deg = Math.PI / 180;

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

   const rotate = (v, axis, a) => {
      const c = Math.cos(a), s = Math.sin(a);
      const k = cg.dot(axis, v), x = cg.cross(axis, v);
      return [0, 1, 2].map(i => v[i] * c + x[i] * s + axis[i] * k * (1 - c));
   };

   // `orig` holds an element's values before tuning, so the tuner can't drift too far from the AI's design.
   const sanitizeElement = e => {
      const clean = cleanElement(e);
      if (clean && e.orig && typeof e.orig === "object")
         clean.orig = e.orig;
      return clean;
   };

   const cleanElement = e => {
      if (!e || !ELEMENT_TYPES.includes(e.type))
         return null;
      switch (e.type) {
         case "lift": return { type: "lift", height: num(e.height, 3, 80, 25) };
         case "drop": return { type: "drop", height: num(e.height, 2, 70, 20), angle: num(e.angle, 20, 90, 50) };
         case "straight": return { type: "straight", length: num(e.length, 2, 60, 15) };
         case "turn": return { type: "turn", angle: num(e.angle, -540, 540, 90), radius: num(e.radius, 5, 35, 15), bank: num(e.bank, 0, 90, 45) };
         case "helix": return { type: "helix", angle: num(e.angle, -720, 720, 360), radius: num(e.radius, 6, 30, 14), climb: num(e.climb, -40, 40, -5), bank: num(e.bank, 0, 90, 50) };
         case "hill": return { type: "hill", height: num(e.height, 2, 60, 10) };
         case "loop": return { type: "loop", radius: num(e.radius, 5, 25, 10) };
         case "roll": return { type: "roll", length: num(e.length, 10, 60, 25) };
      }
   };

   const sanitizeDesign = raw => {
      const r = raw || {};
      const elements = (Array.isArray(r.elements) ? r.elements : []).slice(0, 30).map(sanitizeElement).filter(Boolean);
      if (!elements.length || elements[0].type !== "lift")
         elements.unshift({ type: "lift", height: 25 });
      return {
         plan: String(r.plan || "").substring(0, 2000),
         name: String(r.name || "Mystery Coaster").substring(0, 30),
         description: String(r.description || "").substring(0, 160),
         trackColor: rgb(r.trackColor, [0.85, 0.2, 0.15]),
         supportColor: rgb(r.supportColor, [0.85, 0.85, 0.9]),
         trainColor: rgb(r.trainColor, [0.15, 0.4, 0.9]),
         scenery: SCENERY[r.scenery] ? r.scenery : "forest",
         elements,
      };
   };

   // A "turtle" drives along from the station, turning and pitching as each element says.
   const buildTrack = design => {
      const pts = [];
      const adjustments = [];
      let p = STATION.slice(), T = [0, 0, -1], U = [0, 1, 0], bank = 0, element = -1, lift = false, brake = false;
      let peak = STATION[1];
      let cutAt = null;

      const push = () => {
         peak = Math.max(peak, p[1]);
         pts.push({ p: p.slice(), T: T.slice(), U: U.slice(), bank, element, lift, brake });
      };
      const step = () => {
         if (pts.length >= MAX_POINTS && !brake) {
            if (cutAt === null)
               cutAt = element;
            return false;
         }
         p = cg.add(p, cg.scale(T, DS));
         push();
         return true;
      };
      // Train speed at a height, from how far it has fallen since the highest point (friction is small, so it's ignored).
      const speedAt = y => Math.sqrt(Math.max(0, 2 * G * (peak - y)));
      const right = () => cg.normalize(cg.cross(T, U));
      const pitch = a => {
         const B = right();
         T = cg.normalize(rotate(T, B, a));
         U = cg.normalize(rotate(U, B, a));
      };
      const yaw = a => {
         T = cg.normalize(rotate(T, [0, 1, 0], a));
         U = cg.normalize(rotate(U, [0, 1, 0], a));
      };
      const pitchNow = () => Math.asin(clamp(T[1], -1, 1));
      const pitchTo = (target, R) => {
         const d = DS / R;
         for (let guard = 0; Math.abs(pitchNow() - target) > d && guard < 600; guard++) {
            pitch(Math.sign(target - pitchNow()) * d);
            if (!step())
               return;
         }
      };
      const straightWhile = cond => {
         for (let guard = 0; cond() && guard < 600; guard++)
            if (!step())
               return;
      };

      push();
      for (let i = 0; i < 24; i++)
         step();

      design.elements.forEach((e, index) => {
         element = index;
         switch (e.type) {
            case "lift": {
               lift = true;
               const a = 30 * deg, R = 8, top = p[1] + e.height;
               pitchTo(a, R);
               straightWhile(() => p[1] < top - R * (1 - Math.cos(a)));
               pitchTo(0, R);
               lift = false;
               break;
            }
            case "drop": {
               // The pull-out at the bottom widens for faster trains, and the angle eases if there isn't room above the ground.
               const bottom = Math.max(p[1] - e.height, MIN_HEIGHT);
               const R1 = 10, R2 = Math.max(20, speedAt(bottom) ** 2 / (G * 3.5));
               const room = p[1] - bottom;
               let a = e.angle * deg;
               if (room < (R1 + R2) * (1 - Math.cos(a)))
                  a = Math.acos(clamp(1 - room / (R1 + R2), -1, 1));
               if (bottom > p[1] - e.height + 0.5 || a < e.angle * deg - 0.01)
                  adjustments.push({
                     text: `${index + 1}. drop: made shallower so it stays above the ground`,
                     hint: `There are only about ${Math.round(p[1] - MIN_HEIGHT)} m to drop here. Make it smaller or less steep.`, element: index, kind: "ground",
                  });
               if (a < 3 * deg) {
                  for (let i = 0; i < 10 / DS; i++)
                     step();
                  break;
               }
               pitchTo(-a, R1);
               straightWhile(() => p[1] > bottom + R2 * (1 - Math.cos(a)));
               pitchTo(0, R2);
               break;
            }
            case "straight":
               for (let i = 0; i < e.length / DS; i++)
                  step();
               break;
            case "turn":
            case "helix": {
               const total = e.angle * deg;
               const n = Math.max(1, Math.round(Math.abs(total) * e.radius / DS));
               let climb = e.type === "helix" ? e.climb : 0;
               if (p[1] + climb < MIN_HEIGHT) {
                  climb = MIN_HEIGHT - p[1];
                  adjustments.push({
                     text: `${index + 1}. helix: descends less so it stays above the ground`,
                     hint: "Make its climb less negative so it stays at least 1.5 m above the ground.", element: index, kind: "ground",
                  });
               }
               // Turning and banking ease in and out together, so riders aren't thrown sideways.
               const profile = t => {
                  const r = clamp(Math.min(t, 1 - t) / 0.2, 0, 1);
                  return r * r * (3 - 2 * r);
               };
               const weights = Array.from({ length: n }, (_, i) => profile((i + 0.5) / n));
               const sum = weights.reduce((a, b) => a + b, 0) || 1;
               for (let i = 0; i < n; i++) {
                  yaw(total * weights[i] / sum);
                  bank = -Math.sign(total) * e.bank * deg * weights[i];
                  p[1] += climb / n;
                  if (!step())
                     break;
               }
               bank = 0;
               break;
            }
            case "hill": {
               // A wider crest for faster trains keeps the airtime around -0.5 g.
               // The crest sits R(1 - cos a) below the requested height, so size R for the speed there.
               const a = 30 * deg, base = p[1];
               let R = Math.max(14, speedAt(base + e.height) ** 2 / (G * 1.5));
               for (let k = 0; k < 3; k++)
                  R = Math.max(14, speedAt(base + e.height - R * (1 - Math.cos(a))) ** 2 / (G * 1.5));
               pitchTo(a, R);
               straightWhile(() => p[1] < base + e.height - 2 * R * (1 - Math.cos(a)));
               pitchTo(-a, R);
               straightWhile(() => p[1] > base + R * (1 - Math.cos(a)));
               pitchTo(0, R);
               break;
            }
            case "loop": {
               // A teardrop loop, wide at the bottom and tight at the top, like real coasters:
               // a perfectly round loop always needs at least 6 g at the bottom to make it over the top.
               // It also shifts sideways a little so the track doesn't run into itself.
               const side = right();
               const radiusAt = th => e.radius * (1.15 + 0.45 * Math.cos(th));
               const total = 2 * Math.PI;
               let turned = 0;
               for (let guard = 0; turned < total && guard < 2000; guard++) {
                  const d = Math.min(DS / radiusAt(turned), total - turned);
                  pitch(d);
                  turned += d;
                  p = cg.add(p, cg.scale(side, (CLEARANCE + 1.5) * d / total));
                  if (!step())
                     break;
               }
               break;
            }
            case "roll": {
               const n = Math.round(e.length / DS);
               for (let i = 0; i < n; i++) {
                  bank = 2 * Math.PI * (i + 1) / n;
                  if (!step())
                     break;
               }
               bank = 0;
               break;
            }
         }
      });

      if (cutAt !== null)
         console.warn(`[hw5_coaster] the track hit the size limit and was cut off at ${cutAt + 1}. ${design.elements[cutAt].type}`);

      // Brake run, then a smooth curve back into the station so the ride is a full circuit.
      element = design.elements.length;
      brake = true;
      bank = 0;
      pitchTo(0, 10);
      for (let i = 0; i < 20; i++)
         step();
      // The AI doesn't design the return, so try several routes back to the station (from behind or either
      // side, near or far, low or raised to pass over track) and use the one that collides least.
      const hermite = (A, TA, B, TB, out) => {
         const dist = cg.distance(A, B), m = dist * 0.8;
         const n = Math.max(4, Math.ceil(dist * 1.3 / DS));
         for (let i = 1; i <= n; i++) {
            const t = i / n, t2 = t * t, t3 = t2 * t;
            const h = [2 * t3 - 3 * t2 + 1, t3 - 2 * t2 + t, -2 * t3 + 3 * t2, t3 - t2];
            const d = [6 * t2 - 6 * t, 3 * t2 - 4 * t + 1, -6 * t2 + 6 * t, 3 * t2 - 2 * t];
            const pos = [0, 1, 2].map(k => h[0] * A[k] + h[1] * TA[k] * m + h[2] * B[k] + h[3] * TB[k] * m);
            pos[1] = Math.max(pos[1], MIN_HEIGHT);
            out.push({ p: pos, T: cg.normalize([0, 1, 2].map(k => d[0] * A[k] + d[1] * TA[k] * m + d[2] * B[k] + d[3] * TB[k] * m)) });
         }
      };
      const route = (side, back, rise) => {
         const W = [STATION[0] + side, STATION[1] + rise, STATION[2] + back];
         const toStation = cg.normalize(cg.subtract(STATION, W));
         const out = [];
         hermite(p, T, W, toStation, out);
         hermite(W, toStation, STATION, [0, 0, -1], out);
         return out;
      };
      const grid = new Map();
      const cellOf = q => q.map(v => Math.floor(v / CLEARANCE));
      pts.forEach((pt, i) => {
         if (i < 50 || i > pts.length - 50)
            return;
         const k = cellOf(pt.p).join(",");
         if (!grid.has(k))
            grid.set(k, []);
         grid.get(k).push(pt.p);
      });
      const hits = r => {
         let count = 0;
         r.forEach((q, i) => {
            if ((r.length - i) * DS < 25)
               return;
            const c = cellOf(q.p);
            for (let dx = -1; dx <= 1; dx++)
               for (let dy = -1; dy <= 1; dy++)
                  for (let dz = -1; dz <= 1; dz++)
                     for (const other of grid.get([c[0] + dx, c[1] + dy, c[2] + dz].join(",")) || [])
                        if (cg.distance(q.p, other) < CLEARANCE)
                           count++;
         });
         return count;
      };
      let best = null;
      for (const side of [0, -20, 20])
         for (const back of [15, 35])
            for (const rise of [0, 7]) {
               const r = route(side, back, rise);
               const score = hits(r) * 100 + r.length * DS;
               if (!best || score < best.score)
                  best = { r, score };
            }
      for (const q of best.r) {
         p = q.p;
         T = q.T;
         U = cg.normalize(cg.subtract([0, 1, 0], cg.scale(T, T[1])));
         bank = 0;
         push();
      }

      let s = 0;
      pts.forEach((pt, i) => {
         const a = pts[Math.max(0, i - 1)].p, b = pts[Math.min(pts.length - 1, i + 1)].p;
         const t = cg.normalize(cg.subtract(b, a));
         let up = cg.subtract(pt.U, cg.scale(t, cg.dot(pt.U, t)));
         up = cg.normalize(cg.norm(up) < 1e-6 ? [0, 1, 0] : up);
         pt.T = t;
         pt.U = rotate(up, t, pt.bank);
         pt.B = cg.normalize(cg.cross(t, pt.U));
         if (i > 0)
            s += cg.distance(pts[i - 1].p, pt.p);
         pt.s = s;
      });

      // Average each frame with its neighbors to smooth out the small kinks where the pitch changes.
      const smoothT = pts.map((_, i) => {
         let sum = [0, 0, 0];
         for (let k = -3; k <= 3; k++)
            sum = cg.add(sum, pts[clamp(i + k, 0, pts.length - 1)].T);
         return cg.normalize(sum);
      });
      const smoothU = pts.map((_, i) => {
         let sum = [0, 0, 0];
         for (let k = -2; k <= 2; k++)
            sum = cg.add(sum, pts[clamp(i + k, 0, pts.length - 1)].U);
         return sum;
      });
      pts.forEach((pt, i) => {
         pt.T = smoothT[i];
         const up = cg.subtract(smoothU[i], cg.scale(pt.T, cg.dot(smoothU[i], pt.T)));
         if (cg.norm(up) > 1e-6)
            pt.U = cg.normalize(up);
         pt.B = cg.normalize(cg.cross(pt.T, pt.U));
      });

      pts.adjustments = adjustments;
      return pts;
   };

   const elementName = (design, i) =>
      i < 0 ? "the station" : i >= design.elements.length ? "the return to the station" : `${i + 1}. ${design.elements[i].type}`;

   // Two parts of the track that are far apart along the ride but close together in space.
   const findCollisions = (design, pts) => {
      const grid = new Map();
      const key = p => p.map(v => Math.floor(v / CLEARANCE)).join(",");
      pts.forEach((pt, i) => {
         const k = key(pt.p);
         if (!grid.has(k))
            grid.set(k, []);
         grid.get(k).push(i);
      });
      const total = pts[pts.length - 1].s;
      const found = new Map();
      for (let i = 0; i < pts.length; i += 2) {
         const c = pts[i].p.map(v => Math.floor(v / CLEARANCE));
         for (let dx = -1; dx <= 1; dx++)
            for (let dy = -1; dy <= 1; dy++)
               for (let dz = -1; dz <= 1; dz++)
                  for (const j of grid.get([c[0] + dx, c[1] + dy, c[2] + dz].join(",")) || []) {
                     const along = Math.abs(pts[j].s - pts[i].s);
                     if (j <= i || Math.min(along, total - along) < 25 || cg.distance(pts[i].p, pts[j].p) > CLEARANCE)
                        continue;
                     const a = Math.min(pts[i].element, pts[j].element), b = Math.max(pts[i].element, pts[j].element);
                     if (!found.has(a + "," + b))
                        found.set(a + "," + b, { a, b, at: cg.mix(pts[i].p, pts[j].p, 0.5) });
                  }
      }
      return [...found.values()].map(c => ({
         a: c.a,
         b: c.b,
         message: c.a === c.b ? `${elementName(design, c.a)} runs into itself` : `${elementName(design, c.a)} and ${elementName(design, c.b)} run into each other`,
         at: c.at,
      }));
   };

   // Where each element actually ended up, so the AI can see the layout when fixing it.
   const layoutText = (design, pts) => {
      const r = v => Math.round(v);
      return design.elements.map((e, i) => {
         const own = pts.filter(pt => pt.element === i);
         if (!own.length)
            return `${i + 1}. ${e.type}: (not built)`;
         const a = own[0].p, b = own[own.length - 1].p, t = own[own.length - 1].T;
         const heading = Math.round((Math.atan2(t[0], -t[2]) * 180 / Math.PI + 360) % 360);
         return `${i + 1}. ${e.type}: from (${r(a[0])}, ${r(a[1])}, ${r(a[2])}) to (${r(b[0])}, ${r(b[1])}, ${r(b[2])}), heading ${heading} deg`;
      }).join("\n");
   };

   // Speed comes from energy (height fallen, minus friction); forces come from how sharply the track curves.
   const simulate = (design, pts) => {
      const stats = { length: pts[pts.length - 1].s, top: 0, speed: 0, time: 0, maxG: 1, minG: 1, side: 0 };
      const perElement = design.elements.map(() => ({ maxG: 1, minG: 1, side: 0, stall: false, slow: 0 }));
      let v = 4, underground = false, slowTime = 0, pastFirstDrop = false;
      pts.forEach((pt, i) => {
         const own = perElement[pt.element];
         if (own && own.v0 === undefined)
            own.v0 = v;
         if (i > 0) {
            const prev = pts[i - 1];
            const ds = pt.s - prev.s;
            if (pt.lift) {
               v = Math.max(v, LIFT_SPEED);
            } else {
               let v2 = v * v + 2 * G * (prev.p[1] - pt.p[1]) - 2 * 0.12 * ds;
               if (v2 < 0.5) {
                  if (own)
                     own.stall = true;
                  v2 = 2.25;
               }
               v = Math.sqrt(v2);
            }
            if (pt.brake)
               v = RETURN_SPEED;
            stats.time += ds / Math.max(v, 0.5);
            if (!pt.lift && !pt.brake && pt.element >= 0 && v > 10)
               pastFirstDrop = true;
            if (pastFirstDrop && !pt.lift && !pt.brake && own && v < SLOW_SPEED) {
               slowTime += ds / Math.max(v, 0.5);
               own.slow += ds / Math.max(v, 0.5);
            }
         }
         pt.v = v;
         stats.top = Math.max(stats.top, pt.p[1]);
         stats.speed = Math.max(stats.speed, v);
         if (pt.p[1] < 0.3)
            underground = true;
      });

      pts.forEach((pt, i) => {
         const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)];
         const ds = b.s - a.s;
         if (ds < 1e-3 || pt.brake)
            return;
         const curvature = cg.scale(cg.subtract(b.T, a.T), 1 / ds);
         const felt = cg.add(cg.scale(curvature, pt.v * pt.v), [0, G, 0]);
         const down = cg.dot(felt, pt.U) / G, side = Math.abs(cg.dot(felt, pt.B) / G);
         stats.maxG = Math.max(stats.maxG, down);
         stats.minG = Math.min(stats.minG, down);
         stats.side = Math.max(stats.side, side);
         const e = perElement[pt.element];
         if (e) {
            e.maxG = Math.max(e.maxG, down);
            e.minG = Math.min(e.minG, down);
            e.side = Math.max(e.side, side);
         }
      });

      // Each problem gets a hint with real numbers, so the AI has something concrete to change.
      const problems = [];
      const ms = v => `${Math.round(v)} m/s`;
      design.elements.forEach((el, i) => {
         const e = perElement[i], v = e.v0 || 0;
         const turning = el.type === "turn" || el.type === "helix";
         const add = (text, hint, kind = "force") => problems.push({ text: `${i + 1}. ${el.type}: ${text}`, hint, element: i, kind });
         if (e.stall)
            add("the train stalls (not enough speed)",
               `It's entered at ${ms(v)}, only enough to climb about ${Math.max(0, Math.round(v * v / (2 * G) - 1))} m. Make it lower, or make the lift hill taller.`,
               "stall");
         if (e.maxG > MAX_G)
            add(`${e.maxG.toFixed(1)} g pushing down (too strong)`,
               el.type === "loop" ? `It's entered at ${ms(v)}, so its radius should be about ${Math.round(v * v / 58)} m (v^2/58).`
               : turning ? `At ${ms(v)} use a radius of at least ${Math.ceil(v * v / 30)} m (v^2/30).`
               : `The train is too fast here (${ms(v)}). Make the drop before it smaller or less steep.`);
         if (e.minG < MIN_G)
            add(`${e.minG.toFixed(1)} g lifts riders out of their seats`,
               `The train goes over it at ${ms(v)}. Make it much lower, or move it later in the ride where the train is slower.`);
         if (e.side > MAX_SIDE_G) {
            const r = el.radius || 15;
            const bank = Math.round(Math.atan(v * v / (G * r)) * 180 / Math.PI);
            add(`${e.side.toFixed(1)} g sideways (too strong)`,
               `At ${ms(v)} with radius ${Math.round(r)} m, the bank should be about ${bank} degrees (atan(v^2/(9.8*radius))).`);
         }
      });
      if (underground)
         problems.push({ text: "the track goes underground", hint: "Keep every part at least 1.5 m above the ground.", element: -1, kind: "ground" });
      if (slowTime > MAX_SLOW_TIME) {
         const slowest = perElement.map((e, i) => [e.slow, i]).filter(([s]) => s > 0.5).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
         problems.push({
            text: `the train crawls under ${Math.round(SLOW_SPEED * 3.6)} km/h for ${Math.round(slowTime)} s`,
            hint: `Slowest parts: ${slowest.slice(0, 3).map(i => `${i + 1}. ${design.elements[i].type}`).join(", ")}. ` +
                  "Make hills and climbing helixes lower, shorten straights late in the ride, or add a drop before them.",
            elements: slowest,
            kind: "slow",
         });
      }
      return { stats, problems, perElement, underground, slowTime };
   };

   // Build and check a design. The cost is how bad its problems are: zero means it passes every check.
   const analyze = design => {
      const pts = buildTrack(design);
      const { stats, problems, perElement, underground, slowTime } = simulate(design, pts);
      const collisions = findCollisions(design, pts);
      const all = [
         ...collisions.map(c => ({
            text: c.message, elements: [c.a, c.b], kind: "collision", at: c.at,
            hint: "Change turn directions or angles, add a straight to spread them apart, or make one pass at least 3 m above the other.",
         })),
         ...problems,
         ...pts.adjustments,
      ];
      let cost = collisions.length * 50 + pts.adjustments.length * 5 + (underground ? 50 : 0);
      cost += 3 * Math.max(0, slowTime - MAX_SLOW_TIME);
      for (const e of perElement)
         cost += (e.stall ? 100 : 0) + 20 * (Math.max(0, e.maxG - MAX_G) + Math.max(0, MIN_G - e.minG) + Math.max(0, e.side - MAX_SIDE_G));
      return { design, pts, stats, problems: all, collisions, cost };
   };

   // The tuner keeps the AI's sequence of elements but nudges their numbers (occasionally flipping a turn,
   // or adding or removing a straight), and keeps any change that makes the problems smaller.
   // Values stay within 40% of the AI's design, and the tuner only removes straights it added itself,
   // so tuning fixes problems without simplifying the ride.
   const mutate = (design, focus) => {
      const d = JSON.parse(JSON.stringify(design));
      for (const e of d.elements)
         if (!e.orig)
            e.orig = { ...e };
      const pool = focus.length && Math.random() < 0.7 ? focus : d.elements.map((_, i) => i);
      const i = pool[Math.floor(Math.random() * pool.length)];
      if (Math.random() < 0.1 && d.elements.length < 30) {
         d.elements.splice(Math.max(1, i), 0, { type: "straight", length: 10 + 20 * Math.random(), orig: { added: true } });
         return sanitizeDesign(d);
      }
      if (Math.random() < 0.08 && d.elements[i].orig.added) {
         d.elements.splice(i, 1);
         return sanitizeDesign(d);
      }
      const e = d.elements[i], o = e.orig;
      const keys = Object.keys(e).filter(k => k !== "type" && k !== "orig");
      const k = keys[Math.floor(Math.random() * keys.length)];
      if (k === "angle" && (e.type === "turn" || e.type === "helix") && Math.random() < 0.2)
         e.angle = -e.angle;
      else if (k === "climb")
         e.climb += (Math.random() - 0.5) * 8;
      else
         e[k] *= 0.7 + 0.6 * Math.random();
      if (!o.added && typeof o[k] === "number") {
         if (k === "climb")
            e.climb = clamp(e.climb, o.climb - 8, o.climb + 8);
         else if (k === "bank")
            e.bank = clamp(e.bank, o.bank - 25, o.bank + 25);
         else if (k === "angle" && (e.type === "turn" || e.type === "helix"))
            e.angle = Math.sign(e.angle) * clamp(Math.abs(e.angle), 0.6 * Math.abs(o.angle), 1.4 * Math.abs(o.angle));
         else
            e[k] = clamp(e[k], 0.6 * o[k], 1.4 * o[k]);
      }
      return sanitizeDesign(d);
   };

   // A fix shouldn't throw away what made the ride what you asked for.
   const countTypes = d => d.elements.reduce((m, e) => (m[e.type] = (m[e.type] || 0) + 1, m), {});
   const keepsCharacter = (original, proposal) => {
      const a = countTypes(original), b = countTypes(proposal);
      return ["loop", "roll", "helix", "hill", "drop"].every(t => (b[t] || 0) >= Math.ceil((a[t] || 0) * 0.75))
         && proposal.elements.length >= original.elements.length * 0.7;
   };

   const forAI = d => JSON.stringify(d, (key, value) => key === "orig" ? undefined : value);

   // Stops early once it hasn't improved for a while, instead of always using the whole time budget.
   const tune = async (start, budgetMs = 5000, patienceMs = 1500) => {
      let best = start;
      const t0 = performance.now();
      let lastGain = t0;
      while (best.cost > 0 && performance.now() - t0 < budgetMs && performance.now() - lastGain < patienceMs) {
         const focus = best.problems.flatMap(p => p.elements || [p.element])
            .filter(i => i >= 0 && i < best.design.elements.length);
         for (let k = 0; k < 4; k++) {
            const candidate = analyze(mutate(best.design, focus));
            if (candidate.cost < best.cost - 1e-6)
               lastGain = performance.now();
            if (candidate.cost <= best.cost)
               best = candidate;
         }
         status = `Tuning... ${best.problems.length} problems left`;
         await new Promise(r => setTimeout(r, 0));
      }
      return best;
   };

   const buildMesh = (design, pts) => {
      const rods = [];
      const rod = (a, b, width, color, sides) => rods.push({ type: "rod", a, b, width, nSides: sides, rgb: color });
      const at = (pt, x, y) => cg.add(pt.p, cg.add(cg.scale(pt.B, x), cg.scale(pt.U, y)));
      const dark = design.trackColor.map(c => c * 0.6);
      for (let i = 0; i < pts.length - 1; i += 2) {
         const a = pts[i], b = pts[Math.min(i + 2, pts.length - 1)];
         rod(at(a, -0.55, 0), at(b, -0.55, 0), 0.12, design.trackColor, 4);
         rod(at(a, 0.55, 0), at(b, 0.55, 0), 0.12, design.trackColor, 4);
         rod(at(a, 0, -0.35), at(b, 0, -0.35), 0.28, dark, 5);
         if (i % 8 === 0) {
            rod(at(a, -0.55, -0.02), at(a, 0.55, -0.02), 0.08, dark, 3);
            rod(at(a, -0.55, 0), at(a, 0, -0.35), 0.06, dark, 3);
            rod(at(a, 0.55, 0), at(a, 0, -0.35), 0.06, dark, 3);
         }
         const base = at(a, 0, -0.35);
         if (i % 16 === 0 && a.U[1] > 0.5 && base[1] > 0.5)
            rod(base, [base[0], 0, base[2]], 0.3, design.supportColor, 5);
      }
      const name = "hw5coaster" + meshCount++;
      clay.defineDataMesh(name, rods);
      return name;
   };

   // Trees (kept away from the track) and mountains in the ride's theme, so you can feel the speed and the turns.
   const buildScenery = (pts, center, radius, theme) => {
      const cell = 8;
      const nearTrack = new Set();
      for (const pt of pts)
         for (let dx = -1; dx <= 1; dx++)
            for (let dz = -1; dz <= 1; dz++)
               nearTrack.add(`${Math.floor(pt.p[0] / cell) + dx},${Math.floor(pt.p[2] / cell) + dz}`);

      let seed = 12345;
      const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const rods = [];
      const rod = (a, b, width, rgb, taper = 0, nSides = 6) => rods.push({ type: "rod", a, b, width, rgb, taper, nSides });

      for (let i = 0; i < 300; i++) {
         const r = Math.sqrt(rand()) * (radius - 5), th = rand() * 2 * Math.PI;
         const x = center[0] + r * Math.cos(th), z = center[2] + r * Math.sin(th);
         if (nearTrack.has(`${Math.floor(x / cell)},${Math.floor(z / cell)}`))
            continue;
         const h = 4 + rand() * 8;
         const leaf = theme.leaves[Math.floor(rand() * theme.leaves.length)];
         const trunk = [0.4, 0.27, 0.15];
         switch (theme.tree) {
            case "cone":
               rod([x, 0, z], [x, h * 0.35, z], h * 0.08, trunk);
               rod([x, h * 0.25, z], [x, h, z], h * 0.45, leaf, 1, 7);
               break;
            case "pine":
               rod([x, 0, z], [x, h * 0.3, z], h * 0.06, trunk);
               rod([x, h * 0.2, z], [x, h * 0.85, z], h * 0.4, leaf, 1, 7);
               rod([x, h * 0.55, z], [x, h * 1.2, z], h * 0.28, leaf, 1, 7);
               break;
            case "cactus": {
               const side = rand() < 0.5 ? 1 : -1, w = h * 0.07;
               rod([x, 0, z], [x, h * 0.6, z], w, leaf);
               rod([x, h * 0.3, z], [x + side * h * 0.15, h * 0.3, z], w * 0.8, leaf);
               rod([x + side * h * 0.15, h * 0.3, z], [x + side * h * 0.15, h * 0.48, z], w * 0.8, leaf);
               break;
            }
            case "palm": {
               const top = [x + (rand() - 0.5) * 1.5, h * 1.1, z + (rand() - 0.5) * 1.5];
               rod([x, 0, z], top, h * 0.05, [0.55, 0.42, 0.28], 0.3);
               for (let k = 0; k < 6; k++) {
                  const a = k / 6 * 2 * Math.PI + rand();
                  rod(top, [top[0] + Math.cos(a) * h * 0.35, top[1] - h * 0.12, top[2] + Math.sin(a) * h * 0.35], h * 0.1, leaf, 0.8, 4);
               }
               break;
            }
         }
      }
      for (let i = 0; i < 12; i++) {
         const th = i / 12 * 2 * Math.PI + rand() * 0.3, d = radius + 30 + rand() * 40, H = 40 + rand() * 60;
         const x = center[0] + d * Math.cos(th), z = center[2] + d * Math.sin(th);
         rod([x, 0, z], [x, H, z], H * 1.8, theme.mountain.map(c => c * (0.9 + 0.2 * rand())), 1, 8);
      }
      const name = "hw5scenery" + meshCount++;
      clay.defineDataMesh(name, rods);
      return name;
   };

   // Each cloud is a row of grayish base puffs with taller white puffs on top. The mesh is drawn squashed to flatten them.
   const buildClouds = (center, radius) => {
      let seed = 777;
      const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const rods = [];
      const puff = (p, r, rgb) => rods.push({
         type: "rod", a: p, b: cg.add(p, [0.01, 0, 0]), width: 2 * r, nSides: 8, rgb, aLineCap: "round", bLineCap: "round",
      });
      for (let c = 0; c < 14; c++) {
         const th = rand() * 2 * Math.PI, d = rand() * radius * 1.3, y = (50 + rand() * 25) / CLOUD_SQUASH;
         const cx = center[0] + d * Math.cos(th), cz = center[2] + d * Math.sin(th);
         const heading = rand() * 2 * Math.PI, dir = [Math.cos(heading), 0, Math.sin(heading)];
         const len = 14 + rand() * 14;
         const puffs = 4 + Math.floor(rand() * 4);
         for (let i = 0; i < puffs; i++) {
            const t = i / (puffs - 1) - 0.5;
            const along = cg.scale(dir, t * len * 0.8);
            puff([cx + along[0], y - 1, cz + along[2]], 4 + rand() * 1.5, [0.88, 0.89, 0.93]);
            const r = 3.5 + rand() * 3.5;
            const lift = (1 - Math.abs(t) * 2) * 3;
            puff([cx + along[0] + (rand() - 0.5) * 3, y + 1.5 + lift, cz + along[2] + (rand() - 0.5) * 3], r, [0.98, 0.98, 1]);
         }
      }
      const name = "hw5clouds" + meshCount++;
      clay.defineDataMesh(name, rods);
      return name;
   };

   const ground = model.add("diskY");
   model.add("cube").move(TABLE_POS).scale(TABLE_HALF, 0.015, TABLE_HALF).color(0.35, 0.25, 0.18);
   model.add("cube").move(TABLE_POS[0], TABLE_POS[1] / 2, TABLE_POS[2]).scale(0.06, TABLE_POS[1] / 2 - 0.015, 0.06).color(0.25, 0.18, 0.12);
   const miniRoot = model.add();
   const markerRoot = miniRoot.add();

   const makeTrain = (parent, color = [0.15, 0.4, 0.9]) => {
      const train = parent.add();
      train.bodies = [];
      for (let c = 0; c < 2; c++) {
         const car = train.add().move(0, 0, c * 2.4);
         train.bodies.push(car.add("cube").move(0, 0.25, 0).scale(0.75, 0.25, 1.05).color(...color));
         car.add("cube").move(0, 0.55, 0.85).scale(0.75, 0.25, 0.08).color(0.9, 0.9, 0.95);
         car.add("cube").move(0, 0.55, -0.15).scale(0.75, 0.2, 0.08).color(0.9, 0.9, 0.95);
         car.add("tubeX").move(0, 0.6, -0.6).scale(0.8, 0.04, 0.04).color(0.2, 0.2, 0.2);
      }
      return train;
   };
   const miniTrain = makeTrain(miniRoot);
   let miniTrack = null;

   // The full-size world only exists while you ride. This framework has no way to hide things,
   // so anything left in the scene is drawn every frame even if it's scaled to nothing.
   let fullRoot = null, fullTrain = null;

   const buildFullWorld = () => {
      fullRoot = model.add();
      fullRoot.add("cube").move(STATION[0], STATION[1] / 2 - 0.2, STATION[2] - 6).scale(2.2, STATION[1] / 2 - 0.2, 6).color(0.5, 0.5, 0.55);
      fullRoot.add(coaster.meshes.track);
      fullRoot.add(coaster.meshes.scenery);
      fullRoot.add(coaster.meshes.clouds).scale(1, CLOUD_SQUASH, 1);
      fullTrain = makeTrain(fullRoot, coaster.design.trainColor);
   };

   const removeFullWorld = () => {
      if (fullRoot)
         model.remove(fullRoot);
      fullRoot = null;
      fullTrain = null;
   };

   const frameAt = s => {
      const pts = coaster.pts;
      const total = pts[pts.length - 1].s;
      s = ((s % total) + total) % total;
      let lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) {
         const mid = (lo + hi) >> 1;
         if (pts[mid].s <= s)
            lo = mid;
         else
            hi = mid;
      }
      const a = pts[lo], b = pts[hi];
      const t = (s - a.s) / Math.max(b.s - a.s, 1e-6);
      const T = cg.normalize(cg.mix(a.T, b.T, t));
      let U = cg.mix(a.U, b.U, t);
      U = cg.normalize(cg.subtract(U, cg.scale(T, cg.dot(U, T))));
      return { p: cg.mix(a.p, b.p, t), T, U, B: cg.normalize(cg.cross(T, U)), v: a.v + (b.v - a.v) * t };
   };

   const frameMatrix = f => {
      const o = cg.add(f.p, cg.scale(f.U, 0.15));
      return [f.B[0], f.B[1], f.B[2], 0, f.U[0], f.U[1], f.U[2], 0, -f.T[0], -f.T[1], -f.T[2], 0, o[0], o[1], o[2], 1];
   };

   // Mark each problem on the table model with a ball colored by its kind.
   const showMarkers = (problems, pts) => {
      while (markerRoot.nChildren()) markerRoot.remove(0);
      const middleOf = i => {
         const own = pts.filter(pt => pt.element === i);
         return own.length ? own[own.length >> 1].p : null;
      };
      for (const problem of problems.slice(0, 20)) {
         const element = problem.element !== undefined ? problem.element : problem.kind === "slow" ? problem.elements[0] : -1;
         const at = problem.at || (element >= 0 ? middleOf(element) : null);
         if (at)
            markerRoot.add("sphere").move(at).scale(2.5).color(...PROBLEM_KINDS[problem.kind].color);
      }
   };

   const showCoaster = (analysis, request, original) => {
      const { design, pts } = analysis;
      showMarkers(analysis.problems, pts);

      let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      for (const pt of pts)
         for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k], pt.p[k]);
            hi[k] = Math.max(hi[k], pt.p[k]);
         }
      const scale = MODEL_SIZE / Math.max(hi[0] - lo[0], hi[2] - lo[2], 1);
      const center = [(lo[0] + hi[0]) / 2, 0, (lo[2] + hi[2]) / 2];
      const radius = Math.hypot(hi[0] - lo[0], hi[2] - lo[2]) / 2 + 40;
      const theme = SCENERY[design.scenery] || SCENERY.forest;
      ground.identity().move(0, -0.002, 0).scale(radius + 120, 0.001, radius + 120).color(...theme.ground);
      for (const body of miniTrain.bodies)
         body.color(...design.trainColor);

      const meshes = {
         track: buildMesh(design, pts),
         scenery: buildScenery(pts, center, radius, theme),
         clouds: buildClouds(center, radius),
      };
      if (miniTrack)
         miniRoot.remove(miniTrack);
      miniTrack = miniRoot.add(meshes.track);
      coaster = { ...analysis, scale, center, meshes, request, original: original || design };
      saved.design = design;
      saved.request = request;
      saved.original = coaster.original;
      miniS = 0;
      return coaster;
   };

   // The framework reloads the scene whenever the browser window regains focus. Keep the coaster
   // and the ride in a global, so a reload doesn't kick you out of the ride or lose your coaster.
   if (saved.riding && saved.startWorldCoords)
      startWorldCoords = saved.startWorldCoords;
   else
      startWorldCoords = saved.startWorldCoords = window.worldCoords.slice();
   let rideAnchor = saved.rideAnchor || [0, 0.6, 0];

   // Apply the world move right away. The framework only applies worldCoords at the start of the next frame,
   // which left you one frame behind the train (about 35 cm at full speed).
   const setWorld = W => {
      window.worldCoords = W;
      clay.root().setMatrix(W);
      clay.inverseRootMatrix = cg.mInverse(W);
   };

   const ride = (resumeAt = 0) => {
      if (!coaster)
         return;
      // Put the seat under wherever your head is right now, so you're never inside the cart.
      if (!resumeAt) {
         try {
            const H = clay.root().inverseViewMatrix(0);
            rideAnchor = saved.rideAnchor = [H[12], H[13] - EYE_ABOVE_SEAT, H[14]];
         } catch (e) {}
      }
      if (miniTrack) {
         miniRoot.remove(miniTrack);
         miniTrack = null;
      }
      buildFullWorld();
      riding = saved.riding = true;
      rideS = resumeAt;
      status = "Riding! Press Ride or the left trigger to stop.";
   };

   const stopRide = () => {
      riding = saved.riding = false;
      removeFullWorld();
      if (!miniTrack && coaster)
         miniTrack = miniRoot.add(coaster.meshes.track);
      setWorld(startWorldCoords.slice());
      status = "Back on the ground.";
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

   const askJson = async (system, user) => {
      const ask = m => aiQuery.askAI("", {
         model: m,
         timeout: AI_TIMEOUT,
         messages: [{ role: "system", content: system }, { role: "user", content: user }],
         response_format: { type: "json_object" },
      });
      let content;
      try {
         content = await ask(aiModel);
      } catch (err) {
         if (/timed out/i.test(err.message))
            throw err;
         console.warn(`[hw5_coaster] ${aiModel} failed (${err.message}), retrying with the default model`);
         content = await ask(undefined);
      }
      const data = parseJson(content || "");
      if (!data)
         throw new Error("AI reply was not valid JSON");
      return data;
   };

   const requestDesign = async (request, userMessage) => {
      if (busy)
         return;
      if (riding)
         stopRide();
      busy = true;
      status = candidates > 1 ? `Designing ${candidates} versions of "${request}"...` : `Designing "${request}"...`;
      const start = Date.now();
      try {
         const replies = await Promise.allSettled(
            Array.from({ length: candidates }, () => askJson(SYSTEM_PROMPT(example), userMessage)));
         const options = replies.filter(r => r.status === "fulfilled").map(r => analyze(sanitizeDesign(r.value)));
         if (!options.length)
            throw replies[0].reason;
         const best = options.reduce((a, b) => (a.cost <= b.cost ? a : b));
         const d = best.design;
         const c = showCoaster(best, request);
         const seconds = +((Date.now() - start) / 1000).toFixed(1);
         window.coasterLog.push({
            request, name: d.name, seconds, model: aiModel, example: example.name, candidates: options.length,
            elements: d.elements.length, lengthM: Math.round(c.stats.length), heightM: Math.round(c.stats.top),
            topKmh: Math.round(c.stats.speed * 3.6), maxG: +c.stats.maxG.toFixed(1), minG: +c.stats.minG.toFixed(1),
            sideG: +c.stats.side.toFixed(1), problems: c.problems.length,
            problemsPerCandidate: options.map(o => o.problems.length).join(" / "),
         });
         console.table(window.coasterLog);
         console.log("[hw5_coaster] plan:", d.plan);
         console.log("[hw5_coaster] design:", d, "problems:", c.problems.map(p => p.text));
         status = c.problems.length ? `Built ${d.name}, but it has problems. Try Fix.` : `Built ${d.name}. Press Ride!`;
      } catch (err) {
         console.error("[hw5_coaster] design failed:", err);
         status = `Design failed (${String(err.message).substring(0, 60)}).`;
      }
      busy = false;
   };

   // A random layout idea each time, so the AI doesn't fall back on the same shape for every ride.
   const build = request => {
      request = String(request || IDEAS[ideaIndex]);
      const layout = LAYOUTS[Math.floor(Math.random() * LAYOUTS.length)];
      return requestDesign(request,
         `Design this roller coaster: ${request}\nFor variety, use this layout idea unless it conflicts with the request: ${layout}.`);
   };

   // The AI gets the problems (with numbers) and a map of the layout, then the tuner fixes whatever it didn't.
   const fix = async feedback => {
      if (busy)
         return;
      if (!coaster) {
         status = "Build a coaster first.";
         return;
      }
      if (riding)
         stopRide();
      busy = true;
      const start = Date.now();
      const before = coaster.problems.length;
      let current = coaster;
      status = feedback ? "Asking the AI to make your changes..." : `Asking the AI to fix ${before} problems...`;
      let rejected = false;
      try {
         const notes = feedback || current.problems.map(p => `- ${p.text}. ${p.hint}`).join("\n") || "make it more exciting";
         const d = sanitizeDesign(await askJson(SYSTEM_PROMPT(example),
            `The original request was: "${coaster.request}". Keep the ride true to it: keep its signature elements ` +
            `(drops, hills, loops, helixes, rolls) and about the same number of elements; change numbers rather than removing elements.\n` +
            `Here is your previous design: ${forAI(current.design)}\n` +
            `This is where each element ended up when it was built (x is east, z is south, y is up, in meters; ` +
            `heading 0 is north, 90 is east):\n${layoutText(current.design, current.pts)}\n` +
            `${feedback ? "Requested changes" : "Problems found when it was built and simulated"}:\n${notes}\n` +
            "Return the full corrected design."));
         const proposal = analyze(d);
         if (feedback || (proposal.cost < current.cost && keepsCharacter(coaster.original, d)))
            current = proposal;
         else if (proposal.cost < current.cost)
            rejected = true;
      } catch (err) {
         console.error("[hw5_coaster] AI fix failed:", err);
      }
      const afterAI = current.problems.length;
      status = `AI: ${before} -> ${afterAI} problems. Tuning the rest...`;
      const tuned = current.cost > 0 ? await tune(current) : current;
      showCoaster(tuned, coaster.request, coaster.original);
      if (rejected)
         console.log("[hw5_coaster] the AI's fix was rejected because it removed too much of the original ride");
      const after = tuned.problems.length;
      window.coasterLog.push({
         request: feedback ? `fix: ${feedback}` : "fix", name: tuned.design.name, seconds: +((Date.now() - start) / 1000).toFixed(1),
         problemsBefore: before, afterAI, afterTuning: after,
      });
      console.table(window.coasterLog);
      status = `Problems: ${before} at first, ${afterAI} after the AI, ${after} after tuning.` +
               (after ? " Press Fix again." : " Physics check OK!");
      busy = false;
   };

   const setExample = () => {
      if (!coaster) {
         status = "Build a coaster first.";
         return;
      }
      if (coaster.problems.length) {
         status = "Fix this coaster first: only a ride that passes the physics check can be the example.";
         return;
      }
      example = saved.example = JSON.parse(forAI(coaster.design));
      status = `The AI will now learn from ${example.name}. Press Build for new rides in its style.`;
   };

   const tuneOnly = async () => {
      if (busy || !coaster)
         return;
      if (riding)
         stopRide();
      busy = true;
      const before = coaster.problems.length;
      const tuned = await tune(coaster);
      showCoaster(tuned, coaster.request, coaster.original);
      status = `Tuning only: ${before} -> ${tuned.problems.length} problems.`;
      busy = false;
   };

   // When the menu is hidden, only a small "Menu" button stays above your hand to bring it back.
   let menuOpen = saved.menuOpen !== false;
   const menu = model.add();
   const menuBody = menu.add();
   menuBody.add("cube").move(0, 0.16, -0.006).scale(0.17, 0.15, 0.003).color(0.08, 0.08, 0.12);
   const menuText = menuBody.add().move(-0.155, 0.3, 0);
   const tab = menu.add();
   const TAB_POS = [0, 0.04, 0];

   const addLabel = (node, text, size) => {
      node.add().move(-text.length * 0.0254 / 4 * size, 0, 0).scale(size).add(clay.text(text)).color(1, 1, 1);
   };

   const buttons = [
      { label: "Idea", action: () => { ideaIndex = saved.ideaIndex = (ideaIndex + 1) % IDEAS.length; status = `Next idea: ${IDEAS[ideaIndex]}`; } },
      { label: "Build", action: () => build(IDEAS[ideaIndex]) },
      { label: "Fix", action: () => fix() },
      { label: "Ride", action: () => riding ? stopRide() : ride() },
      { label: "Example", action: setExample },
      { label: "Hide", action: () => menuOpen = saved.menuOpen = false },
   ].map((b, i, all) => {
      const pos = [(i - (all.length - 1) / 2) * 0.055, 0.04, 0];
      const node = menuBody.add().move(pos);
      const disk = node.add("diskZ").scale(0.018, 0.018, 0.003);
      addLabel(node.add().move(0, 0.035, 0), b.label, 0.28);
      return { ...b, pos, disk };
   });

   const tabFace = tab.add().move(TAB_POS);
   tabFace.add("diskZ").scale(0.016, 0.016, 0.003).color(0.9, 0.4, 0.2);
   addLabel(tabFace.add().move(0, 0.035, 0), "Menu", 0.28);

   inputEvents.onPress = hand => {
      if (riding && hand === "left") {
         stopRide();
         return;
      }
      const left = inputEvents.pos("left"), right = inputEvents.pos("right");
      if (hand !== "right" || !left || !right)
         return;
      // Place the menu from the left hand measured at the same moment as the right hand,
      // so the buttons line up even while the world is moving during a ride.
      const M = menu.getMatrix().slice();
      M[12] = left[0];
      M[13] = left[1] + 0.05;
      M[14] = left[2];
      if (!menuOpen) {
         if (cg.distance(cg.mTransform(M, TAB_POS), right) < 0.03)
            menuOpen = saved.menuOpen = true;
         return;
      }
      const button = buttons.find(b => cg.distance(cg.mTransform(M, b.pos), right) < 0.025);
      if (button)
         button.action();
   };
   inputEvents.onDrag = () => {};
   inputEvents.onRelease = () => {};

   window.build = build;
   window.fix = fix;
   window.tune = tuneOnly;
   window.ride = ride;
   window.stopRide = stopRide;
   window.setModel = m => { aiModel = saved.aiModel = String(m); status = `Model: ${aiModel}`; };
   window.setExample = setExample;
   window.resetExample = () => { example = EXAMPLE_TRACK; saved.example = null; status = "Back to the built-in Thunder Ridge example."; };
   window.setCandidates = n => { candidates = saved.candidates = clamp(Math.round(n) || 1, 1, 5); status = `Each Build now asks for ${candidates} version(s).`; };

   let menuString = "";

   const refreshMenu = () => {
      let text = wrap(`Next idea: ${IDEAS[ideaIndex]}`, MENU_WIDTH) + "\n";
      if (example !== EXAMPLE_TRACK)
         text += wrap(`Learning from: ${example.name}`, MENU_WIDTH) + "\n";
      text += "\n";
      if (coaster) {
         const s = coaster.stats;
         text += wrap(`${coaster.design.name}: ${Math.round(s.length)} m, ${Math.round(s.speed * 3.6)} km/h`, MENU_WIDTH) + "\n";
         const n = coaster.problems.length;
         if (n) {
            text += `${n} problem${n > 1 ? "s" : ""}, marked on the model:\n`;
            const counts = {};
            for (const p of coaster.problems)
               counts[p.kind] = (counts[p.kind] || 0) + 1;
            for (const [kind, count] of Object.entries(counts)) {
               const k = PROBLEM_KINDS[kind];
               text += wrap(`- ${count} ${count > 1 ? k.many : k.one} (${k.colorName})`, MENU_WIDTH) + "\n";
            }
         } else {
            text += "Physics check: OK\n";
         }
         text += "\n";
      }
      text += wrap(status, MENU_WIDTH);
      if (text === menuString)
         return;
      menuString = text;
      while (menuText.nChildren()) menuText.remove(0);
      menuText.add().scale(0.4).add(clay.text(text)).color(1, 1, 1);
   };

   try {
      if (saved.design)
         showCoaster(analyze(sanitizeDesign(saved.design)), saved.request, saved.original);
      else
         showCoaster(analyze(sanitizeDesign(EXAMPLE_TRACK)), "the built-in example ride");
   } catch (err) {
      console.error("[hw5_coaster] couldn't build the coaster:", err);
   }
   if (saved.riding && coaster)
      ride(saved.rideS || 0.01);

   let lastTime = model.time;

   model.animate(() => {
      const dt = Math.min(0.1, model.time - lastTime);
      lastTime = model.time;

      if (coaster) {
         const m = frameAt(miniS);
         miniS += Math.max(m.v, 1) * dt;
         miniRoot.identity().move(TABLE_POS[0], TABLE_POS[1] + 0.02, TABLE_POS[2])
            .scale(coaster.scale).move(-coaster.center[0], 0, -coaster.center[2]);
         miniTrain.setMatrix(frameMatrix(m));

         if (riding && fullRoot) {
            const toCenter = cg.mTranslate(-coaster.center[0], 0, -coaster.center[2]);
            fullRoot.setMatrix(toCenter);
            const f = frameAt(rideS);
            rideS = saved.rideS = rideS + Math.max(f.v, 1) * dt;
            const seat = frameMatrix(f);
            fullTrain.setMatrix(seat);
            const eye = cg.mMultiply(toCenter, cg.mMultiply(seat, cg.mTranslate(0, 0, 0.3)));
            setWorld(cg.mMultiply(cg.mTranslate(rideAnchor), cg.mInverse(eye)));
            if (rideS >= coaster.pts[coaster.pts.length - 1].s)
               stopRide();
         }
      }

      const hand = inputEvents.pos("left");
      if (hand) {
         menu.identity().move(hand[0], hand[1] + 0.05, hand[2]);
         try {
            menu.faceViewer();
         } catch (e) {}
      }
      menuBody.identity().scale(menuOpen ? 1 : 0);
      tab.identity().scale(menuOpen ? 0 : 1);
      for (const b of buttons)
         b.disk.color(...(busy && b.label !== "Ride" && b.label !== "Hide" ? [0.3, 0.3, 0.35] : [0.9, 0.4, 0.2]));
      refreshMenu();
   });
};

export const deinit = () => {
   if (startWorldCoords)
      window.worldCoords = startWorldCoords;
   if (window.hw5CoasterState)
      window.hw5CoasterState.riding = false;
};
