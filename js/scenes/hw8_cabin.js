import * as cg from "../render/core/cg.js";
import { G2 } from "../util/g2.js";
import { buttonState, controllerMatrix, joyStickState } from "../render/core/controllerInput.js";
import { lcb, rcb } from "../handle_scenes.js";

const SCALE = 12;
const MY_HEIGHT = (5 * 12 + 4) * 0.0254;   // 5'4"
const EYE_HEIGHT = MY_HEIGHT - 0.115;
const FT = 0.0254;                 // one mini foot
const TABLE = { x: 0, y: 0.76, z: -0.42, w: 1.524, d: 0.6096 };  // 60" x 24"
const W = 16, D = 12, H = 8;       // cabin size in feet
const WALL = 0.5;
const DOOR_W = 3, DOOR_H = 7;
const FLOOR = 0.2;
const WALK_SPEED = 5 * FT;
const GIANT_SPEED = 1.5;
const TURN_SPEED = 1.8;
const BODY_R = 0.8;
const BALL_SIZE = 0.02;

// Firewood and matches
const LOG_LEN = 1.5 * FT, LOG_R = 0.25 * FT;
const MATCH = [0.6 * FT, 0.2 * FT, 0.4 * FT];
const LOGS_NEEDED = 3;
const BURN_TIME = 20;     // seconds per log
const DRY_TIME = 6;
const WET_CHANCE = 0.4;
const NIGHT = 150;        // seconds until morning

// Places in the room where things can be found
const STOOL = [-0.95, 0.45, -0.75];
const CABINET = [1.3, 0.9, -1.1];
const SPOTS = [
   STOOL,
   [1.05, 0, -0.2],
   [-0.6, 0, 0.35],
   [0.35, 0, 0.45],
   [CABINET[0] - 0.12, CABINET[1], CABINET[2]],
   [CABINET[0] + 0.12, CABINET[1], CABINET[2] + 0.05],
   [1.6, 0, 0.6],
   [-1.5, 0, -0.1],
   [-0.2, 0, 0.9],
];

// Windows: which wall, where along it, and how high.
const WINDOWS = [
   { wall: "left", u: [-1.5, 1.5], y: [3, 6] },
   { wall: "right", u: [-2.5, 0.5], y: [3, 6] },
   { wall: "back", u: [-2.5, 0.5], y: [3, 6] },
   { wall: "front", u: [3, 6], y: [3, 6] },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, n) => Math.round(v * n) / n;
const posOf = m => m.slice(12, 15);
const yawOf = m => Math.atan2(m[8], m[10]);

const cabinMatrix = (pos, yaw) => cg.mMultiply(cg.mTranslate(pos), cg.mMultiply(cg.mRotateY(yaw), cg.mScale(FT, FT, FT)));

// Each wall: where it is and which way is inside.
const WALLS = {
   left: { at: u => [-W / 2, 0, u], inward: [1, 0, 0], length: D, alongX: false },
   right: { at: u => [W / 2, 0, u], inward: [-1, 0, 0], length: D, alongX: false },
   back: { at: u => [u, 0, -D / 2], inward: [0, 0, 1], length: W, alongX: true },
   front: { at: u => [u, 0, D / 2], inward: [0, 0, -1], length: W, alongX: true },
};
const onWall = (wall, u, y, n = 0) => cg.add(cg.add(WALLS[wall].at(u), [0, y, 0]), cg.scale(WALLS[wall].inward, n));

const halfHeight = it => it.kind === "log" ? LOG_R : MATCH[1] / 2;

const item = (kind, spot, wet) => {
   const it = { kind, yaw: spot[0] * 5, holder: null, inFire: false, wet, dry: 0 };
   it.pos = [spot[0], spot[1] + halfHeight(it), spot[2]];
   return it;
};

const freshGame = () => ({
   items: [
      item("log", SPOTS[0], false),
      item("log", SPOTS[1], false),
      item("log", SPOTS[2], true),
      item("log", SPOTS[3], false),
      item("log", SPOTS[4], false),
      item("matches", SPOTS[5], false),
   ],
   fuel: 0, lit: false, started: false, over: null,
   time: 0, night: 0, heat: 0.7, burn: 0, gust: 20, gustAt: -99, blownAt: -99,
   burned: 0, gusts: 0, outs: 0,
});

// Wind sound: looping noise through a filter, louder during gusts
let audio = null, wind = null;

const startAudio = () => {
   if (audio) {
      if (audio.state === "suspended")
         audio.resume();
      return;
   }
   try {
      audio = new AudioContext();
      const noise = audio.createBuffer(1, audio.sampleRate * 3, audio.sampleRate);
      const data = noise.getChannelData(0);
      let last = 0;
      for (let i = 0; i < data.length; i++) {
         last = (last + 0.02 * (2 * Math.random() - 1)) / 1.02;
         data[i] = 3.5 * last;
      }
      const source = audio.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      const filter = audio.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 400;
      const gain = audio.createGain();
      gain.gain.value = 0;
      source.connect(filter).connect(gain).connect(audio.destination);
      source.start();
      wind = { gain: gain.gain, freq: filter.frequency };
   } catch (e) {
      audio = null;
   }
};

const setWind = (volume, freq, seconds) => {
   if (!wind)
      return;
   const t = audio.currentTime;
   wind.gain.cancelScheduledValues(t);
   wind.freq.cancelScheduledValues(t);
   wind.gain.setTargetAtTime(volume, t, seconds / 3);
   wind.freq.setTargetAtTime(freq, t, seconds / 3);
};

const gustSound = () => {
   if (!wind)
      return;
   const t = audio.currentTime;
   wind.gain.cancelScheduledValues(t);
   wind.freq.cancelScheduledValues(t);
   wind.gain.setValueAtTime(wind.gain.value, t);
   wind.freq.setValueAtTime(wind.freq.value, t);
   wind.gain.linearRampToValueAtTime(0.7, t + 0.6);
   wind.freq.linearRampToValueAtTime(1100, t + 0.6);
   wind.gain.linearRampToValueAtTime(0.12, t + 4);
   wind.freq.linearRampToValueAtTime(400, t + 4);
};

export const init = async model => {
   if (!window.hw8Home)
      window.hw8Home = window.worldCoords.slice();
   const home = window.hw8Home;

   // Shared state
   server.init("hw8Msgs", {});
   if (!window.hw8State || !window.hw8State.items)
      window.hw8State = { cabinPos: [TABLE.x + 0.25, TABLE.y, TABLE.z], cabinYaw: 0, open: {}, swapped: false, ...freshGame() };
   const G = () => window.hw8State;
   const send = msg => server.send("hw8Msgs", msg);

   // Each player's body, for drawing their avatar
   if (!window.hw8Bodies)
      window.hw8Bodies = {};

   // This player's own state
   if (!window.hw8Local)
      window.hw8Local = { avatar: [TABLE.x - 0.3, TABLE.y, TABLE.z + 0.05], yaw: 0, heightFix: null, soloMini: false };
   const L = window.hw8Local;
   if (!L.giant) {
      L.giant = [0, 0, 0];
      L.giantYaw = 0;
   }

   // Roles. Playing alone, B switches between them.
   const players = () => window.clients || [];
   const role = () => {
      const i = window.clientID === undefined ? -1 : players().indexOf(clientID);
      if (players().length < 2 || i < 0)
         return L.soloMini ? "mini" : "giant";
      if (i > 1)
         return "giant";
      return (i === 1) !== G().swapped ? "mini" : "giant";
   };
   const isMini = () => role() === "mini";

   const setWorld = W => {
      window.worldCoords = W;
      clay.root().setMatrix(W);
      clay.inverseRootMatrix = cg.mInverse(W);
   };

   // Makes your eyes count as being at EYE_HEIGHT.
   const measureHeight = () => {
      try {
         const eye = cg.mMultiply(cg.mInverse(home), clay.root().inverseViewMatrix(0))[13];
         if (eye > 0.5)
            L.heightFix = EYE_HEIGHT - eye;
      } catch (e) {}
   };
   const lift = () => cg.mTranslate(0, L.heightFix || 0, 0);

   // From full size to mini size
   const miniBody = () => cg.mMultiply(cg.mTranslate(L.avatar), cg.mMultiply(cg.mRotateY(L.yaw), cg.mScale(1 / SCALE, 1 / SCALE, 1 / SCALE)));
   const toMini = () => cg.mMultiply(miniBody(), cg.mMultiply(lift(), cg.mInverse(home)));

   // The world in the mini view
   const miniWorld = () => cg.mInverse(toMini());

   // Where the giant has walked to
   const toGiant = () => cg.mMultiply(cg.mTranslate(L.giant), cg.mMultiply(cg.mRotateY(L.giantYaw), cg.mMultiply(lift(), cg.mInverse(home))));
   const giantWorld = () => cg.mInverse(toGiant());

   const box = (parent, x, y, z, w, h, d, color) => parent.add("cube").move(x, y, z).scale(w / 2, h / 2, d / 2).color(...color);

   // Room and table

   model.add("cube").move(0, -0.01, -1).scale(4, 0.01, 4).color(0.35, 0.33, 0.3);
   for (const [x, z, w, d] of [[0, -5, 4, 0.05], [0, 3, 4, 0.05], [-4, -1, 0.05, 4], [4, -1, 0.05, 4]])
      model.add("cube").move(x, 1.5, z).scale(w, 1.5, d).color(0.75, 0.75, 0.72);
   model.add("cube").move(0, 1.6, -4.94).scale(1.6, 0.6, 0.01).color(0.95, 0.95, 0.95);     // whiteboard
   const roomWindow = model.add("cube").move(-3.94, 1.7, -1.5).scale(0.01, 0.7, 1);
   model.add("cube").move(3.94, 1.05, 0.5).scale(0.01, 1.05, 0.5).color(0.45, 0.3, 0.2);    // door

   box(model, TABLE.x, TABLE.y - 0.015, TABLE.z, TABLE.w, 0.03, TABLE.d, [0.55, 0.38, 0.22]);
   for (const sx of [-1, 1])
      for (const sz of [-1, 1])
         box(model, TABLE.x + sx * (TABLE.w / 2 - 0.05), (TABLE.y - 0.03) / 2, TABLE.z + sz * (TABLE.d / 2 - 0.05), 0.04, TABLE.y - 0.03, 0.04, [0.3, 0.3, 0.32]);

   // Cabin, in feet

   const cabin = model.add();

   // Colored parts, so they can glow or brighten
   const paint = [];
   const reg = (node, color, inside = false) => {
      paint.push({ node, color, inside });
      return node;
   };
   const part = (parent, x, y, z, w, h, d, color, inside = false) => reg(box(parent, x, y, z, w, h, d, color), color, inside);

   const LOG = [0.5, 0.33, 0.2], LOG_DARK = [0.36, 0.23, 0.13], STONE = [0.52, 0.52, 0.54];
   const TRIM = [0.9, 0.88, 0.8], WOOD = [0.45, 0.3, 0.18], CLOTH = [0.75, 0.2, 0.2];

   // Floor
   part(cabin, 0, (FLOOR + 0.02) / 2, 0, W, FLOOR - 0.02, D, [0.6, 0.45, 0.3], true);

   // Walls, with holes for the door and windows
   const wallPiece = (wall, u0, u1, y0, y1) => {
      if (u1 - u0 < 0.01 || y1 - y0 < 0.01)
         return;
      const c = onWall(wall, (u0 + u1) / 2, (y0 + y1) / 2);
      const [w, d] = WALLS[wall].alongX ? [u1 - u0, WALL] : [WALL, u1 - u0];
      part(cabin, c[0], c[1], c[2], w, y1 - y0, d, LOG);
      for (let y = 1; y < H; y++)
         if (y > y0 + 0.15 && y < y1 - 0.15) {
            const [lw, ld] = WALLS[wall].alongX ? [u1 - u0, WALL + 0.12] : [WALL + 0.12, u1 - u0];
            part(cabin, c[0], y, c[2], lw, 0.1, ld, LOG_DARK);
         }
   };
   for (const wall in WALLS) {
      const L = WALLS[wall].length;
      const holes = WINDOWS.filter(w => w.wall === wall).map(w => ({ u: w.u, y: w.y }));
      if (wall === "front")
         holes.push({ u: [-DOOR_W / 2, DOOR_W / 2], y: [0, DOOR_H] });
      holes.sort((a, b) => a.u[0] - b.u[0]);
      let u = -L / 2;
      for (const hole of holes) {
         wallPiece(wall, u, hole.u[0], 0, H);
         wallPiece(wall, hole.u[0], hole.u[1], 0, hole.y[0]);
         wallPiece(wall, hole.u[0], hole.u[1], hole.y[1], H);
         u = hole.u[1];
      }
      wallPiece(wall, u, L / 2, 0, H);
   }

   // Corner posts
   for (const sx of [-1, 1])
      for (const sz of [-1, 1])
         reg(cabin.add("tubeY").move(sx * W / 2, (H + 0.1) / 2, sz * D / 2).scale(0.45, (H + 0.1) / 2, 0.45), LOG_DARK);

   // Windows
   const glassSpots = [];
   const curtains = WINDOWS.map(win => {
      const { wall, u, y } = win;
      const cu = (u[0] + u[1]) / 2, cy = (y[0] + y[1]) / 2, wu = u[1] - u[0], hy = y[1] - y[0];
      const size = (along, tall, thick) => WALLS[wall].alongX ? [along, tall, thick] : [thick, tall, along];
      const put = (uu, yy, n, along, tall, thick, color, inside) => {
         const c = onWall(wall, uu, yy, n);
         return part(cabin, c[0], c[1], c[2], ...size(along, tall, thick), color, inside);
      };
      glassSpots.push({ at: onWall(wall, cu, cy), size: size(wu / 2, hy / 2, 0.02) });

      // Trim
      for (const side of [-1, 1]) {
         const n = side * (WALL / 2 + 0.05);
         put(cu, y[1] + 0.12, n, wu + 0.5, 0.25, 0.08, TRIM);
         put(u[0] - 0.12, cy, n, 0.25, hy, 0.08, TRIM);
         put(u[1] + 0.12, cy, n, 0.25, hy, 0.08, TRIM);
         if (side > 0)
            put(cu, y[0] - 0.12, n, wu + 0.5, 0.25, 0.08, TRIM);
      }
      // Crossbars and sill
      put(cu, cy, 0, 0.12, hy, 0.1, TRIM);
      put(cu, cy, 0, wu, 0.12, 0.1, TRIM);
      put(cu, y[0] - 0.04, -(WALL / 2 + 0.15), wu + 0.6, 0.2, 0.3, TRIM);

      // Flower box
      put(cu, y[0] - 0.6, -(WALL / 2 + 0.55), wu, 0.6, 0.7, [0.45, 0.28, 0.15]);
      [-0.3, 0, 0.3].forEach((t, i) => {
         const f = onWall(wall, cu + t * wu, y[0] - 0.3, -(WALL / 2 + 0.6));
         reg(cabin.add("sphere").move(...f).scale(0.25), [[1, 0.3, 0.4], [1, 0.85, 0.2], [0.85, 0.4, 1]][i]);
      });

      // Curtains
      const n = WALL / 2 + 0.25;
      put(cu, y[1] + 0.45, n, wu + 1, 0.12, 0.12, [0.3, 0.2, 0.12], true);
      const panels = [-1, 1].map(() => put(cu, cy, n, 1, hy + 0.6, 0.08, CLOTH, true));
      return { win, panels };
   });

   // Porch
   part(cabin, 0, (FLOOR + 0.02) / 2, D / 2 + 2, 8, FLOOR - 0.02, 4, [0.55, 0.4, 0.25]);
   for (let i = 0; i < 4; i++)
      part(cabin, 0, FLOOR + 0.01, D / 2 + 0.5 + i, 8, 0.02, 0.06, [0.35, 0.25, 0.15]);
   for (const sx of [-1, 1])
      reg(cabin.add("tubeY").move(sx * 3.6, FLOOR + 3.3, D / 2 + 3.6).scale(0.25, 3.3, 0.25), LOG_DARK);
   reg(cabin.add("cube").move(0, 7.2, D / 2 + 2.1).turnX(0.15).scale(4.4, 0.12, 2.2), [0.3, 0.18, 0.12]);
   const lantern = reg(cabin.add("cube").move(DOOR_W / 2 + 0.7, 5.5, D / 2 + WALL / 2 + 0.3).scale(0.25, 0.35, 0.25), [0.5, 0.45, 0.3]);

   // Fireplace and chimney
   const FZ = -D / 2 + 1.3;
   const SOOT = [0.08, 0.06, 0.05];
   const CHIMNEY = [5, -D / 2 + 1.1];
   for (const x of [3.4, 6.6])
      part(cabin, x, FLOOR + 1.75, FZ, 0.8, 3.5, 2, STONE);
   part(cabin, 5, FLOOR + 2.85, FZ, 2.4, 1.3, 2, STONE);
   part(cabin, 5, FLOOR + 1.1, FZ - 0.75, 2.4, 2.2, 0.5, STONE);
   const opening = part(cabin, 5, FLOOR + 1.1, FZ - 0.49, 2.38, 2.18, 0.02, SOOT);
   for (const x of [3.81, 6.19])
      part(cabin, x, FLOOR + 1.1, FZ + 0.25, 0.02, 2.18, 1.48, SOOT);
   part(cabin, 5, FLOOR + 2.19, FZ + 0.25, 2.38, 0.02, 1.48, SOOT);
   part(cabin, 5, FLOOR + 0.02, FZ + 0.25, 2.38, 0.04, 1.48, [0.15, 0.13, 0.12]);
   // Firewood in the fireplace
   const FIRE_LOGS = [[0.2, 0.25, 0.2], [0.32, 0.25, -0.25], [0.44, 0.15, 0.05]];
   const fireLogs = FIRE_LOGS.map(() => reg(cabin.add("tubeZ"), [0.35, 0.22, 0.12]));
   part(cabin, 5, FLOOR + 0.07, FZ + 1.5, 5, 0.14, 1, [0.6, 0.58, 0.56]);
   part(cabin, 5, FLOOR + 3.65, FZ + 0.1, 4.6, 0.3, 2.4, [0.4, 0.27, 0.16]);
   part(cabin, CHIMNEY[0], 9, CHIMNEY[1], 1.6, 10, 1.6, STONE);
   part(cabin, CHIMNEY[0], 14.1, CHIMNEY[1], 2, 0.3, 2, [0.42, 0.42, 0.44]);
   const smoke = [0, 1, 2, 3].map(() => cabin.add("sphere"));
   const FLAMES = [[0, 0.7, 0.5], [-0.4, 0.5, 0.4], [0.4, 0.55, 0.4]];
   const flames = FLAMES.map(() => cabin.add("sphere"));
   const fireSpot = [5, FLOOR + 0.9, FZ + 0.2];
   const hearthSpot = [5, FLOOR, FZ + 2.3];

   // Bed
   part(cabin, -6, 0.8, -2.5, 3.5, 1.2, 6.5, WOOD, true);
   part(cabin, -6, 1.5, -1.8, 3.3, 0.3, 5, [0.25, 0.4, 0.65], true);
   part(cabin, -6, 1.6, -5, 2.6, 0.4, 1.1, [0.9, 0.9, 0.88], true);
   part(cabin, -6, 2.1, -5.6, 3.5, 2.6, 0.3, WOOD, true);

   // Nightstand and lamp
   const NX = -3.4;
   part(cabin, NX, 2.1, -4.9, 1.6, 0.2, 1.4, WOOD, true);
   part(cabin, NX, 1.1, -4.9, 1.2, 1.8, 1, WOOD, true);
   part(cabin, NX, 2.35, -4.9, 0.5, 0.3, 0.5, [0.2, 0.2, 0.2]);
   part(cabin, NX, 2.95, -4.9, 0.12, 0.9, 0.12, [0.2, 0.2, 0.2]);
   const shade = part(cabin, NX, 3.65, -4.9, 1.1, 0.7, 1.1, [0.9, 0.85, 0.7]);
   const bulb = cabin.add("sphere").move(NX, 3.4, -4.9).scale(0.25);
   const lampSpot = [NX, 3.4, -4.9];

   // Rug, table and chair
   const TX = -0.5;
   part(cabin, 0.5, FLOOR + 0.02, 1, 6, 0.04, 4, [0.6, 0.15, 0.12], true);
   part(cabin, TX, 2.4, -2.5, 3.5, 0.2, 2.2, WOOD, true);
   for (const sx of [-1, 1])
      for (const sz of [-1, 1])
         part(cabin, TX + sx * 1.5, 1.25, -2.5 + sz * 0.8, 0.25, 2.1, 0.25, WOOD, true);
   part(cabin, TX, 1.4, -0.7, 1.4, 0.2, 1.4, [0.4, 0.27, 0.16], true);
   part(cabin, TX, 2.4, -0.05, 1.4, 1.8, 0.2, [0.4, 0.27, 0.16], true);
   for (const sx of [-1, 1])
      for (const sz of [-1, 1])
         part(cabin, TX + sx * 0.55, 0.75, -0.7 + sz * 0.55, 0.15, 1.1, 0.15, [0.4, 0.27, 0.16], true);

   // Book
   const book = cabin.add();
   book.identity().move(TX, 2.5, -2.5);
   const bookParts = [
      part(book, -0.35, 0.05, 0, 0.7, 0.1, 1, [0.6, 0.1, 0.1], true),
      part(book, -0.35, 0.12, 0, 0.62, 0.05, 0.9, [0.98, 0.96, 0.9], true),
   ];
   const bookPage = book.add();
   bookParts.push(part(bookPage, 0.35, 0.05, 0, 0.7, 0.1, 1, [0.6, 0.1, 0.1], true));
   bookParts.push(part(bookPage, 0.35, 0.12, 0, 0.62, 0.05, 0.9, [0.98, 0.96, 0.9], true));
   for (let i = 0; i < 4; i++)
      part(bookPage, 0.35, 0.15, -0.3 + i * 0.2, 0.45, 0.01, 0.04, [0.2, 0.2, 0.2], true);

   // Record player and its cabinet
   const RX = -6.85, RZ = 2.4;
   const player = cabin.add();
   player.identity().move(RX, 0, RZ).turnY(Math.PI / 2);
   const TOP = FLOOR + 2.2;
   const recordParts = [];
   const rp = (parent, x, y, z, w, h, d, color) => {
      const n = part(parent, x, y, z, w, h, d, color, true);
      recordParts.push(n);
      return n;
   };
   rp(player, 0, TOP - 0.05, 0, 2.2, 0.1, 1.6, WOOD);
   part(player, 0, FLOOR + 0.05, 0, 2.2, 0.1, 1.6, WOOD, true);
   for (const sx of [-1, 1])
      part(player, sx * 1.05, FLOOR + 1.1, 0, 0.1, 2, 1.6, WOOD, true);
   part(player, 0, FLOOR + 1.1, -0.75, 2.2, 2, 0.1, WOOD, true);
   part(player, 0, FLOOR + 1.1, 0.025, 2.1, 0.08, 1.55, WOOD, true);

   // Records
   const SLEEVES = [[0.8, 0.2, 0.2], [0.2, 0.4, 0.8], [0.9, 0.75, 0.2], [0.25, 0.6, 0.3], [0.6, 0.3, 0.7], [0.95, 0.5, 0.2]];
   SLEEVES.forEach((color, i) => {
      part(player, -0.8 + i * 0.3, FLOOR + 0.55, -0.15, 0.06, 0.8, 0.9, color, true);
      if (i < 3)
         part(player, -0.5 + i * 0.2, FLOOR + 1.55, -0.15, 0.06, 0.8, 0.85, SLEEVES[5 - i], true);
   });

   // Turntable
   rp(player, 0, TOP + 0.125, 0, 1.5, 0.25, 1.3, [0.2, 0.14, 0.1]);
   part(player, -0.15, TOP + 0.27, 0, 1.1, 0.04, 1.1, [0.55, 0.55, 0.58], true);
   const record = player.add();
   reg(record.add("tubeY").move(0, 0, 0).scale(0.5, 0.012, 0.5), [0.06, 0.06, 0.07], true);
   reg(record.add("tubeY").move(0, 0.01, 0).scale(0.17, 0.012, 0.17), [0.8, 0.15, 0.15], true);
   reg(record.add("cube").move(0.1, 0.022, 0).scale(0.06, 0.004, 0.015), [0.95, 0.9, 0.8], true);
   reg(record.add("tubeY").move(0, 0.03, 0).scale(0.025, 0.03, 0.025), [0.7, 0.7, 0.72], true);
   const ARM_PIVOT = [0.55, TOP + 0.25, -0.45];
   reg(player.add("tubeY").move(ARM_PIVOT[0], ARM_PIVOT[1] + 0.06, ARM_PIVOT[2]).scale(0.06, 0.06, 0.06), [0.7, 0.7, 0.72], true);
   const arm = player.add();
   part(arm, 0, 0, 0.4, 0.05, 0.05, 0.8, [0.75, 0.75, 0.78], true);
   part(arm, 0, -0.03, 0.8, 0.12, 0.06, 0.15, [0.2, 0.2, 0.22], true);
   let recordTurn = 0;

   // Music notes
   const notes = [0, 1, 2].map(() => {
      const note = player.add();
      note.add("sphere").scale(0.12, 0.09, 0.06);
      note.add("cube").move(0.1, 0.22, 0).scale(0.02, 0.22, 0.02);
      return note;
   });

   // Wardrobe
   const WX = 6.95, WZ = 3.5;
   part(cabin, WX + 0.7, FLOOR + 3.25, WZ, 0.2, 6.5, 3, WOOD, true);
   for (const sz of [-1, 1])
      part(cabin, WX, FLOOR + 3.25, WZ + sz * 1.45, 1.6, 6.5, 0.1, WOOD, true);
   part(cabin, WX, FLOOR + 6.45, WZ, 1.6, 0.1, 3, WOOD, true);
   part(cabin, WX, FLOOR + 0.05, WZ, 1.6, 0.1, 3, WOOD, true);
   part(cabin, WX, FLOOR + 5.85, WZ, 1.5, 0.08, 2.8, WOOD, true);
   part(cabin, WX, FLOOR + 6.0, WZ - 0.6, 1.1, 0.2, 0.9, [0.3, 0.5, 0.35], true);
   part(cabin, WX, FLOOR + 6.2, WZ - 0.6, 1.0, 0.2, 0.85, [0.85, 0.8, 0.65], true);
   part(cabin, WX, FLOOR + 6.02, WZ + 0.6, 1.1, 0.22, 0.9, [0.6, 0.25, 0.25], true);
   reg(cabin.add("tubeZ").move(WX + 0.1, FLOOR + 5.5, WZ).scale(0.05, 0.05, 1.4), [0.7, 0.7, 0.72], true);
   // Shirts
   [[-0.9, [0.75, 0.2, 0.18]], [0, [0.25, 0.5, 0.3]], [0.9, [0.2, 0.25, 0.5]]].forEach(([z, color]) => {
      part(cabin, WX + 0.1, FLOOR + 5.42, WZ + z, 0.05, 0.16, 0.05, [0.7, 0.7, 0.72], true);
      part(cabin, WX + 0.1, FLOOR + 5.2, WZ + z, 0.15, 0.3, 0.8, color, true);
      part(cabin, WX + 0.1, FLOOR + 4.4, WZ + z, 0.15, 1.5, 0.65, color, true);
   });
   for (const z of [-0.6, -0.2]) {
      part(cabin, WX + 0.25, FLOOR + 0.55, WZ + z, 0.32, 0.75, 0.28, [0.3, 0.18, 0.1], true);
      part(cabin, WX + 0.05, FLOOR + 0.22, WZ + z, 0.7, 0.24, 0.28, [0.3, 0.18, 0.1], true);
   }
   const wardrobeDoors = [-1, 1].map(sz => {
      const hinge = cabin.add();
      const panel = part(hinge, 0, FLOOR + 3.25, -sz * 0.75, 0.1, 6.4, 1.45, [0.5, 0.33, 0.2], true);
      part(hinge, -0.1, FLOOR + 3.4, -sz * 1.25, 0.12, 0.6, 0.12, [0.9, 0.75, 0.2], true);
      return { hinge, sz, panel };
   });

   // Front door
   const hinge = cabin.add();
   const doorPanel = part(hinge, DOOR_W / 2, 3.45, 0, DOOR_W - 0.1, 6.8, 0.25, [0.4, 0.25, 0.14]);
   const handles = [0.3, -0.3].map(z => reg(hinge.add("sphere").move(DOOR_W - 0.4, 3.2, z).scale(0.2), [0.8, 0.7, 0.3]));

   // Roof
   const slope = Math.atan2(2, 3);
   const ROOF_Y = 10.15;
   for (const sz of [-1, 1])
      reg(cabin.add("cube").move(0, ROOF_Y, sz * 3.5).turnX(sz * slope).scale(W / 2 + 1, 0.15, 4.25), [0.3, 0.18, 0.12]);
   part(cabin, 0, ROOF_Y + 2.45, 0, W + 2, 0.3, 0.5, [0.25, 0.15, 0.1]);

   // Gables
   for (const sx of [-1, 1])
      for (let y = H; ; y += 0.25) {
         const half = Math.min(D / 2, 3.5 + (ROOF_Y - 0.18 - (y + 0.25)) * 1.5 - 0.05);
         if (half < 0.2)
            break;
         part(cabin, sx * W / 2, y + 0.125, 0, WALL, 0.25, 2 * half, LOG);
      }

   // Snow
   const snow = Array.from({ length: 40 }, () => cabin.add("sphere"));

   // Stool and cabinet
   box(model, STOOL[0], STOOL[1] / 2, STOOL[2], 0.3, STOOL[1], 0.3, [0.5, 0.35, 0.2]);
   box(model, CABINET[0], CABINET[1] / 2, CABINET[2], 0.5, CABINET[1], 0.35, [0.4, 0.3, 0.25]);
   for (const y of [0.3, 0.6])
      box(model, CABINET[0], y, CABINET[2] + 0.176, 0.44, 0.01, 0.005, [0.25, 0.18, 0.14]);

   // Firewood and matches
   const LOG_COLORS = { bark: [0.4, 0.25, 0.13], ends: [0.85, 0.7, 0.45] };
   const WET_COLORS = { bark: [0.22, 0.26, 0.33], ends: [0.45, 0.5, 0.55] };
   const MATCH_COLORS = { bark: [0.85, 0.2, 0.15], ends: [0.25, 0.2, 0.2] };
   const itemNodes = freshGame().items.map(it => {
      const node = model.add();
      if (it.kind === "log")
         return {
            node,
            bark: node.add("tubeZ").scale(LOG_R, LOG_R, LOG_LEN / 2),
            ends: [-1, 1].map(s => node.add("tubeZ").move(0, 0, s * LOG_LEN / 2).scale(LOG_R * 0.85, LOG_R * 0.85, 0.0008)),
         };
      return {
         node,
         bark: node.add("cube").scale(MATCH[0] / 2, MATCH[1] / 2, MATCH[2] / 2),
         ends: [-1, 1].map(s => node.add("cube").move(s * MATCH[0] / 2, 0, 0).scale(0.0004, MATCH[1] * 0.4, MATCH[2] * 0.45)),
      };
   });
   const itemGlow = new Set();

   // Things you can use. Only the door works for the giant.
   const amount = {};
   const ease = (name, dt) => {
      const target = G().open[name] ? 1 : 0;
      if (amount[name] === undefined)
         amount[name] = target;
      amount[name] += (target - amount[name]) * Math.min(1, 6 * dt);
      return amount[name];
   };
   const things = [
      { name: "door", spot: () => cg.mTransform(hinge.getMatrix(), [DOOR_W / 2, 3.4, 0]), reach: 2.3, glow: [doorPanel, ...handles], giant: true },
      { name: "lamp", spot: () => lampSpot, reach: 1.6, glow: [shade] },
      { name: "fire", spot: () => fireSpot, reach: 2.3, glow: [opening] },
      { name: "record", spot: () => [RX, TOP + 0.4, RZ], reach: 2, glow: recordParts },
      { name: "wardrobe", spot: () => [WX - 0.9, 3.5, WZ], reach: 2.5, glow: wardrobeDoors.map(d => d.panel) },
      { name: "book", spot: () => [TX, 2.6, -2.5], reach: 1.5, glow: bookParts },
      ...curtains.map((c, i) => ({
         name: "curtain" + i,
         spot: () => onWall(c.win.wall, (c.win.u[0] + c.win.u[1]) / 2, (c.win.y[0] + c.win.y[1]) / 2, WALL / 2 + 0.3),
         reach: 2.2, glow: c.panels,
      })),
   ];
   const glowSet = new Set();

   // Avatars
   const SKIN = [0.96, 0.8, 0.66], HAIR = [0.3, 0.18, 0.1], SHIRT = [0.85, 0.2, 0.2], PANTS = [0.2, 0.3, 0.65];
   const makeAvatar = () => {
      const p = shape => model.add(shape);
      const parts = {
         face: p("sphere"), hair: p("sphere"), headset: p("cube"), lens: p("cube"),
         torso: p("tubeY"), hips: p("sphere"),
         shoulders: [p("sphere"), p("sphere")],
         upperArms: [p("tubeZ"), p("tubeZ")], forearms: [p("tubeZ"), p("tubeZ")],
         fists: [p("sphere"), p("sphere")], controllers: [p("cube"), p("cube")],
         legs: [p("tubeZ"), p("tubeZ")], shoes: [p("cube"), p("cube")],
      };
      return { parts, all: Object.values(parts).flat() };
   };
   const hideAvatar = a => a.all.forEach(p => p.identity().scale(0));
   const selfAvatar = makeAvatar();
   const otherAvatars = [makeAvatar(), makeAvatar(), makeAvatar()];

   // What you're holding
   const myHold = {};
   const takenFrom = {};

   // Instructions panel. It floats in front of you and turns with you.
   const g2 = new G2();
   model.txtrSrc(2, g2.getCanvas());
   const panel = model.add("square").txtr(2);
   let panelYaw = null, panelShown = true;
   const line = (text, y, h) => {
      g2.textHeight(h);
      const w = 2 * g2.getContext().measureText(text).width / g2.getCanvas().width;
      if (w > 1.85)
         g2.textHeight(h * 1.85 / w);
      g2.text(text, 0, y, "center");
   };
   const fuelToLight = () => G().night > 0 ? 1 : LOGS_NEEDED;
   const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

   // Short messages, like "you need the matches"
   let hint = "", hintUntil = 0;
   const say = text => {
      hint = text;
      hintUntil = model.time + 3;
   };

   g2.render = function () {
      const g = G();
      const mini = isMini();

      // Morning, or the cabin froze
      if (g.over) {
         const win = g.over === "win";
         this.setColor(win ? [0.35, 0.22, 0.1, 0.95] : [0.08, 0.12, 0.22, 0.95]).fillRect(-1, -1, 2, 2, 0.08);
         this.setColor(win ? [1, 0.85, 0.35] : [0.6, 0.85, 1]);
         line(win ? "GOOD MORNING!" : "THE CABIN FROZE", 0.72, 0.16);
         this.setColor("white");
         if (win)
            line("You kept the cabin warm all night!", 0.46, 0.075);
         else {
            line("It got too cold before sunrise.", 0.46, 0.075);
            line(`Morning was ${clock(NIGHT - g.night)} away.`, 0.32, 0.07);
         }
         this.setColor([1, 0.95, 0.8]);
         line(`Time: ${clock(g.time)}`, 0.1, 0.07);
         line(`Logs burned: ${g.burned}`, -0.04, 0.07);
         line(`Wind gusts: ${g.gusts}`, -0.18, 0.07);
         line(`Fire went out: ${g.outs === 1 ? "1 time" : g.outs + " times"}`, -0.32, 0.07);
         this.setColor([0.85, 0.85, 0.9]);
         line(win ? "Y: play again" : "Y: try again", -0.58, 0.08);
         line("B: swap roles", -0.74, 0.065);
         return;
      }

      this.setColor([0.08, 0.08, 0.12, 0.92]).fillRect(-1, -1, 2, 2, 0.08);
      this.setColor(mini ? [1, 0.85, 0.4] : [0.6, 0.85, 1]);
      line(mini ? "YOU ARE MINI" : "YOU ARE THE GIANT", 0.8, 0.11);

      // What to do next
      let goal;
      if (g.night === 0 && mini)
         goal = g.fuel < LOGS_NEEDED
            ? ["Get the logs the giant leaves on the porch.", "Put 3 in the fireplace."]
            : ["Bring the matches (red box) to the fireplace.", "Hold them close to light the fire."];
      else if (g.night === 0)
         goal = ["Find the logs and matches (red box).", "Put them on the porch for mini."];
      else if (mini && !g.lit)
         goal = ["The fire went out!", "Relight it with the matches."];
      else if (mini)
         goal = ["Keep the fire going until morning.", "Close the door if the wind opens it."];
      else
         goal = ["Keep bringing logs to the porch.", "Gray logs are wet. Mini can dry them."];
      this.setColor("white");
      line(goal[0], 0.6, 0.075);
      line(goal[1], 0.46, 0.075);

      // Status
      this.setColor([1, 0.95, 0.7]);
      if (g.night > 0)
         line(`Logs in fire: ${g.fuel}/${LOGS_NEEDED}     Morning in ${clock(Math.max(0, NIGHT - g.night))}`, 0.28, 0.07);
      else
         line(`Logs in fire: ${g.fuel}/${LOGS_NEEDED}     Time: ${clock(g.time)}`, 0.28, 0.07);

      // Warmth bar
      this.setColor("white");
      this.textHeight(0.06);
      this.text("Warmth", -0.68, 0.12, "center");
      this.setColor([0.25, 0.25, 0.3]).fillRect(-0.45, 0.085, 1.3, 0.08);
      this.setColor([0.3 + 0.7 * g.heat, 0.4, 1 - 0.8 * g.heat]).fillRect(-0.45, 0.085, 1.3 * g.heat, 0.08);

      // Warnings
      const heldWet = Object.values(myHold).some(i => g.items[i] && g.items[i].wet);
      let alert = "";
      if (model.time < hintUntil)
         alert = hint;
      else if (heldWet)
         alert = mini ? "Wet log! Dry it on the hearth by the fire."
                      : "Wet log! Mini can dry it on the hearth.";
      else if (g.night > 0) {
         if (g.time - g.blownAt < 3)
            alert = "The wind blew out the fire!";
         else if (g.time - g.gustAt < 3)
            alert = "The wind blew the door open!";
         else if (g.gust < 4)
            alert = "The wind is picking up!";
         else if (g.open.door)
            alert = "Close the door before the next gust!";
      }
      this.setColor([1, 0.6, 0.3]);
      if (alert)
         line(alert, -0.08, 0.07);

      // Controls
      this.setColor([0.3, 0.3, 0.36]).fillRect(-0.9, -0.22, 1.8, 0.005);
      this.setColor([0.85, 0.85, 0.9]);
      if (mini) {
         line("Trigger: grab, or open and close things", -0.34, 0.065);
         line("Hold to carry. Let go to drop.", -0.48, 0.065);
      }
      else {
         line("Trigger: grab by touching or pointing", -0.34, 0.065);
         line("You can also move the cabin or open its door.", -0.48, 0.065);
      }
      line("Left stick: walk     Right stick: turn", -0.62, 0.065);
      line("B: swap roles     Y: restart", -0.76, 0.065);
      this.setColor([0.6, 0.6, 0.66]);
      line("Click left stick: hide or show this panel", -0.9, 0.05);
   };

   // Window glass, made last so you can see through it
   const glassGroup = model.add();
   const glass = glassSpots.map(g => glassGroup.add("cube").move(...g.at).scale(...g.size));

   // Input
   const handMatrix = hand => controllerMatrix[hand] && controllerMatrix[hand].length ? controllerMatrix[hand] : null;
   const pressed = (hand, b) => buttonState[hand][b] && buttonState[hand][b].pressed;
   const wasDown = {};
   const pressEdge = (key, down) => {
      const edge = down && !wasDown[key];
      wasDown[key] = down;
      return edge;
   };

   // The ball at the front of your controller
   const ballMatrix = hand => {
      const m = handMatrix(hand);
      return m ? cg.mMultiply(clay.inverseRootMatrix, cg.mMultiply(m, cg.mMultiply(cg.mTranslate([0, -0.049, -0.079]), cg.mRotateX(-Math.PI / 4)))) : null;
   };

   // Where the cabin is
   let localCabin = null, localUntil = 0;
   const cabinPose = () => localCabin && model.time < localUntil ? localCabin : { pos: G().cabinPos, yaw: G().cabinYaw };
   const toCabin = p => {
      const c = cabinPose();
      return cg.mTransform(cg.mInverse(cabinMatrix(c.pos, c.yaw)), p);
   };

   // Walls block walking, except the open doorway
   const blocked = p => {
      const l = toCabin(p);
      const nearSide = Math.abs(Math.abs(l[0]) - W / 2) < BODY_R && Math.abs(l[2]) < D / 2 + BODY_R;
      const nearEnd = Math.abs(Math.abs(l[2]) - D / 2) < BODY_R && Math.abs(l[0]) < W / 2 + BODY_R;
      const doorway = G().open.door && l[2] > 0 && Math.abs(l[0]) < DOOR_W / 2 - 0.3;
      return (nearSide || nearEnd) && !doorway;
   };

   // Floor height under the avatar
   const inCabinOrPorch = l => Math.abs(l[0]) < W / 2 && l[2] > -D / 2 && l[2] < D / 2 + 4 && (l[2] < D / 2 || Math.abs(l[0]) < 4);
   const floorAt = p => inCabinOrPorch(toCabin(p)) ? cabinPose().pos[1] + FLOOR * FT : TABLE.y;

   const onTable = p => [
      clamp(p[0], TABLE.x - TABLE.w / 2 + 0.02, TABLE.x + TABLE.w / 2 - 0.02),
      p[1],
      clamp(p[2], TABLE.z - TABLE.d / 2 + 0.02, TABLE.z + TABLE.d / 2 - 0.02),
   ];

   // Walk
   const walk = dt => {
      const x = joyStickState.left.x || 0;
      const y = joyStickState.left.y || 0;
      if (Math.hypot(x, y) < 0.15)
         return;
      const view = cg.mMultiply(clay.inverseRootMatrix, clay.root().inverseViewMatrix(0));
      const forward = cg.normalize([-view[8], 0, -view[10]]);
      const right = [-forward[2], 0, forward[0]];
      const step = cg.scale(cg.add(cg.scale(right, x), cg.scale(forward, -y)), (isMini() ? WALK_SPEED : GIANT_SPEED) * dt);

      // The giant stays inside the room
      if (!isMini()) {
         const next = cg.add(posOf(view), step);
         if (Math.abs(next[0]) < 3.7 && next[2] > -4.7 && next[2] < 2.7)
            L.giant = cg.add(L.giant, step);
         return;
      }

      for (const tryStep of [step, [step[0], 0, 0], [0, 0, step[2]]]) {
         const next = onTable(cg.add(L.avatar, tryStep));
         if (!blocked(next) || blocked(L.avatar)) {
            L.avatar = next;
            return;
         }
      }
   };

   // Turn
   const turn = dt => {
      const x = joyStickState.right.x || 0;
      if (Math.abs(x) < 0.2)
         return;
      let view;
      try {
         view = clay.root().inverseViewMatrix(0);
      } catch (e) {
         return;
      }
      const toScene = isMini() ? toMini : toGiant;
      const before = posOf(cg.mMultiply(toScene(), view));
      if (isMini())
         L.yaw -= x * TURN_SPEED * dt;
      else
         L.giantYaw -= x * TURN_SPEED * dt;
      const after = posOf(cg.mMultiply(toScene(), view));
      const body = isMini() ? L.avatar : L.giant;
      body[0] += before[0] - after[0];
      body[2] += before[2] - after[2];
   };

   // Using things

   const handInCabin = hand => {
      const m = handMatrix(hand);
      return m ? cg.mTransform(cg.mInverse(cabin.getGlobalMatrix()), posOf(m)) : null;
   };

   // Closest thing in reach
   const nearestThing = hand => {
      const h = handInCabin(hand);
      if (!h)
         return null;
      let best = null;
      for (const t of things) {
         if (!isMini() && !t.giant)
            continue;
         const d = cg.distance(h, t.spot()) / (t.reach * (isMini() ? 1 : 2));
         if (d < 1 && (!best || d < best.d))
            best = { thing: t, d };
      }
      return best && best.thing;
   };

   // Thing the beam points at
   const beamThing = hand => {
      const cb = hand === "left" ? lcb : rcb;
      let bm;
      try {
         bm = cb.beamMatrix();
      } catch (e) {
         return null;
      }
      const toLocal = cg.mInverse(cabin.getGlobalMatrix());
      const origin = cg.mTransform(toLocal, posOf(bm));
      const dir = cg.normalize(cg.subtract(cg.mTransform(toLocal, cg.subtract(posOf(bm), bm.slice(8, 11))), origin));
      let best = null;
      for (const t of things.filter(t => t.giant)) {
         const v = cg.subtract(t.spot(), origin);
         const along = cg.dot(v, dir);
         const off = cg.norm(cg.subtract(v, cg.scale(dir, along)));
         if (along > 0 && off < t.reach && (!best || along < best.along))
            best = { thing: t, along };
      }
      return best && best.thing;
   };

   const setOpen = (name, value) => {
      G().open[name] = value;
      send({ op: "open", name, value });
   };

   const holdingMatches = () => Object.values(myHold).some(i => G().items[i].kind === "matches");

   // The fireplace needs firewood and the matches
   const lightFire = () => {
      const g = G();
      if (g.lit || g.over)
         return;
      if (!holdingMatches())
         say("You need the matches.");
      else if (g.fuel < fuelToLight())
         say(fuelToLight() === 1 ? "Add a dry log first." : `Add ${fuelToLight()} dry logs first.`);
      else {
         g.lit = true;
         send({ op: "light" });
      }
   };

   const use = thing => {
      if (thing.name === "fire")
         lightFire();
      else
         setOpen(thing.name, !G().open[thing.name]);
   };

   // Firewood and matches

   const itemPose = i => {
      const it = G().items[i];
      let m = null;
      for (const hand in myHold)
         if (myHold[hand] === i)
            m = ballMatrix(hand);
      if (!m && it.holder && it.holder[0] !== clientID)
         m = clientState.hand(it.holder[0], it.holder[1]);
      return m ? { pos: posOf(m), yaw: yawOf(m) + Math.PI / 2 } : { pos: it.pos, yaw: it.yaw };
   };

   // Closest thing in reach
   const nearestItem = hand => {
      const m = ballMatrix(hand);
      if (!m)
         return -1;
      const p = posOf(m);
      let best = -1, bestD = 1e9;
      G().items.forEach((it, i) => {
         if (it.inFire || Object.values(myHold).includes(i))
            return;
         const q = itemPose(i).pos;
         let d = 1e9;
         if (isMini()) {
            const flat = Math.hypot(q[0] - p[0], q[2] - p[2]);
            const below = p[1] - q[1];
            if (flat < 0.35 / SCALE && below > -0.3 / SCALE && below < 1.3 / SCALE)
               d = flat;
         }
         else if (cg.distance(p, q) < 0.12)
            d = cg.distance(p, q);
         if (d < bestD) {
            bestD = d;
            best = i;
         }
      });
      return best;
   };

   // Thing the giant's beam points at
   const beamItem = hand => {
      const cb = hand === "left" ? lcb : rcb;
      let bm;
      try {
         bm = cb.beamMatrix();
      } catch (e) {
         return -1;
      }
      const origin = cg.mTransform(clay.inverseRootMatrix, posOf(bm));
      const dir = cg.normalize(cg.subtract(cg.mTransform(clay.inverseRootMatrix, cg.subtract(posOf(bm), bm.slice(8, 11))), origin));
      let best = -1, bestAlong = 1e9;
      G().items.forEach((it, i) => {
         if (it.inFire || it.holder)
            return;
         const v = cg.subtract(it.pos, origin);
         const along = cg.dot(v, dir);
         const off = cg.norm(cg.subtract(v, cg.scale(dir, along)));
         if (along > 0 && off < 0.04 + 0.02 * along && along < bestAlong) {
            best = i;
            bestAlong = along;
         }
      });
      return best;
   };

   // Tops of the furniture in the cabin, in feet: x, z, width, depth, height
   const SURFACES = [
      [-6, -2.5, 3.5, 6.5, 1.65],                     // bed
      [NX, -4.9, 1.6, 1.4, 2.2],                      // nightstand
      [TX, -2.5, 3.5, 2.2, 2.5],                      // table
      [TX, -0.7, 1.4, 1.4, 1.5],                      // chair
      [RX, RZ, 1.6, 2.2, TOP],                        // record player
      [RX, RZ - 0.15, 1.3, 1.5, TOP + 0.3],           // turntable
      [WX, WZ, 1.5, 2.8, FLOOR + 5.89],               // wardrobe shelf
      [WX, WZ, 1.6, 3, FLOOR + 6.5],                  // wardrobe top
      [5, FZ + 1.5, 5, 1, FLOOR + 0.14],              // hearth
      [5, FZ + 0.1, 4.6, 2.4, FLOOR + 3.8],           // mantel
   ];

   // Height of whatever is under a spot in the cabin: furniture, the roof or the floor
   const cabinFloorAt = l => {
      let top = inCabinOrPorch(l) ? FLOOR : -1;
      for (const [x, z, w, d, y] of SURFACES)
         if (Math.abs(l[0] - x) < w / 2 && Math.abs(l[2] - z) < d / 2 && y <= l[1] + 0.5 && y > top)
            top = y;
      if (l[1] > H && Math.abs(l[0]) < W / 2 + 1 && Math.abs(l[2]) < 7)
         top = Math.max(top, ROOF_Y + 0.15 + (3.5 - Math.abs(l[2])) * 2 / 3);
      return top;
   };

   // Where a dropped thing lands: the cabin, the table, the stool, the cabinet or the floor
   const settle = p => {
      const onTop = Math.abs(p[0] - TABLE.x) < TABLE.w / 2 && Math.abs(p[2] - TABLE.z) < TABLE.d / 2 && p[1] > TABLE.y - 0.05;
      const onStool = Math.hypot(p[0] - STOOL[0], p[2] - STOOL[2]) < 0.15 && p[1] > STOOL[1] - 0.05;
      const onCabinet = Math.abs(p[0] - CABINET[0]) < 0.25 && Math.abs(p[2] - CABINET[2]) < 0.175 && p[1] > CABINET[1] - 0.05;
      const inCabin = onTop ? cabinFloorAt(toCabin(p)) : -1;
      const y = inCabin >= 0 ? cabinPose().pos[1] + inCabin * FT : onTop ? TABLE.y : onStool ? STOOL[1] : onCabinet ? CABINET[1] : 0;
      return [p[0], y, p[2]];
   };

   const countFuel = () => G().fuel = G().items.filter(it => it.inFire).length;

   const applyDrop = (it, pos, yaw, fuel) => {
      it.holder = null;
      if (fuel)
         it.inFire = true;
      else {
         const s = settle(pos);
         it.pos = [s[0], s[1] + halfHeight(it), s[2]];
         it.yaw = yaw;
      }
      countFuel();
   };

   const grabItem = (hand, i) => {
      myHold[hand] = i;
      G().items[i].holder = [clientID, hand];
      G().started = true;
      send({ op: "grab", item: i, hand });
   };

   // Only mini can put firewood in the fireplace. Wet logs and extra logs go on the hearth.
   const dropItem = hand => {
      const i = myHold[hand];
      delete myHold[hand];
      const m = ballMatrix(hand);
      const it = G().items[i];
      if (!m || !it)
         return;
      let pos = posOf(m).map(v => round(v, 10000));
      const yaw = round(yawOf(m) + Math.PI / 2, 100);
      const atFire = isMini() && it.kind === "log" && cg.distance(toCabin(pos), fireSpot) < 3;
      const fuel = atFire && !it.wet && G().fuel < LOGS_NEEDED;
      if (atFire && !fuel) {
         const c = cabinPose();
         const spot = [hearthSpot[0] + 2 * Math.random() - 1, hearthSpot[1], hearthSpot[2]];
         pos = cg.mTransform(cabinMatrix(c.pos, c.yaw), spot).map(v => round(v, 10000));
         say(it.wet ? "Too wet to burn. Dry it on the hearth." : "The fireplace is full.");
      }
      applyDrop(it, pos, yaw, fuel);
      send({ op: "drop", item: i, pos, yaw, fuel });
   };

   // A burned log comes back as new firewood somewhere in the room, sometimes wet
   const respawn = it => {
      const others = G().items.filter(o => o !== it && !o.inFire);
      const free = SPOTS.filter(s => others.every(o => Math.hypot(o.pos[0] - s[0], o.pos[2] - s[2]) > 0.08 || Math.abs(o.pos[1] - s[1]) > 0.1));
      const s = free[Math.floor(Math.random() * free.length)] || SPOTS[0];
      Object.assign(it, { pos: [s[0], s[1] + LOG_R, s[2]], yaw: round(3 * Math.random(), 100), holder: null, inFire: false, wet: Math.random() < WET_CHANCE, dry: 0 });
   };

   // Burning, warmth, drying and wind (first player only)
   const tickGame = dt => {
      const g = G();
      if (!g.started || g.over)
         return;
      g.time += dt;
      if (g.lit || g.night > 0)
         g.night += dt;

      // Logs burn up one at a time
      if (g.lit) {
         g.burn += dt / BURN_TIME;
         if (g.burn >= 1) {
            g.burn = 0;
            respawn(g.items.find(it => it.inFire));
            g.burned++;
            if (countFuel() === 0) {
               g.lit = false;
               g.outs++;
            }
         }
      }

      // Wet logs dry on the hearth
      for (const it of g.items)
         if (it.wet && g.lit && !it.holder && cg.distance(toCabin(it.pos), fireSpot) < 4) {
            it.dry += dt / DRY_TIME;
            if (it.dry >= 1)
               it.wet = false;
         }

      // Wind blows the door open. If it's already open, the fire goes out.
      if (g.night > 0) {
         g.gust -= dt;
         if (g.gust <= 0) {
            if (g.open.door && g.lit) {
               g.lit = false;
               g.outs++;
               g.blownAt = g.time;
            }
            g.open.door = true;
            g.gustAt = g.time;
            g.gusts++;
            g.gust = 15 + 10 * Math.random();
         }
      }

      // Warmth
      let change = g.lit ? 0.04 : g.night > 0 ? -0.012 : -0.004;
      if (g.open.door && g.night > 0)
         change -= 0.03;
      g.heat = clamp(g.heat + change * dt, 0, 1);
      if (g.heat === 0)
         g.over = "lose";
      else if (g.night >= NIGHT)
         g.over = "win";
   };

   // Messages
   const handle = (msg, id) => {
      const g = G();
      const it = g.items[msg.item];
      if (msg.op === "open")
         g.open[msg.name] = msg.value;
      if (msg.op === "cabin") {
         g.cabinPos = msg.pos;
         g.cabinYaw = msg.yaw;
      }
      if (msg.op === "grab" && it && !it.inFire) {
         it.holder = [id, msg.hand];
         g.started = true;
      }
      if (msg.op === "drop" && it && it.holder && it.holder[0] === id)
         applyDrop(it, msg.pos, msg.yaw, msg.fuel);
      if (msg.op === "light" && !g.lit && g.fuel >= fuelToLight())
         g.lit = true;
      if (msg.op === "swap")
         g.swapped = msg.value;
      if (msg.op === "reset")
         Object.assign(g, freshGame(), { open: {} });
   };

   // Carrying the cabin

   let held = null;

   const tryGrab = hand => {
      const l = handInCabin(hand);
      if (!l || Math.abs(l[0]) > W / 2 + 2 || Math.abs(l[2]) > D / 2 + 4 || l[1] < -2 || l[1] > 15)
         return;
      const c = cabinPose();
      held = { hand, offset: cg.subtract(c.pos, posOf(cg.mMultiply(clay.inverseRootMatrix, handMatrix(hand)))) };
      localCabin = { pos: c.pos.slice(), yaw: c.yaw };
   };

   const moveHeld = dt => {
      const m = handMatrix(held.hand);
      if (!m)
         return;
      const pos = cg.add(posOf(cg.mMultiply(clay.inverseRootMatrix, m)), held.offset);
      localCabin = { pos: [pos[0], Math.max(TABLE.y, pos[1]), pos[2]], yaw: localCabin.yaw - (joyStickState.right.x || 0) * TURN_SPEED * dt };
      localUntil = model.time + 0.5;
      send({ op: "cabin", pos: localCabin.pos.map(v => round(v, 10000)), yaw: round(localCabin.yaw, 1000) });
   };

   const dropCabin = () => {
      const p = onTable(localCabin.pos);
      localCabin = { pos: [p[0], TABLE.y, p[2]], yaw: localCabin.yaw };
      localUntil = model.time + 0.5;
      G().cabinPos = localCabin.pos;
      G().cabinYaw = localCabin.yaw;
      send({ op: "cabin", pos: localCabin.pos, yaw: localCabin.yaw });
      held = null;
   };

   // Posing an avatar
   const UPPER_ARM = 0.28, FOREARM = 0.27;

   const poseAvatar = (a, M, head, hands) => {
      const av = a.parts;
      const headM = cg.mMultiply(M, head);
      const eye = posOf(head);
      const fwd = cg.normalize([-head[8], 0, -head[10]]);
      const right = [-fwd[2], 0, fwd[0]];
      const yaw = Math.atan2(-fwd[0], -fwd[2]);

      // Head
      av.face.setMatrix(headM).move(0, 0, 0.05).scale(0.09, 0.105, 0.1).color(...SKIN);
      av.hair.setMatrix(headM).move(0, 0.025, 0.065).scale(0.09).color(...HAIR);
      av.headset.setMatrix(headM).move(0, 0.01, -0.05).scale(0.09, 0.045, 0.045).color(0.12, 0.12, 0.14);
      av.lens.setMatrix(headM).move(0, 0.01, -0.096).scale(0.075, 0.03, 0.004).color(0.2, 0.8, 1.2);

      // Body
      const neck = cg.add(eye, cg.add(cg.scale(fwd, -0.07), [0, -0.16, 0]));
      const chest = neck[1] - 0.04;
      const hip = [neck[0], Math.max(0.15, Math.min(0.53 * MY_HEIGHT, neck[1] - 0.4)), neck[2]];
      av.torso.setMatrix(M).move(neck[0], (hip[1] + chest) / 2, neck[2]).turnY(yaw).scale(0.15, (chest - hip[1]) / 2, 0.09).color(...SHIRT);
      av.hips.setMatrix(M).move(hip).turnY(yaw).scale(0.15, 0.08, 0.09).color(...PANTS);

      // Arms
      [0, 1].forEach(i => {
         const side = i ? 1 : -1;
         const shoulder = cg.add([neck[0], chest - 0.03, neck[2]], cg.scale(right, side * 0.17));
         const m = hands[i];
         let wrist = m ? posOf(m) : cg.add(shoulder, [0, -(UPPER_ARM + FOREARM) * 0.95, 0]);
         const reach = cg.subtract(wrist, shoulder);
         const dist = Math.min(cg.norm(reach), (UPPER_ARM + FOREARM) * 0.999);
         const dir = cg.normalize(reach);
         wrist = cg.add(shoulder, cg.scale(dir, dist));

         let bend = cg.add([0, -1, 0], cg.add(cg.scale(right, side * 0.4), cg.scale(fwd, -0.3)));
         bend = cg.subtract(bend, cg.scale(dir, cg.dot(bend, dir)));
         bend = cg.norm(bend) > 0.01 ? cg.normalize(bend) : cg.scale(right, side);
         const out = Math.sqrt(Math.max(0, UPPER_ARM * UPPER_ARM - (dist / 2) * (dist / 2)));
         const elbow = cg.add(cg.add(shoulder, cg.scale(dir, dist / 2)), cg.scale(bend, out));

         av.shoulders[i].setMatrix(M).move(shoulder).scale(0.05).color(...SHIRT);
         av.upperArms[i].setMatrix(M).link(shoulder, elbow, 0.045).color(...SHIRT);
         av.forearms[i].setMatrix(M).link(elbow, wrist, 0.037).color(...SKIN);
         av.fists[i].setMatrix(M).move(wrist).scale(0.045).color(...SKIN);
         if (m)
            av.controllers[i].setMatrix(cg.mMultiply(M, m)).scale(0.02, 0.03, 0.05).color(0.15, 0.15, 0.17);
         else
            av.controllers[i].identity().scale(0);

         // Legs
         const hipSide = cg.add(hip, cg.scale(right, side * 0.08));
         const foot = [hipSide[0], 0.06, hipSide[2]];
         av.legs[i].setMatrix(M).link(hipSide, foot, 0.06).color(...PANTS);
         av.shoes[i].setMatrix(M).move(cg.add([foot[0], 0.04, foot[2]], cg.scale(fwd, 0.04))).turnY(yaw).scale(0.05, 0.04, 0.11).color(0.95, 0.95, 0.95);
      });
   };

   // Every frame

   let lastTime = model.time;
   let lastRole = null;
   let lastCabinM = null;
   let lastWindy = false, lastGustAt = null;
   let frame = 0;

   model.animate(() => {
      const dt = clamp(model.time - lastTime, 0, 0.05) || 0;
      lastTime = model.time;
      const solo = players().length < 2;

      // Shared state
      server.sync("hw8Msgs", (msgs, id) => {
         if (window.clients && isMasterClient())
            for (const msg of Object.values(msgs))
               handle(msg, id);
      });
      if (window.clients && isMasterClient()) {
         for (const it of G().items)
            if (it.holder && !players().includes(it.holder[0]))
               it.holder = null;
         tickGame(dt);
         if (frame % 2 === 0)
            server.broadcastGlobal("hw8State");
      }
      frame++;

      // Swap roles or restart
      if (L.heightFix === null)
         measureHeight();
      if (pressEdge("B", pressed("right", 5))) {
         if (solo)
            L.soloMini = !L.soloMini;
         else {
            G().swapped = !G().swapped;
            send({ op: "swap", value: G().swapped });
         }
      }
      if (pressEdge("Y", pressed("left", 5))) {
         Object.assign(G(), freshGame(), { open: {} });
         for (const hand in myHold)
            delete myHold[hand];
         send({ op: "reset" });
      }

      // Switch views
      const r = role();
      if (r !== lastRole) {
         if (held)
            dropCabin();
         for (const hand in myHold)
            dropItem(hand);
         measureHeight();
         lastRole = r;
      }

      // Carry the mini avatar with the cabin
      const c = cabinPose();
      const cabinM = cabinMatrix(c.pos, c.yaw);
      if (lastCabinM && cabinM.join() !== lastCabinM.join()) {
         const l = cg.mTransform(cg.mInverse(lastCabinM), L.avatar);
         if (inCabinOrPorch(l))
            L.avatar = cg.mTransform(cabinM, l);
      }
      lastCabinM = cabinM;

      // Move
      walk(dt);
      if (!held)
         turn(dt);
      L.avatar[1] = floorAt(L.avatar);
      setWorld(isMini() ? miniWorld() : giantWorld());

      // Use or grab
      glowSet.clear();
      itemGlow.clear();
      for (const hand of ["left", "right"]) {
         const near = (!isMini() && !held && beamThing(hand)) || nearestThing(hand);
         if (near)
            near.glow.forEach(n => glowSet.add(n));
         let reach = myHold[hand] === undefined ? nearestItem(hand) : -1;
         if (reach < 0 && myHold[hand] === undefined && !isMini() && !held)
            reach = beamItem(hand);
         if (reach >= 0)
            itemGlow.add(reach);
         const trigger = pressEdge(hand + "trigger", pressed(hand, 0));
         const grip = pressEdge(hand + "grip", pressed(hand, 1));
         if (trigger || grip)
            startAudio();
         if ((trigger || grip) && reach >= 0)
            grabItem(hand, reach);
         else if (trigger && near)
            use(near);
         else if ((trigger || grip) && !isMini() && !held)
            tryGrab(hand);
         if (myHold[hand] !== undefined && !pressed(hand, 0) && !pressed(hand, 1))
            dropItem(hand);
         if (held && held.hand === hand && !pressed(hand, 0) && !pressed(hand, 1))
            dropCabin();
      }
      if (held)
         moveHeld(dt);

      // Holding the matches near the fireplace lights it
      if (isMini() && !G().lit)
         for (const hand in myHold) {
            const m = ballMatrix(hand);
            if (G().items[myHold[hand]].kind === "matches" && m && cg.distance(toCabin(posOf(m)), fireSpot) < 3.5)
               lightFire();
         }

      // Let go if the other player takes your log
      for (const hand in myHold) {
         const i = myHold[hand];
         const h = G().items[i].holder;
         if (h && h[0] !== clientID)
            takenFrom[i] = takenFrom[i] ?? model.time;
         else
            delete takenFrom[i];
         if (takenFrom[i] !== undefined && model.time - takenFrom[i] > 0.5) {
            delete myHold[hand];
            delete takenFrom[i];
         }
      }

      // Share your body. clientState can't send a scaled matrix,
      // so a mini player also sends their head and hands at full size.
      if (window.clientID !== undefined && frame % 2 === 0) {
         const M = isMini() ? miniBody() : cg.mIdentity();
         const body = { m: M.map(v => round(v, 100000)) };
         let view = null;
         try {
            view = clay.root().inverseViewMatrix(0);
         } catch (e) {}
         if (isMini() && view) {
            const toBody = cg.mMultiply(cg.mInverse(M), clay.inverseRootMatrix);
            const pose = m => m ? cg.packMatrix(cg.mMultiply(toBody, m)) : null;
            body.head = pose(view);
            body.left = pose(handMatrix("left"));
            body.right = pose(handMatrix("right"));
         }
         window.hw8Bodies[clientID] = body;
         server.broadcastGlobalElement("hw8Bodies", clientID);
      }

      // Animate
      const g = G();

      // Wind sound at night, with a whoosh for each gust
      const windy = g.night > 0 && !g.over;
      if (wind && windy !== lastWindy) {
         setWind(windy ? 0.12 : 0, 400, 2);
         lastWindy = windy;
      }
      if (g.gustAt !== lastGustAt) {
         if (windy && lastGustAt !== null)
            gustSound();
         lastGustAt = g.gustAt;
      }
      cabin.identity().move(c.pos).turnY(c.yaw).scale(FT);
      glassGroup.identity().move(c.pos).turnY(c.yaw).scale(FT);
      hinge.identity().move(-DOOR_W / 2, FLOOR, D / 2).turnY(1.6 * ease("door", dt));
      const playing = ease("record", dt);
      recordTurn += 3.5 * playing * dt;
      record.identity().move(-0.15, TOP + 0.3, 0).turnY(recordTurn);
      arm.identity().move(ARM_PIVOT[0], ARM_PIVOT[1] + 0.12, ARM_PIVOT[2]).turnY(-0.7 * playing);
      notes.forEach((note, i) => {
         const t = (model.time * 0.45 + i / notes.length) % 1;
         if (playing > 0.5)
            note.identity().move(-0.15 + 0.3 * Math.sin(t * 5 + i), TOP + 0.7 + 1.6 * t, 0.3 * Math.cos(t * 4 + i))
                .scale((1 - 0.4 * t) * playing).color(1.3, 1.05, 0.3);
         else
            note.identity().scale(0);
      });
      bookPage.identity().move(0, 0.15, 0).turnZ(Math.PI * (1 - ease("book", dt))).move(0, -0.15, 0);
      const wardrobe = ease("wardrobe", dt);
      wardrobeDoors.forEach(({ hinge, sz }) => hinge.identity().move(WX - 0.8, 0, WZ + sz * 1.5).turnY(sz * 1.7 * wardrobe));
      curtains.forEach((cur, i) => {
         const closed = ease("curtain" + i, dt);
         const { wall, u, y } = cur.win;
         const wu = u[1] - u[0];
         const width = 0.6 + (wu / 2 + 0.2 - 0.6) * closed;
         cur.panels.forEach((p, k) => {
            const edge = k ? u[1] + 0.3 : u[0] - 0.3;
            const center = edge + (k ? -1 : 1) * width / 2;
            const at = onWall(wall, center, (y[0] + y[1]) / 2, WALL / 2 + 0.25);
            const size = WALLS[wall].alongX ? [width, y[1] - y[0] + 0.6, 0.08] : [0.08, y[1] - y[0] + 0.6, width];
            p.identity().move(...at).scale(size[0] / 2, size[1] / 2, size[2] / 2);
         });
      });

      // Firewood and matches. Wet logs look gray-blue until they dry.
      g.items.forEach((it, i) => {
         const n = itemNodes[i];
         if (it.inFire) {
            n.node.identity().scale(0);
            return;
         }
         const p = itemPose(i);
         n.node.identity().move(p.pos).turnY(p.yaw);
         const colors = it.kind === "matches" ? MATCH_COLORS : LOG_COLORS;
         const wet = it.wet ? 1 - it.dry : 0;
         const glow = itemGlow.has(i) ? 1.6 : 1;
         n.bark.color(...cg.mix(colors.bark, WET_COLORS.bark, wet).map(v => v * glow));
         n.ends.forEach(e => e.color(...cg.mix(colors.ends, WET_COLORS.ends, wet).map(v => v * glow)));
      });

      // Logs in the fireplace. The top one shrinks as it burns.
      FIRE_LOGS.forEach(([y, z, turn], i) => {
         const size = i >= g.fuel ? 0 : i === g.fuel - 1 && g.lit ? 1 - 0.6 * g.burn : 1;
         fireLogs[i].identity().move(5, FLOOR + y, FZ + z).turnY(Math.PI / 2 + turn).scale(size).scale(0.15, 0.15, 0.9);
      });

      // The room's window is dark at night and bright in the morning
      if (g.over === "win")
         roomWindow.color(1.3, 1.1, 0.75);
      else if (g.night > 0)
         roomWindow.color(0.08, 0.1, 0.22);
      else
         roomWindow.color(0.55, 0.75, 0.95);

      // Snow at night
      const snowing = g.night > 0 && g.over !== "win";
      snow.forEach((flake, i) => {
         const a = i * 2.4, r = 13 + 6 * ((i * 0.37) % 1);
         const y = 20 - ((model.time * 2.5 + i * 1.3) % 20);
         if (snowing)
            flake.identity().move(r * Math.cos(a) + 0.5 * Math.sin(model.time + i), y, 2 + r * Math.sin(a)).scale(0.12).color(1.2, 1.2, 1.25);
         else
            flake.identity().scale(0);
      });

      // Lights and fire
      const lampOn = g.open.lamp, fireOn = g.lit;
      bulb.color(...(lampOn ? [3, 2.6, 1.4] : [0.6, 0.6, 0.55]));
      lantern.color(...(lampOn ? [2.5, 2, 0.8] : [0.5, 0.45, 0.3]));
      const flicker = fireOn ? 0.8 + 0.2 * Math.sin(model.time * 17) * Math.sin(model.time * 7.3) : 0;
      flames.forEach((f, i) => {
         const [x, y, size] = FLAMES[i];
         const s = size * (0.6 + 0.4 * Math.min(g.fuel, 3) / 3);
         const h = s * (0.8 + 0.4 * Math.abs(Math.sin(model.time * (9 + i * 3))));
         if (fireOn)
            f.identity().move(fireSpot[0] + x, fireSpot[1] - 0.5 + y * h, fireSpot[2] - 0.2).scale(s * 0.8, h, s * 0.8).color(3, 1.2 + i * 0.3, 0.2);
         else
            f.identity().scale(0);
      });
      smoke.forEach((puff, i) => {
         const t = (model.time * 0.35 + i / smoke.length) % 1;
         if (fireOn)
            puff.identity().move(CHIMNEY[0] + 0.6 * t, 14.6 + 4 * t, CHIMNEY[1] + 0.3 * Math.sin(t * 6 + i))
                .scale(0.4 + 0.8 * t).color(0.75, 0.75, 0.78).opacity(0.7 * (1 - t));
         else
            puff.identity().scale(0);
      });
      const light = 0.65 + (lampOn ? 0.35 : 0) + 0.25 * flicker;
      for (const { node, color, inside } of paint)
         node.color(...color.map(v => v * (inside ? light : 1) * (glowSet.has(node) ? 1.6 : 1)));
      shade.color(...(lampOn ? [1.6, 1.4, 0.9] : glowSet.has(shade) ? [1.3, 1.25, 1] : [0.9, 0.85, 0.7]));
      opening.color(...(glowSet.has(opening) ? [0.5, 0.3, 0.15] : [0.08, 0.06, 0.05]));
      glass.forEach(gl => gl.color(...(lampOn || fireOn ? [1.4, 1.1, 0.5] : [0.7, 0.85, 1])).opacity(lampOn || fireOn ? 0.25 : 0.15));

      // Keep the controller balls small in the mini view
      clay.controllerBallSize = isMini() ? BALL_SIZE / SCALE : BALL_SIZE;

      // Your own avatar, when playing alone
      let view = null;
      try {
         view = clay.root().inverseViewMatrix(0);
      } catch (e) {}
      // Instructions panel: in front of you, a little below eye level
      if (pressEdge("stick", pressed("left", 3)))
         panelShown = !panelShown;
      if (view && panelShown) {
         const head = cg.mMultiply(clay.inverseRootMatrix, view);
         const yaw = Math.atan2(head[8], head[10]);
         panelYaw = panelYaw === null ? yaw : cg.mixAngle(panelYaw, yaw, Math.min(1, 2 * dt));
         const s = isMini() ? 1 / SCALE : 1;
         const at = cg.add(posOf(head), cg.mTransform(cg.mRotateY(panelYaw), [0, -0.3 * s, -0.6 * s]));
         panel.identity().move(at).turnY(panelYaw).turnX(-0.5).scale(0.22 * s);
      }
      else
         panel.identity().scale(0);

      const full = m => cg.mMultiply(lift(), cg.mMultiply(cg.mInverse(home), m));
      if (solo && !isMini() && view)
         poseAvatar(selfAvatar, miniBody(), full(view), ["left", "right"].map(h => handMatrix(h) && full(handMatrix(h))));
      else
         hideAvatar(selfAvatar);

      // Other players
      const others = players().filter(id => id !== clientID);
      otherAvatars.forEach((a, k) => {
         const id = others[k];
         const body = id !== undefined && window.hw8Bodies[id];
         if (!body || !body.m) {
            hideAvatar(a);
            return;
         }

         // Mini player: use their full-size head and hands
         if (body.head) {
            const hands = ["left", "right"].map(h => body[h] ? cg.unpackMatrix(body[h]) : null);
            poseAvatar(a, body.m, cg.unpackMatrix(body.head), hands);
            return;
         }

         // Giant: use clientState
         const head = clientState.head(id);
         if (!Array.isArray(head)) {
            hideAvatar(a);
            return;
         }
         const back = cg.mInverse(body.m);
         const hands = ["left", "right"].map(h => {
            const m = clientState.hand(id, h);
            return m ? cg.mMultiply(back, m) : null;
         });
         poseAvatar(a, body.m, cg.mMultiply(back, head), hands);
      });

      g2.update();
   });
};

export const deinit = () => {
   if (audio)
      audio.close();
   audio = wind = null;
   clay.controllerBallSize = BALL_SIZE;
   if (window.hw8Home)
      window.worldCoords = window.hw8Home;
   delete window.hw8Home;
};
