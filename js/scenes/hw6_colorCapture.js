import * as cg from "../render/core/cg.js";
import { G2 } from "../util/g2.js";
import { loadSound, playSoundAtPosition } from "../util/positional-audio.js";

/*
   COLOR CAPTURE (up to 4 players), based on bouncing.js.
   Hit balls with your hands or head to turn them your color.
   When time runs out, whoever owns the most balls wins.

   - Your pedestal: READY button, color picker, and your score.
   - Middle kiosk: number of balls, round length, and START.
   - Board above the middle: time left and everyone's score.

   The first player (the master) runs the physics and shares it with everyone.
   Widget presses are sent to the master as messages.
*/

const ROOM = 2.4;
const CEILING = 3;
const R = 0.15;
const MAX_BALLS = 80;
const HIT_SPEED = 3;
const GRAVITY = 1;
const HOMES = [[1.6, 0, 1.6], [-1.6, 0, -1.6], [-1.6, 0, 1.6], [1.6, 0, -1.6]];
const DEFAULT_HUES = [0, 0.6, 0.33, 0.13];
const GRAY = [0.6, 0.6, 0.65];

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

const newState = () => ({
   phase: "lobby",
   time: 0,
   length: 60,
   count: 40,
   balls: [],
   hues: DEFAULT_HUES.slice(),
   ready: [false, false, false, false],
   scores: [0, 0, 0, 0],
   winner: -1,
});

let startWorldCoords = null;

export const init = async model => {
   server.init("ccMsgs", {});
   if (!window.ccState)
      window.ccState = newState();
   const S = () => window.ccState;

   const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
   const players = () => (window.clients || []).slice(0, 4);
   const mySlot = () => window.clients && window.clientID !== undefined ? clients.indexOf(clientID) : -1;
   const send = msg => server.send("ccMsgs", msg);
   const colorOf = slot => hsv(S().hues[slot], 0.85, 0.9);

   // Ball speeds are only kept by the master.
   const vel = [];
   const litTime = [];

   const spawnBalls = n => {
      const s = S();
      s.balls = [];
      vel.length = 0;
      litTime.length = 0;
      for (let i = 0; i < n; i++) {
         const x = (Math.random() * 2 - 1) * (ROOM - R);
         const y = 0.5 + Math.random() * 2;
         const z = (Math.random() * 2 - 1) * (ROOM - R);
         s.balls.push([x, y, z, -1, 0]);   // position, owner (-1 = nobody), lit up
         vel.push([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]);
         litTime.push(0);
      }
   };
   if (!S().balls.length)
      spawnBalls(S().count);

   const start = () => {
      const s = S();
      s.phase = "playing";
      s.time = s.length;
      s.ready = [false, false, false, false];
      s.winner = -1;
      for (const b of s.balls)
         b[3] = -1;
   };

   // The master applies messages from the widgets.
   const handle = (msg, slot) => {
      const s = S();
      if (msg.op === "ready" && slot === msg.slot && s.phase !== "playing")
         s.ready[slot] = !s.ready[slot];
      if (msg.op === "hue" && slot === msg.slot)
         s.hues[slot] = clamp(msg.hue, 0, 1);
      if (msg.op === "count" && s.phase !== "playing") {
         const count = Math.round(20 + 60 * clamp(msg.value, 0, 1));
         if (count !== s.count) {
            s.count = count;
            spawnBalls(count);
         }
      }
      if (msg.op === "length" && s.phase !== "playing")
         s.length = Math.round(30 + 90 * clamp(msg.value, 0, 1));
      if (msg.op === "start")
         start();
   };

   // The master moves the balls each frame.
   const step = dt => {
      const s = S();
      const balls = s.balls;
      while (vel.length < balls.length) {
         vel.push([0, 0, 0]);
         litTime.push(0);
      }

      // Every player's hands and head can hit balls.
      const bodies = [];
      players().forEach((id, slot) => {
         for (const hand of ["left", "right"]) {
            const f = clientState.finger(id, hand, 1);
            if (f)
               bodies.push({ pos: f, slot, r: R });
         }
         const head = clientState.head(id);
         if (Array.isArray(head))
            bodies.push({ pos: head.slice(12, 15), slot, r: R + 0.15 });
      });

      // A hit ball bounces away and takes the hitter's color.
      balls.forEach((b, i) => {
         const p = b.slice(0, 3);
         for (const body of bodies)
            if (cg.distance(p, body.pos) < body.r) {
               vel[i] = cg.scale(cg.normalize(cg.subtract(p, body.pos)), HIT_SPEED);
               b[3] = body.slot;
               litTime[i] = 0.15;
            }
      });

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

      // Balls bounce off the walls, floor and ceiling, and fall slowly.
      const lo = [-ROOM + R, R, -ROOM + R];
      const hi = [ROOM - R, CEILING - R, ROOM - R];
      balls.forEach((b, i) => {
         for (let k = 0; k < 3; k++) {
            if (b[k] < lo[k])
               vel[i][k] = Math.abs(vel[i][k]);
            if (b[k] > hi[k])
               vel[i][k] = -Math.abs(vel[i][k]);
         }
         vel[i][1] -= GRAVITY * dt;
         vel[i] = cg.scale(vel[i], 1 - 0.3 * dt);
         for (let k = 0; k < 3; k++)
            b[k] = Math.round((b[k] + vel[i][k] * dt) * 1000) / 1000;
         litTime[i] -= dt;
         b[4] = litTime[i] > 0 ? 1 : 0;
      });

      s.scores = [0, 1, 2, 3].map(slot => balls.filter(b => b[3] === slot).length);

      // Start when everyone is ready; end when time runs out.
      const present = players().length;
      if (s.phase === "lobby" && present > 0 && s.ready.slice(0, present).every(r => r))
         start();
      if (s.phase === "playing") {
         s.time = Math.max(0, s.time - dt);
         if (s.time === 0) {
            s.phase = "done";
            const scores = s.scores.slice(0, present);
            const best = Math.max(...scores);
            const leaders = scores.filter(v => v === best).length;
            s.winner = leaders === 1 ? scores.indexOf(best) : -2;   // -2 means a tie
         }
      }
   };

   // The room
   model.add("cube").move(0, -0.01, 0).scale(ROOM, 0.01, ROOM).color(0.18, 0.18, 0.22);
   for (const x of [-ROOM, ROOM])
      for (const z of [-ROOM, ROOM])
         model.add("tubeY").move(x, CEILING / 2, z).scale(0.02, CEILING / 2, 0.02).color(0.5, 0.5, 0.6);
   const homeRings = HOMES.map(h => model.add("diskY").move(h[0], 0.002, h[2]).scale(0.35, 0.001, 0.35));

   const ballNodes = [];
   for (let i = 0; i < MAX_BALLS; i++)
      ballNodes.push(model.add("sphere"));
   const wasLit = [];

   // Each player's pedestal stands in front of their corner, facing them.
   const pedestals = HOMES.map((home, k) => {
      const toCenter = cg.normalize(cg.scale(home, -1));
      const pos = cg.add(home, cg.scale(toCenter, 0.6));
      model.add("cube").move(pos[0], 0.5, pos[2]).scale(0.04, 0.5, 0.04).color(0.3, 0.3, 0.35);

      const g2 = new G2();
      model.txtrSrc(2 + k, g2.getCanvas());
      const yaw = Math.atan2(-toCenter[0], -toCenter[2]);
      const panel = model.add("square").txtr(2 + k).move(pos[0], 1.15, pos[2]).turnY(yaw).turnX(-0.5).scale(0.17);

      g2.render = function () {
         const s = S();
         const present = k < players().length;
         const you = mySlot() === k ? " (YOU)" : "";
         let state = "not ready";
         if (!present)
            state = "empty";
         else if (s.phase === "playing")
            state = "balls owned";
         else if (s.ready[k])
            state = "READY!";

         this.setColor([0.1, 0.1, 0.14]).fillRect(-1, -1, 2, 2);
         this.setColor(colorOf(k)).fillRect(-1, 0.72, 2, 0.28);
         this.setColor("black").textHeight(0.1).text(`PLAYER ${k + 1}${you}`, 0, 0.86, "center");
         this.setColor("white").textHeight(0.22).text(present ? `${s.scores[k]}` : "-", 0, 0.47, "center");
         this.textHeight(0.07).text(state, 0, 0.27, "center");
      };
      g2.addWidget(panel, "button", 0, 0.08, "#ffffff", ["READY"], () => send({ op: "ready", slot: k }));
      g2.addWidget(panel, "trackpad", 0, -0.55, "#ffffff", "pick your color", value => send({ op: "hue", slot: k, hue: value[0] }));
      return g2;
   });

   // The kiosk in the middle: round settings and START. It turns to face you.
   model.add("cube").move(0, 0.5, 0).scale(0.05, 0.5, 0.05).color(0.3, 0.3, 0.35);
   const kioskG2 = new G2();
   model.txtrSrc(6, kioskG2.getCanvas());
   const kiosk = model.add("square").txtr(6);
   kioskG2.render = function () {
      const s = S();
      const hint = s.phase === "playing" ? "Game on! Hit the balls!" : "Press READY on your pedestal, or START";
      this.setColor([0.12, 0.12, 0.16]).fillRect(-1, -1, 2, 2);
      this.setColor("white").textHeight(0.1).text("COLOR CAPTURE", 0, 0.82, "center");
      this.textHeight(0.065).text(hint, 0, 0.6, "center");
      this.text(`${s.count} balls`, -0.32, 0.3, "right");
      this.text(`${s.length} seconds`, -0.32, 0.0, "right");
   };
   const countSlider = kioskG2.addWidget(kiosk, "slider", 0.3, 0.3, "#80c0ff", "balls", value => send({ op: "count", value }));
   const lengthSlider = kioskG2.addWidget(kiosk, "slider", 0.3, 0.0, "#80ffa0", "round length", value => send({ op: "length", value }));
   kioskG2.addWidget(kiosk, "button", 0, -0.4, "#ffd060", ["START"], () => send({ op: "start" }));

   // The board above the middle: time left and everyone's score.
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
      this.setColor("white").textHeight(s.phase === "playing" ? 0.3 : 0.14).text(title, 0, 0.55, "center");
      const total = Math.max(1, s.balls.length);
      for (let k = 0; k < players().length; k++) {
         const y = 0.05 - k * 0.22;
         this.setColor([0.25, 0.25, 0.3]).fillRect(-0.8, y, 1.6, 0.15);
         this.setColor(colorOf(k)).fillRect(-0.8, y, 1.6 * s.scores[k] / total, 0.15);
         this.setColor("white").textHeight(0.08).text(`P${k + 1}: ${s.scores[k]}`, 0, y + 0.075, "center");
      }
   };

   // Move each player to their own corner, facing the middle.
   startWorldCoords = window.worldCoords.slice();
   let placedSlot = -2;
   const placeMe = slot => {
      const home = HOMES[slot];
      const d = cg.normalize(cg.scale(home, -1));
      window.worldCoords = cg.mMultiply(cg.mRotateY(Math.atan2(d[0], -d[2])), cg.mTranslate(cg.scale(home, -1)));
   };

   const faceViewer = node => {
      try {
         node.faceViewer();
      } catch (e) {}
   };

   let lastTime = model.time;
   let frame = 0;

   model.animate(() => {
      const dt = clamp(model.time - lastTime, 0, 0.05) || 0;
      lastTime = model.time;

      server.sync("ccMsgs", (msgs, id) => {
         if (isMasterClient())
            for (const msg of Object.values(msgs))
               handle(msg, players().indexOf(id));
      });

      const slot = mySlot();
      if (slot >= 0 && slot !== placedSlot) {
         placeMe(slot);
         placedSlot = slot;
      }

      // The master runs the game and shares it about 36 times a second.
      if (window.clients && isMasterClient()) {
         step(dt);
         if (frame++ % 2 === 0)
            server.broadcastGlobal("ccState");
      }

      // Everyone draws the shared state.
      const s = S();
      let sounds = 0;
      for (let i = 0; i < MAX_BALLS; i++) {
         const b = s.balls[i];
         if (!b) {
            ballNodes[i].identity().scale(0);
            continue;
         }
         const color = b[3] < 0 ? GRAY : hsv(s.hues[b[3]], 0.85, b[4] ? 1 : 0.75);
         ballNodes[i].identity().move(b[0], b[1], b[2]).scale(R).color(...color);
         if (b[4] && !wasLit[i] && sounds++ < 3 && soundBuffer.length)
            playSoundAtPosition(soundBuffer[6 * Math.random() >> 0], b.slice(0, 3));
         wasLit[i] = b[4];
      }

      homeRings.forEach((ring, k) => ring.color(...(k < players().length ? colorOf(k) : [0.3, 0.3, 0.3])));

      kiosk.identity().move(0, 1.2, 0);
      faceViewer(kiosk);
      kiosk.scale(0.2);
      board.identity().move(0, 2.55, 0);
      faceViewer(board);
      board.scale(0.35);

      // Keep the sliders showing the shared values, unless someone is dragging one.
      if (!kioskG2.isActiveWidget()) {
         countSlider.setValue((s.count - 20) / 60);
         lengthSlider.setValue((s.length - 30) / 90);
      }
      for (const g2 of pedestals)
         g2.update();
      kioskG2.update();
      boardG2.update();
   });
};

export const deinit = () => {
   if (startWorldCoords)
      window.worldCoords = startWorldCoords;
};
