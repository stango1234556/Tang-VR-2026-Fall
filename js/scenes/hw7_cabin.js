import * as cg from "../render/core/cg.js";
import { G2 } from "../util/g2.js";
import { buttonState, controllerMatrix, joyStickState } from "../render/core/controllerInput.js";
import { lcb, rcb } from "../handle_scenes.js";

// A 1/12 scale cabin and a 1/12 scale you.
// B: switch views. Left stick: walk. Right stick: turn.
// Giant view: grab the cabin, or open the door. Mini view: use things in the cabin.

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
const TURN_SPEED = 1.8;
const BODY_R = 0.8;
const BALL_SIZE = 0.02;

// Windows: which wall, where along it, and how high.
const WINDOWS = [
   { wall: "left", u: [-1.5, 1.5], y: [3, 6] },
   { wall: "right", u: [-2.5, 0.5], y: [3, 6] },
   { wall: "back", u: [-2.5, 0.5], y: [3, 6] },
   { wall: "front", u: [3, 6], y: [3, 6] },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const posOf = m => m.slice(12, 15);

const cabinMatrix = (pos, yaw) => cg.mMultiply(cg.mTranslate(pos), cg.mMultiply(cg.mRotateY(yaw), cg.mScale(FT, FT, FT)));

// Each wall: where it is and which way is inside.
const WALLS = {
   left: { at: u => [-W / 2, 0, u], inward: [1, 0, 0], length: D, alongX: false },
   right: { at: u => [W / 2, 0, u], inward: [-1, 0, 0], length: D, alongX: false },
   back: { at: u => [u, 0, -D / 2], inward: [0, 0, 1], length: W, alongX: true },
   front: { at: u => [u, 0, D / 2], inward: [0, 0, -1], length: W, alongX: true },
};
const onWall = (wall, u, y, n = 0) => cg.add(cg.add(WALLS[wall].at(u), [0, y, 0]), cg.scale(WALLS[wall].inward, n));

export const init = async model => {
   if (!window.hw7Home)
      window.hw7Home = window.worldCoords.slice();
   const home = window.hw7Home;

   // Saved state
   if (!window.hw7State || window.hw7State.version !== 3)
      window.hw7State = {
         version: 3,
         mini: false,
         avatar: [TABLE.x - 0.3, TABLE.y, TABLE.z + 0.05],
         cabinPos: [TABLE.x + 0.25, TABLE.y, TABLE.z],
         cabinYaw: 0,
      };
   const S = window.hw7State;
   S.yaw = S.yaw || 0;
   S.open = S.open || {};

   const setWorld = W => {
      window.worldCoords = W;
      clay.root().setMatrix(W);
      clay.inverseRootMatrix = cg.mInverse(W);
   };

   // Makes your eyes count as being at EYE_HEIGHT.
   let heightFix = S.heightFix ?? null;
   const measureHeight = () => {
      try {
         const eye = cg.mMultiply(cg.mInverse(home), clay.root().inverseViewMatrix(0))[13];
         if (eye > 0.5)
            heightFix = S.heightFix = EYE_HEIGHT - eye;
      } catch (e) {}
   };
   const lift = () => cg.mTranslate(0, heightFix || 0, 0);

   // From real size to mini size
   const toMini = () => cg.mMultiply(cg.mTranslate(S.avatar), cg.mMultiply(cg.mRotateY(S.yaw),
                        cg.mMultiply(cg.mScale(1 / SCALE, 1 / SCALE, 1 / SCALE), cg.mMultiply(lift(), cg.mInverse(home)))));

   // The world in the mini view
   const miniWorld = () => cg.mInverse(toMini());

   const box = (parent, x, y, z, w, h, d, color) => parent.add("cube").move(x, y, z).scale(w / 2, h / 2, d / 2).color(...color);

   // Room and table

   model.add("cube").move(0, -0.01, -1).scale(4, 0.01, 4).color(0.35, 0.33, 0.3);
   for (const [x, z, w, d] of [[0, -5, 4, 0.05], [0, 3, 4, 0.05], [-4, -1, 0.05, 4], [4, -1, 0.05, 4]])
      model.add("cube").move(x, 1.5, z).scale(w, 1.5, d).color(0.75, 0.75, 0.72);
   model.add("cube").move(0, 1.6, -4.94).scale(1.6, 0.6, 0.01).color(0.95, 0.95, 0.95);     // whiteboard
   model.add("cube").move(-3.94, 1.7, -1.5).scale(0.01, 0.7, 1).color(0.55, 0.75, 0.95);    // window
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
   for (const [y, turn] of [[0.2, 0.2], [0.32, -0.25]])
      reg(cabin.add("tubeZ").move(5, FLOOR + y, FZ + 0.25).turnY(Math.PI / 2 + turn).scale(0.15, 0.15, 0.9), [0.35, 0.22, 0.12]);
   part(cabin, 5, FLOOR + 0.07, FZ + 1.5, 5, 0.14, 1, [0.6, 0.58, 0.56]);
   part(cabin, 5, FLOOR + 3.65, FZ + 0.1, 4.6, 0.3, 2.4, [0.4, 0.27, 0.16]);
   part(cabin, CHIMNEY[0], 9, CHIMNEY[1], 1.6, 10, 1.6, STONE);
   part(cabin, CHIMNEY[0], 14.1, CHIMNEY[1], 2, 0.3, 2, [0.42, 0.42, 0.44]);
   const smoke = [0, 1, 2, 3].map(() => cabin.add("sphere"));
   const FLAMES = [[0, 0.7, 0.5], [-0.4, 0.5, 0.4], [0.4, 0.55, 0.4]];
   const flames = FLAMES.map(() => cabin.add("sphere"));
   const fireSpot = [5, FLOOR + 0.9, FZ + 0.2];

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

   // Things you can use. Only the door works in the giant view.
   const amount = {};
   const ease = (name, dt) => {
      const target = S.open[name] ? 1 : 0;
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

   // Mini avatar
   const SKIN = [0.96, 0.8, 0.66], HAIR = [0.3, 0.18, 0.1], SHIRT = [0.85, 0.2, 0.2], PANTS = [0.2, 0.3, 0.65];
   const bodyPart = shape => model.add(shape);
   const avatar = {
      face: bodyPart("sphere"), hair: bodyPart("sphere"), headset: bodyPart("cube"), lens: bodyPart("cube"),
      torso: bodyPart("tubeY"), hips: bodyPart("sphere"),
      shoulders: [bodyPart("sphere"), bodyPart("sphere")],
      upperArms: [bodyPart("tubeZ"), bodyPart("tubeZ")], forearms: [bodyPart("tubeZ"), bodyPart("tubeZ")],
      fists: [bodyPart("sphere"), bodyPart("sphere")], controllers: [bodyPart("cube"), bodyPart("cube")],
      legs: [bodyPart("tubeZ"), bodyPart("tubeZ")], shoes: [bodyPart("cube"), bodyPart("cube")],
   };
   const allParts = Object.values(avatar).flat();

   // Control panel

   const g2 = new G2();
   model.txtrSrc(2, g2.getCanvas());
   model.add("square").txtr(2).move(TABLE.x, TABLE.y + 0.5, TABLE.z - 0.45).scale(0.3);
   const line = (text, y, h) => {
      g2.textHeight(h);
      const w = 2 * g2.getContext().measureText(text).width / g2.getCanvas().width;
      if (w > 1.85)
         g2.textHeight(h * 1.85 / w);
      g2.text(text, 0, y, "center");
   };
   g2.render = function () {
      this.setColor([0.1, 0.1, 0.14, 0.9]).fillRect(-1, -0.5, 2, 1);
      this.setColor(S.mini ? [1, 0.85, 0.4] : [0.6, 0.85, 1]);
      line(S.mini ? "MINI VIEW" : "GIANT VIEW", 0.33, 0.1);
      this.setColor("white");
      line("B: switch view     Sticks: walk and turn", 0.13, 0.07);
      if (S.mini)
         line("Trigger near something: use it", -0.05, 0.07);
      else {
         line("Grip or trigger: carry the cabin", -0.05, 0.07);
         line("Trigger at the door: open it", -0.22, 0.07);
      }
   };

   // Window glass, made last so you can see through it
   const glassGroup = model.add();
   const glass = glassSpots.map(g => glassGroup.add("cube").move(...g.at).scale(...g.size));

   // Input and movement

   const handMatrix = hand => controllerMatrix[hand] && controllerMatrix[hand].length ? controllerMatrix[hand] : null;
   const pressed = (hand, b) => buttonState[hand][b] && buttonState[hand][b].pressed;
   const wasDown = {};
   const pressEdge = (key, down) => {
      const edge = down && !wasDown[key];
      wasDown[key] = down;
      return edge;
   };
   const toCabin = p => cg.mTransform(cg.mInverse(cabinMatrix(S.cabinPos, S.cabinYaw)), p);

   // Walls block walking, except the open doorway
   const blocked = p => {
      const l = toCabin(p);
      const nearSide = Math.abs(Math.abs(l[0]) - W / 2) < BODY_R && Math.abs(l[2]) < D / 2 + BODY_R;
      const nearEnd = Math.abs(Math.abs(l[2]) - D / 2) < BODY_R && Math.abs(l[0]) < W / 2 + BODY_R;
      const doorway = S.open.door && l[2] > 0 && Math.abs(l[0]) < DOOR_W / 2 - 0.3;
      return (nearSide || nearEnd) && !doorway;
   };

   // Floor height under the avatar
   const floorAt = p => {
      const l = toCabin(p);
      const inCabin = Math.abs(l[0]) < W / 2 && Math.abs(l[2]) < D / 2;
      const onPorch = Math.abs(l[0]) < 4 && l[2] >= D / 2 && l[2] < D / 2 + 4;
      return S.cabinPos[1] + (inCabin || onPorch ? FLOOR * FT : 0);
   };

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
      const step = cg.scale(cg.add(cg.scale(right, x), cg.scale(forward, -y)), WALK_SPEED * dt);
      for (const tryStep of [step, [step[0], 0, 0], [0, 0, step[2]]]) {
         const next = onTable(cg.add(S.avatar, tryStep));
         if (!blocked(next) || blocked(S.avatar)) {
            S.avatar = next;
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
      const before = posOf(cg.mMultiply(toMini(), view));
      S.yaw -= x * TURN_SPEED * dt;
      const after = posOf(cg.mMultiply(toMini(), view));
      S.avatar = [S.avatar[0] + before[0] - after[0], S.avatar[1], S.avatar[2] + before[2] - after[2]];
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
         if (!S.mini && !t.giant)
            continue;
         const d = cg.distance(h, t.spot()) / (t.reach * (S.mini ? 1 : 2));
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

   // Carrying the cabin

   let held = null;

   const handScene = hand => {
      const m = handMatrix(hand);
      return m ? posOf(cg.mMultiply(clay.inverseRootMatrix, m)) : null;
   };

   const tryGrab = hand => {
      const l = handInCabin(hand);
      if (!l || Math.abs(l[0]) > W / 2 + 2 || Math.abs(l[2]) > D / 2 + 4 || l[1] < -2 || l[1] > 15)
         return;
      const avatarLocal = toCabin(S.avatar);
      const avatarInside = Math.abs(avatarLocal[0]) < W / 2 && avatarLocal[2] > -D / 2 && avatarLocal[2] < D / 2 + 4;
      held = { hand, offset: cg.subtract(S.cabinPos, handScene(hand)), avatar: avatarInside ? avatarLocal : null };
   };

   const moveHeld = dt => {
      const hand = handScene(held.hand);
      if (!hand)
         return;
      const pos = cg.add(hand, held.offset);
      S.cabinPos = [pos[0], Math.max(TABLE.y, pos[1]), pos[2]];
      S.cabinYaw -= (joyStickState.right.x || 0) * TURN_SPEED * dt;
      if (held.avatar)
         S.avatar = cg.mTransform(cabinMatrix(S.cabinPos, S.cabinYaw), held.avatar);
   };

   const drop = () => {
      const p = onTable(S.cabinPos);
      S.cabinPos = [p[0], TABLE.y, p[2]];
      if (held.avatar)
         S.avatar = onTable(cg.mTransform(cabinMatrix(S.cabinPos, S.cabinYaw), held.avatar));
      held = null;
   };

   // Posing the avatar
   const UPPER_ARM = 0.28, FOREARM = 0.27;

   const poseAvatar = view => {
      const full = m => cg.mMultiply(lift(), cg.mMultiply(cg.mInverse(home), m));
      const M = cg.mMultiply(cg.mTranslate(S.avatar), cg.mMultiply(cg.mRotateY(S.yaw), cg.mScale(1 / SCALE, 1 / SCALE, 1 / SCALE)));
      const headM = cg.mMultiply(M, full(view));
      const eye = posOf(full(view));
      const fwd = cg.normalize([-view[8], 0, -view[10]]);
      const right = [-fwd[2], 0, fwd[0]];
      const yaw = Math.atan2(-fwd[0], -fwd[2]);

      // Head
      avatar.face.setMatrix(headM).move(0, 0, 0.05).scale(0.09, 0.105, 0.1).color(...SKIN);
      avatar.hair.setMatrix(headM).move(0, 0.025, 0.065).scale(0.09).color(...HAIR);
      avatar.headset.setMatrix(headM).move(0, 0.01, -0.05).scale(0.09, 0.045, 0.045).color(0.12, 0.12, 0.14);
      avatar.lens.setMatrix(headM).move(0, 0.01, -0.096).scale(0.075, 0.03, 0.004).color(0.2, 0.8, 1.2);

      // Body
      const neck = cg.add(eye, cg.add(cg.scale(fwd, -0.07), [0, -0.16, 0]));
      const chest = neck[1] - 0.04;
      const hip = [neck[0], Math.max(0.15, Math.min(0.53 * MY_HEIGHT, neck[1] - 0.4)), neck[2]];
      avatar.torso.setMatrix(M).move(neck[0], (hip[1] + chest) / 2, neck[2]).turnY(yaw).scale(0.15, (chest - hip[1]) / 2, 0.09).color(...SHIRT);
      avatar.hips.setMatrix(M).move(hip).turnY(yaw).scale(0.15, 0.08, 0.09).color(...PANTS);

      // Arms
      ["left", "right"].forEach((hand, i) => {
         const side = i ? 1 : -1;
         const shoulder = cg.add([neck[0], chest - 0.03, neck[2]], cg.scale(right, side * 0.17));
         const m = handMatrix(hand);
         let wrist = m ? posOf(full(m)) : cg.add(shoulder, [0, -(UPPER_ARM + FOREARM) * 0.95, 0]);
         const reach = cg.subtract(wrist, shoulder);
         const dist = Math.min(cg.norm(reach), (UPPER_ARM + FOREARM) * 0.999);
         const dir = cg.normalize(reach);
         wrist = cg.add(shoulder, cg.scale(dir, dist));

         let bend = cg.add([0, -1, 0], cg.add(cg.scale(right, side * 0.4), cg.scale(fwd, -0.3)));
         bend = cg.subtract(bend, cg.scale(dir, cg.dot(bend, dir)));
         bend = cg.norm(bend) > 0.01 ? cg.normalize(bend) : cg.scale(right, side);
         const out = Math.sqrt(Math.max(0, UPPER_ARM * UPPER_ARM - (dist / 2) * (dist / 2)));
         const elbow = cg.add(cg.add(shoulder, cg.scale(dir, dist / 2)), cg.scale(bend, out));

         avatar.shoulders[i].setMatrix(M).move(shoulder).scale(0.05).color(...SHIRT);
         avatar.upperArms[i].setMatrix(M).link(shoulder, elbow, 0.045).color(...SHIRT);
         avatar.forearms[i].setMatrix(M).link(elbow, wrist, 0.037).color(...SKIN);
         avatar.fists[i].setMatrix(M).move(wrist).scale(0.045).color(...SKIN);
         if (m)
            avatar.controllers[i].setMatrix(cg.mMultiply(M, full(m))).scale(0.02, 0.03, 0.05).color(0.15, 0.15, 0.17);
         else
            avatar.controllers[i].identity().scale(0);

         // Legs
         const hipSide = cg.add(hip, cg.scale(right, side * 0.08));
         const foot = [hipSide[0], 0.06, hipSide[2]];
         avatar.legs[i].setMatrix(M).link(hipSide, foot, 0.06).color(...PANTS);
         avatar.shoes[i].setMatrix(M).move(cg.add([foot[0], 0.04, foot[2]], cg.scale(fwd, 0.04))).turnY(yaw).scale(0.05, 0.04, 0.11).color(0.95, 0.95, 0.95);
      });
   };

   // Every frame

   if (S.mini)
      setWorld(miniWorld());
   let lastTime = model.time;

   model.animate(() => {
      const dt = clamp(model.time - lastTime, 0, 0.05) || 0;
      lastTime = model.time;

      // Switch views
      if (heightFix === null && !S.mini)
         measureHeight();
      if (pressEdge("B", pressed("right", 5))) {
         if (held)
            drop();
         if (!S.mini)
            measureHeight();
         S.mini = !S.mini;
         setWorld(S.mini ? miniWorld() : home);
      }

      // Move
      walk(dt);
      if (!held)
         turn(dt);
      if (!held)
         S.avatar[1] = floorAt(S.avatar);
      if (S.mini)
         setWorld(miniWorld());

      // Use or grab
      glowSet.clear();
      for (const hand of ["left", "right"]) {
         const near = (!S.mini && !held && beamThing(hand)) || nearestThing(hand);
         if (near)
            near.glow.forEach(n => glowSet.add(n));
         const trigger = pressEdge(hand + "trigger", pressed(hand, 0));
         const grip = pressEdge(hand + "grip", pressed(hand, 1));
         if (trigger && near)
            S.open[near.name] = !S.open[near.name];
         else if (!S.mini && !held && (trigger || grip))
            tryGrab(hand);
         if (held && held.hand === hand && !pressed(hand, 0) && !pressed(hand, 1))
            drop();
      }
      if (held)
         moveHeld(dt);

      // Animate
      cabin.identity().move(S.cabinPos).turnY(S.cabinYaw).scale(FT);
      glassGroup.identity().move(S.cabinPos).turnY(S.cabinYaw).scale(FT);
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
      curtains.forEach((c, i) => {
         const closed = ease("curtain" + i, dt);
         const { wall, u, y } = c.win;
         const wu = u[1] - u[0];
         const width = 0.6 + (wu / 2 + 0.2 - 0.6) * closed;
         c.panels.forEach((p, k) => {
            const edge = k ? u[1] + 0.3 : u[0] - 0.3;
            const center = edge + (k ? -1 : 1) * width / 2;
            const at = onWall(wall, center, (y[0] + y[1]) / 2, WALL / 2 + 0.25);
            const size = WALLS[wall].alongX ? [width, y[1] - y[0] + 0.6, 0.08] : [0.08, y[1] - y[0] + 0.6, width];
            p.identity().move(...at).scale(size[0] / 2, size[1] / 2, size[2] / 2);
         });
      });

      // Lights and fire
      const lampOn = S.open.lamp, fireOn = S.open.fire;
      bulb.color(...(lampOn ? [3, 2.6, 1.4] : [0.6, 0.6, 0.55]));
      lantern.color(...(lampOn ? [2.5, 2, 0.8] : [0.5, 0.45, 0.3]));
      const flicker = fireOn ? 0.8 + 0.2 * Math.sin(model.time * 17) * Math.sin(model.time * 7.3) : 0;
      flames.forEach((f, i) => {
         const [x, y, s] = FLAMES[i];
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
         node.color(...color.map(c => c * (inside ? light : 1) * (glowSet.has(node) ? 1.6 : 1)));
      shade.color(...(lampOn ? [1.6, 1.4, 0.9] : glowSet.has(shade) ? [1.3, 1.25, 1] : [0.9, 0.85, 0.7]));
      opening.color(...(glowSet.has(opening) ? [0.5, 0.3, 0.15] : [0.08, 0.06, 0.05]));
      glass.forEach(g => g.color(...(lampOn || fireOn ? [1.4, 1.1, 0.5] : [0.7, 0.85, 1])).opacity(lampOn || fireOn ? 0.25 : 0.15));

      // Keep the controller balls small in the mini view
      clay.controllerBallSize = S.mini ? BALL_SIZE / SCALE : BALL_SIZE;

      // Hide the avatar in the mini view
      let view = null;
      try {
         view = clay.root().inverseViewMatrix(0);
      } catch (e) {}
      if (S.mini || !view)
         allParts.forEach(p => p.identity().scale(0));
      else
         poseAvatar(view);

      g2.update();
   });
};

export const deinit = () => {
   clay.controllerBallSize = BALL_SIZE;
   if (window.hw7Home)
      window.worldCoords = window.hw7Home;
   delete window.hw7Home;
};
