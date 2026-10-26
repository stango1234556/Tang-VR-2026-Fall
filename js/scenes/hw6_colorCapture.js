import * as cg from "../render/core/cg.js";
import { G2 } from "../util/g2.js";
import { loadSound, playSoundAtPosition } from "../util/positional-audio.js";
import { fitText, buttonFont, vrControls, restoreHome, isGameMaster } from "./hw6_controls.js";

const ROOM = 2.4;          // half the room's width
const CEILING = 3;
const R = 0.15;            // ball radius
const MAX_BALLS = 80;
const HIT_SPEED = 3;
const GRAVITY = 1;
const FLOOR_KICK = 1.8;    // upward speed after every floor bounce
const MIN_SPEED = 1;
const MAX_SPEED = 3;
const GRAY = [0.6, 0.6, 0.65];
const HOMES = [[1.6, 0, 1.6], [-1.6, 0, -1.6], [-1.6, 0, 1.6], [1.6, 0, -1.6]];
const ROOM_AREA = { x: [-ROOM + 0.2, ROOM - 0.2], z: [-ROOM + 0.2, ROOM - 0.2] };
const PALETTE = Array.from({ length: 12 }, (_, i) => i / 12);
const DEFAULT_HUES = [PALETTE[0], PALETTE[7], PALETTE[4], PALETTE[2]];

// Swatch i on a pedestal panel, 4 across and 3 down: [x, y, width, height].
const swatchRect = i => [-0.76 + (i % 4) * 0.38, -0.42 - Math.floor(i / 4) * 0.23, 0.34, 0.19];

const soundBuffer = [];
for (let i = 0; i < 6; i++)
   loadSound('../../media/sound/bounce/' + i + '.wav', buffer => soundBuffer[i] = buffer);

// Turns a hue (0 to 1) into an [r, g, b] color.
const hsv = (h, s, v) => {
   const f = n => {
      const k = (n + h * 6) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
   };
   return [f(5), f(3), f(1)];
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, n) => Math.round(v * n) / n;
const randomVel = () => [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5];

const newState = () => ({
   phase: "lobby",   // lobby, playing or done
   time: 0,
   length: 60,
   count: 40,
   balls: [],        // each ball is [x, y, z, owner, lit, vx, vy, vz]; owner -1 means nobody
   hues: DEFAULT_HUES.slice(),
   ready: [false, false, false, false],
   scores: [0, 0, 0, 0],
   winner: -1,       // -2 means a tie
});

export const init = async model => {
   server.init("ccMsgs", {});
   if (!window.ccState)
      window.ccState = newState();
   const S = () => window.ccState;
   if (S().phase !== "playing")
      S().balls = [];

   const players = () => (window.clients || []).slice(0, 4);
   const mySlot = () => window.clients && window.clientID !== undefined ? clients.indexOf(clientID) : -1;
   const send = msg => server.send("ccMsgs", msg);
   const colorOf = slot => hsv(S().hues[slot], 0.85, 0.9);

   // ---- Game logic, run by the master ----

   // Ball speeds are only kept by the master.
   const vel = [];
   const litTime = [];

   const start = () => {
      const s = S();
      s.phase = "playing";
      s.time = s.length;
      s.ready = [false, false, false, false];
      s.winner = -1;
      s.scores = [0, 0, 0, 0];
      s.balls = [];
      vel.length = 0;
      litTime.length = 0;
      for (let i = 0; i < s.count; i++) {
         const x = (Math.random() * 2 - 1) * (ROOM - R);
         const y = 0.5 + Math.random() * 2;
         const z = (Math.random() * 2 - 1) * (ROOM - R);
         s.balls.push([x, y, z, -1, 0]);
         vel.push(randomVel());
         litTime.push(0);
      }
   };

   const handle = (msg, slot) => {
      const s = S();
      const lobby = s.phase !== "playing";
      if (msg.op === "ready" && slot === msg.slot && lobby)
         s.ready[slot] = !s.ready[slot];
      if (msg.op === "hue" && slot === msg.slot)
         s.hues[slot] = clamp(msg.hue, 0, 1);
      if (msg.op === "count" && lobby)
         s.count = Math.round(20 + 60 * clamp(msg.value, 0, 1));
      if (msg.op === "length" && lobby)
         s.length = Math.round(30 + 90 * clamp(msg.value, 0, 1));
      if (msg.op === "start")
         start();

      const b = s.balls[msg.ball];
      if (msg.op === "hit" && b && slot >= 0 && !lobby) {
         vel[msg.ball] = cg.scale(cg.normalize(msg.dir), HIT_SPEED);
         b[3] = slot;
         litTime[msg.ball] = 0.15;
      }
   };

   const step = dt => {
      const s = S();
      const balls = s.balls;
      while (vel.length < balls.length) {
         vel.push([0, 0, 0]);
         litTime.push(0);
      }

      // Balls bounce off each other.
      for (let i = 0; i < balls.length - 1; i++)
         for (let j = i + 1; j < balls.length; j++) {
            const d = cg.subtract(balls[j].slice(0, 3), balls[i].slice(0, 3));
            const dist = cg.norm(d);
            if (dist > 0 && dist < 2 * R) {
               const n = cg.scale(d, 1 / dist);
               const vi = cg.dot(vel[i], n);
               const vj = cg.dot(vel[j], n);
               if (vi - vj > 0) {
                  vel[i] = cg.add(vel[i], cg.scale(n, vj - vi));
                  vel[j] = cg.add(vel[j], cg.scale(n, vi - vj));
               }
            }
         }

      // Balls bounce off the walls, the floor kicks them back up, and their speed stays lively.
      const lo = [-ROOM + R, R, -ROOM + R];
      const hi = [ROOM - R, CEILING - R, ROOM - R];
      balls.forEach((b, i) => {
         for (let k = 0; k < 3; k++) {
            if (b[k] < lo[k])
               vel[i][k] = Math.abs(vel[i][k]);
            if (b[k] > hi[k])
               vel[i][k] = -Math.abs(vel[i][k]);
         }
         if (b[1] < lo[1])
            vel[i][1] = Math.max(vel[i][1], FLOOR_KICK);
         vel[i][1] -= GRAVITY * dt;

         const speed = cg.norm(vel[i]);
         if (speed > MAX_SPEED)
            vel[i] = cg.scale(vel[i], 1 - 0.5 * dt);
         else if (speed < MIN_SPEED)
            vel[i] = speed > 0.01 ? cg.scale(vel[i], MIN_SPEED / speed) : [0, MIN_SPEED, 0];

         for (let k = 0; k < 3; k++) {
            b[k] = round(b[k] + vel[i][k] * dt, 1000);
            b[5 + k] = round(vel[i][k], 100);
         }
         litTime[i] -= dt;
         b[4] = litTime[i] > 0 ? 1 : 0;
      });

      // Start when everyone is ready. When time runs out, clear the balls and pick a winner.
      const present = players().length;
      if (s.phase !== "playing" && present > 0 && s.ready.slice(0, present).every(r => r))
         start();
      if (s.phase === "playing") {
         s.scores = [0, 1, 2, 3].map(slot => balls.filter(b => b[3] === slot).length);
         s.time = Math.max(0, s.time - dt);
         if (s.time === 0) {
            s.phase = "done";
            s.balls = [];
            const scores = s.scores.slice(0, present);
            const best = Math.max(...scores);
            const leaders = scores.filter(v => v === best).length;
            s.winner = leaders === 1 ? scores.indexOf(best) : -2;
         }
      }
   };

   // ---- The room ----

   model.add("cube").move(0, -0.01, 0).scale(ROOM, 0.01, ROOM).color(0.18, 0.18, 0.22);
   for (const x of [-ROOM, ROOM])
      for (const z of [-ROOM, ROOM])
         model.add("tubeY").move(x, CEILING / 2, z).scale(0.02, CEILING / 2, 0.02).color(0.5, 0.5, 0.6);
   const homeRings = HOMES.map(h => model.add("diskY").move(h[0], 0.002, h[2]).scale(0.35, 0.001, 0.35));

   const ballNodes = [];
   for (let i = 0; i < MAX_BALLS; i++)
      ballNodes.push(model.add("sphere"));

   // ---- Panels ----

   // The pedestals and kiosk are grouped so they can hide during a round.
   const ui = model.add();
   const panels = [];

   // Each player's pedestal stands in front of their corner, facing them.
   const pedestals = HOMES.map((home, k) => {
      const toCenter = cg.normalize(cg.scale(home, -1));
      const pos = cg.add(home, cg.scale(toCenter, 0.65));
      const yaw = Math.atan2(-toCenter[0], -toCenter[2]);
      ui.add("cube").move(pos[0], 0.45, pos[2]).scale(0.04, 0.45, 0.04).color(0.3, 0.3, 0.35);

      const g2 = new G2();
      model.txtrSrc(2 + k, g2.getCanvas());
      const panel = ui.add("square").txtr(2 + k).move(pos[0], 1.15, pos[2]).turnY(yaw).turnX(-0.45).scale(0.26);
      panels.push(panel);

      g2.render = function () {
         const s = S();
         const present = k < players().length;
         let state = "not ready";
         if (!present)
            state = "empty";
         else if (s.phase === "playing")
            state = "balls owned";
         else if (s.ready[k])
            state = "READY!";

         this.setColor([0.1, 0.1, 0.14]).fillRect(-1, -1, 2, 2);
         this.setColor(colorOf(k)).fillRect(-1, 0.72, 2, 0.28);
         this.setColor("black");
         fitText(this, `PLAYER ${k + 1}${mySlot() === k ? " (YOU)" : ""}`, 0, 0.86, 0.12);
         this.setColor("white");
         fitText(this, present ? `${s.scores[k]}` : "-", -0.45, 0.52, 0.15, 0.8);
         fitText(this, state, 0.4, 0.52, 0.085, 1);
         fitText(this, "pick your color:", 0, -0.1, 0.07);

         // Color swatches: aim at one and pull the trigger to pick it.
         const uvz = this.getUVZ(panel);
         PALETTE.forEach((hue, i) => {
            const [x, y, w, h] = swatchRect(i);
            const hovered = uvz && uvz[0] > x && uvz[0] < x + w && uvz[1] > y && uvz[1] < y + h;
            const picked = Math.abs(s.hues[k] - hue) < 0.01;
            const takenBy = s.hues.findIndex((other, j) => j !== k && j < players().length && Math.abs(other - hue) < 0.01);

            if (hovered && this.mouseState() === "press")
               send({ op: "hue", slot: k, hue });
            if (picked || hovered)
               this.setColor(picked ? "white" : [0.6, 0.6, 0.6]).fillRect(x - 0.025, y - 0.025, w + 0.05, h + 0.05);
            this.setColor(hsv(hue, 0.85, 0.9)).fillRect(x, y, w, h);
            if (takenBy >= 0)
               this.setColor("black").textHeight(0.06).text(`P${takenBy + 1}`, x + w / 2, y + h / 2, "center");
         });
         buttonFont(this, 2.6);
      };
      g2.addWidget(panel, "button", 0, 0.17, "#ffffff", ["  READY  "], () => send({ op: "ready", slot: k }), 2.6);
      return g2;
   });

   // The kiosk in the middle has the round settings and START. It turns to face you.
   ui.add("cube").move(0, 0.45, 0).scale(0.05, 0.45, 0.05).color(0.3, 0.3, 0.35);
   const kioskG2 = new G2();
   model.txtrSrc(6, kioskG2.getCanvas());
   const kiosk = ui.add("square").txtr(6);
   panels.push(kiosk);

   kioskG2.render = function () {
      const s = S();
      this.setColor([0.12, 0.12, 0.16]).fillRect(-1, -1, 2, 2);
      this.setColor("white");
      fitText(this, "COLOR CAPTURE", 0, 0.84, 0.12);
      if (s.phase === "playing")
         fitText(this, "Game on! Hit the balls!", 0, 0.64, 0.075);
      else {
         fitText(this, "Press READY at your pedestal,", 0, 0.68, 0.07);
         fitText(this, "or START here", 0, 0.56, 0.07);
      }
      fitText(this, `${s.count} balls`, 0, 0.38, 0.08);
      fitText(this, `${s.length} seconds`, 0, -0.06, 0.08);
      this.setColor([0.7, 0.7, 0.75]);
      fitText(this, "Left trigger: scene menu", 0, -0.9, 0.065);
      buttonFont(this, 2.8);
   };
   kioskG2.addWidget(kiosk, "button", 0, -0.64, "#ffd060", ["  START  "], () => send({ op: "start" }), 2.8);
   const countSlider = kioskG2.addWidget(kiosk, "slider", 0, 0.17, "#80c0ff", "balls", value => send({ op: "count", value }), 2.6);
   const lengthSlider = kioskG2.addWidget(kiosk, "slider", 0, -0.27, "#80ffa0", "time", value => send({ op: "length", value }), 2.6);

   // The board up top shows the time left and everyone's score.
   const boardG2 = new G2();
   model.txtrSrc(7, boardG2.getCanvas());
   const board = model.add("square").txtr(7);

   boardG2.render = function () {
      const s = S();
      let title = "WAITING";
      if (s.phase === "playing")
         title = `${Math.ceil(s.time)}`;
      else if (s.phase === "done")
         title = s.winner >= 0 ? `PLAYER ${s.winner + 1} WINS!` : "TIE!";

      this.setColor([0, 0, 0, 0.6]).fillRect(-1, -1, 2, 2);
      this.setColor("white");
      fitText(this, title, 0, 0.6, s.phase === "playing" ? 0.3 : 0.16, 1.8);
      const total = Math.max(1, s.count);
      for (let k = 0; k < players().length; k++) {
         const y = 0.08 - k * 0.24;
         this.setColor([0.25, 0.25, 0.3]).fillRect(-0.85, y, 1.7, 0.18);
         this.setColor(colorOf(k)).fillRect(-0.85, y, 1.7 * s.scores[k] / total, 0.18);
         this.setColor("white");
         fitText(this, `P${k + 1}: ${s.scores[k]}`, 0, y + 0.09, 0.1);
      }
   };

   const controls = vrControls(model, panels);
   for (const g2 of [...pedestals, kioskG2])
      controls.usePointer(g2);

   // Each player stands in their own corner, facing the middle.
   const mySpot = slot => {
      const home = HOMES[slot];
      const d = cg.normalize(cg.scale(home, -1));
      return cg.mMultiply(cg.mRotateY(Math.atan2(d[0], -d[2])), cg.mTranslate(cg.scale(home, -1)));
   };

   const faceViewer = node => {
      try {
         node.faceViewer();
      } catch (e) {}
   };

   // ---- Every frame ----

   let lastTime = model.time;
   let frame = 0;
   let wasMaster = false;
   let lastState = null;
   let stateTime = 0;
   const shown = [];    // where each ball was last drawn
   const myHits = [];   // balls I hit recently: { pos, vel, time, until }
   const wasLit = [];

   // Where a ball would be after t seconds, kept inside the room.
   const predict = (from, v, t) => [0, 1, 2].map(k => {
      const fall = k === 1 ? 0.5 * GRAVITY * t * t : 0;
      const edge = k === 1 ? [R, CEILING - R] : [-ROOM + R, ROOM - R];
      return clamp(from[k] + v[k] * t - fall, edge[0], edge[1]);
   });

   // My hands and head, which can hit balls.
   const myBodies = () => {
      const bodies = [];
      for (const hand of ["left", "right"]) {
         const f = clientState.finger(clientID, hand, 1);
         if (f)
            bodies.push({ pos: f, r: R });
      }
      const head = clientState.head(clientID);
      if (Array.isArray(head))
         bodies.push({ pos: head.slice(12, 15), r: R + 0.15 });
      return bodies;
   };

   model.animate(() => {
      const dt = clamp(model.time - lastTime, 0, 0.05) || 0;
      lastTime = model.time;

      // A client that just took over continues from the shared ball speeds.
      const master = isGameMaster();
      if (master && !wasMaster) {
         vel.length = 0;
         for (const b of S().balls)
            vel.push(b.length > 5 ? b.slice(5, 8) : [0, 0, 0]);
      }
      wasMaster = master;

      server.sync("ccMsgs", (msgs, id) => {
         if (master)
            for (const msg of Object.values(msgs))
               handle(msg, players().indexOf(id));
      });

      // The master runs the game and shares it about 36 times a second.
      if (master) {
         step(dt);
         if (frame++ % 2 === 0)
            server.broadcastGlobal("ccState");
      }

      const s = S();
      if (s !== lastState) {
         lastState = s;
         stateTime = model.time;
      }
      const ahead = Math.min(model.time - stateTime, 0.2);
      const me = mySlot();
      const bodies = me >= 0 && me < 4 && s.phase === "playing" ? myBodies() : [];

      let sounds = 0;
      for (let i = 0; i < MAX_BALLS; i++) {
         const b = s.balls[i];
         if (!b) {
            ballNodes[i].identity().scale(0);
            shown[i] = null;
            continue;
         }

         // Other players get updates only now and then, so between updates a ball keeps moving
         // at its last speed and eases toward where it should be. A ball I just hit follows my hit.
         let p = b.slice(0, 3);
         const mine = myHits[i] && model.time < myHits[i].until ? myHits[i] : null;
         if (!master && (b.length > 5 || mine)) {
            const goal = mine ? predict(mine.pos, mine.vel, model.time - mine.time) : predict(p, b.slice(5, 8), ahead);
            const prev = shown[i];
            p = prev && cg.distance(prev, goal) < 0.5 ? prev.map((x, k) => x + (goal[k] - x) * 0.4) : goal;
            shown[i] = p;
         }

         // I check my own hits and tell the master.
         const cooling = () => myHits[i] && model.time < myHits[i].time + 0.25;
         for (const body of bodies)
            if (cg.distance(p, body.pos) < body.r && !cooling()) {
               const dir = cg.normalize(cg.subtract(p, body.pos));
               myHits[i] = { pos: p.slice(), vel: cg.scale(dir, HIT_SPEED), time: model.time, until: model.time + 0.3 };
               const msg = { op: "hit", ball: i, dir: dir.map(x => round(x, 100)) };
               if (master)
                  handle(msg, me);
               else
                  send(msg);
            }

         const owner = mine ? me : b[3];
         const color = owner < 0 ? GRAY : hsv(s.hues[owner], 0.85, b[4] || mine ? 1 : 0.75);
         ballNodes[i].identity().move(p).scale(R).color(...color);
         if (b[4] && !wasLit[i] && sounds++ < 3 && soundBuffer.length)
            playSoundAtPosition(soundBuffer[6 * Math.random() >> 0], b.slice(0, 3));
         wasLit[i] = b[4];
      }

      homeRings.forEach((ring, k) => ring.color(...(k < players().length ? colorOf(k) : [0.3, 0.3, 0.3])));

      // The panels only show between rounds. The kiosk holds still while someone is using it.
      const showUI = s.phase !== "playing";
      ui.identity().scale(showUI ? 1 : 0);
      if (showUI && !kioskG2.isActiveWidget()) {
         kiosk.identity().move(0, 1.25, 0);
         faceViewer(kiosk);
         kiosk.scale(0.3);
      }
      board.identity().move(0, 2.5, 0);
      faceViewer(board);
      board.scale(0.42);

      // The sliders show the shared values, unless someone is dragging one.
      if (!kioskG2.isActiveWidget()) {
         countSlider.setValue((s.count - 20) / 60);
         lengthSlider.setValue((s.length - 30) / 90);
      }

      const g2s = showUI ? [...pedestals, kioskG2, boardG2] : [boardG2];
      controls.update(g2s, me >= 0 ? mySpot(me) : null, ROOM_AREA, showUI);
   });
};

export const deinit = restoreHome;
