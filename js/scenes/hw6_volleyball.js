import * as cg from "../render/core/cg.js";
import { G2 } from "../util/g2.js";
import { loadSound, playSoundAtPosition } from "../util/positional-audio.js";
import { fitText, buttonFont, vrControls, restoreHome, isGameMaster } from "./hw6_controls.js";

const COURT_W = 2.2;   // half the court's width
const COURT_L = 4.2;   // half the court's length; the net is at z = 0
const NET_W = COURT_W + 0.25;
const NET_H = 0.4;
const BALL_R = 0.14;
const MAX_SPEED = 7;
const TEAMS = [
   { name: "BLUE", color: [0.3, 0.55, 1], spot: [0, 0, COURT_L - 0.5], side: 1 },
   { name: "ORANGE", color: [1, 0.55, 0.2], spot: [0, 0, -(COURT_L - 0.5)], side: -1 },
];

const soundBuffer = [];
for (let i = 0; i < 6; i++)
   loadSound('../../media/sound/bounce/' + i + '.wav', buffer => soundBuffer[i] = buffer);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, n) => Math.round(v * n) / n;

// Where the ball floats while a team gets ready to serve.
const servePos = team => [0, 1.6, TEAMS[team].side * (COURT_L - 1.0)];

// Where a ball would be after t seconds, never below the floor.
const fly = (from, v, t, gravity) => [from[0] + v[0] * t, Math.max(BALL_R, from[1] + v[1] * t - 0.5 * gravity * t * t), from[2] + v[2] * t];

const newState = () => ({
   ball: servePos(0),
   waiting: true,   // true while the ball floats, waiting to be served
   serving: 0,
   score: [0, 0],
   netHeight: 1.6,
   gravity: 4,
   lastTeam: -1,
   hits: 0,
   message: "BLUE serves first",
   messageTime: 3,
});

export const init = async model => {
   server.init("vbMsgs", {});
   if (!window.vbState)
      window.vbState = newState();
   const S = () => window.vbState;

   const players = () => window.clients || [];
   const send = msg => server.send("vbMsgs", msg);
   const myTeam = () => {
      if (!window.clients || window.clientID === undefined || clients.indexOf(clientID) < 0)
         return -1;
      return clients.indexOf(clientID) % 2;
   };

   // ---- Game logic, run by the master ----

   let ballVel = [0, 0, 0];
   let cooldown = 0;

   // If a hit would land out of bounds, slow its sideways speed so it lands just inside the lines.
   const keepInCourt = (b, gravity) => {
      const vy = ballVel[1];
      const flightTime = (vy + Math.sqrt(vy * vy + 2 * gravity * Math.max(0, b[1] - BALL_R))) / gravity;
      const limits = [COURT_W - 0.3, 0, COURT_L - 0.3];
      let k = 1;
      for (const i of [0, 2]) {
         const land = b[i] + ballVel[i] * flightTime;
         if (Math.abs(land) > limits[i])
            k = Math.min(k, (Math.sign(land) * limits[i] - b[i]) / (ballVel[i] * flightTime));
      }
      k = clamp(k, 0, 1);
      ballVel[0] *= k;
      ballVel[2] *= k;
   };

   const handle = (msg, team) => {
      const s = S();

      // Players report their own hits. The ball starts from where the hitter saw it, unless that's too far off.
      if (msg.op === "hit" && cooldown <= 0 && team >= 0 && (!s.waiting || team === s.serving)) {
         if (cg.distance(msg.pos, s.ball) < 0.5)
            s.ball = msg.pos;
         ballVel = msg.vel;
         keepInCourt(s.ball, s.gravity);
         s.waiting = false;
         s.lastTeam = team;
         s.hits++;
         cooldown = 0.2;
      }
      if (msg.op === "net")
         s.netHeight = 1.0 + 1.2 * clamp(msg.value, 0, 1);
      if (msg.op === "gravity")
         s.gravity = 9.8 - 7.8 * clamp(msg.value, 0, 1);
      if (msg.op === "reset") {
         Object.assign(s, newState(), { netHeight: s.netHeight, gravity: s.gravity });
         ballVel = [0, 0, 0];
      }
   };

   const point = winner => {
      const s = S();
      s.score[winner]++;
      s.serving = winner;
      s.waiting = true;
      s.lastTeam = -1;
      s.message = `Point ${TEAMS[winner].name}!`;
      s.messageTime = 2.5;
      ballVel = [0, 0, 0];
   };

   const step = dt => {
      const s = S();
      s.messageTime = Math.max(0, s.messageTime - dt);
      cooldown -= dt;

      if (s.waiting) {
         const home = servePos(s.serving);
         s.ball = [home[0], home[1] + 0.05 * Math.sin(Date.now() / 300), home[2]];
         return;
      }

      const b = s.ball;
      ballVel[1] -= s.gravity * dt;
      const next = cg.add(b, cg.scale(ballVel, dt));

      // The ball bounces back off the net.
      const crossesNet = Math.sign(next[2]) !== Math.sign(b[2]);
      if (crossesNet && next[1] < s.netHeight && Math.abs(next[0]) < COURT_W + 0.3) {
         next[2] = Math.sign(b[2]) * BALL_R;
         ballVel[2] = -ballVel[2] * 0.4;
      }

      // Invisible walls a little outside the court keep the ball nearby.
      const wall = [COURT_W + 1.5, 6, COURT_L + 1.5];
      for (const k of [0, 2])
         if (Math.abs(next[k]) > wall[k]) {
            next[k] = Math.sign(next[k]) * wall[k];
            ballVel[k] = -ballVel[k] * 0.5;
         }

      s.ball = next.map(v => round(v, 1000));

      // When the ball hits the floor, someone scores.
      if (next[1] < BALL_R) {
         const side = next[2] > 0 ? 0 : 1;
         const inBounds = Math.abs(next[0]) <= COURT_W && Math.abs(next[2]) <= COURT_L;
         if (inBounds)
            point(1 - side);
         else
            point(s.lastTeam >= 0 ? 1 - s.lastTeam : 1 - side);
      }
   };

   // ---- The court ----

   model.add("cube").move(0, -0.02, 0).scale(COURT_W + 2, 0.01, COURT_L + 2).color(0.15, 0.15, 0.18);
   for (const t of TEAMS) {
      const dark = t.color.map(c => c * 0.35);
      model.add("cube").move(0, -0.005, t.side * COURT_L / 2).scale(COURT_W, 0.005, COURT_L / 2).color(...dark);
      model.add("diskY").move(t.spot[0], 0.003, t.spot[2]).scale(0.3, 0.001, 0.3).color(...t.color);
   }
   const line = (a, b) => model.add("tubeZ").link(a, b, 0.015).color(0.9, 0.9, 0.9);
   for (const x of [-COURT_W, COURT_W])
      line([x, 0.005, -COURT_L], [x, 0.005, COURT_L]);
   for (const z of [-COURT_L, 0, COURT_L])
      line([-COURT_W, 0.005, z], [COURT_W, 0.005, z]);

   // The net is a see-through grid, drawn once and shown on two squares so both teams see it.
   const gridG2 = new G2(true, 1024, 256);
   const cell = 0.1;
   const thick = 0.012;
   gridG2.setColor([0.95, 0.95, 0.95, 0.9]);
   for (let x = -NET_W; x <= NET_W + 1e-6; x += cell)
      gridG2.fillRect(x / NET_W - thick / NET_W / 2, -1, thick / NET_W, 2);
   for (let y = -NET_H; y <= NET_H + 1e-6; y += cell)
      gridG2.fillRect(-1, y / NET_H - thick / NET_H / 2, 2, thick / NET_H);
   model.txtrSrc(6, gridG2.getCanvas());

   const nets = [model.add("square").txtr(6), model.add("square").txtr(6)];
   const netTape = model.add("cube");
   const posts = [model.add("tubeY"), model.add("tubeY")];
   const ball = model.add("sphere");
   const shadow = model.add("diskY");

   // ---- Panels ----

   // The scoreboard above the net: one canvas on two boards, one facing each team.
   const scoreG2 = new G2();
   model.txtrSrc(2, scoreG2.getCanvas());
   const boards = [model.add("square").txtr(2), model.add("square").txtr(2)];

   scoreG2.render = function () {
      const s = S();
      this.setColor([0.05, 0.05, 0.08, 0.85]).fillRect(-1, -0.6, 2, 1.2);
      TEAMS.forEach((t, k) => {
         const x = k === 0 ? -0.5 : 0.5;
         this.setColor(t.color);
         fitText(this, t.name, x, 0.45, 0.11, 0.9);
         fitText(this, `${s.score[k]}`, x, 0.0, 0.3, 0.9);
      });
      let message = "";
      if (s.messageTime > 0)
         message = s.message;
      else if (s.waiting)
         message = `${TEAMS[s.serving].name} to serve`;
      this.setColor("white");
      fitText(this, message, 0, -0.45, 0.1);
   };

   // The signs and net controls are grouped so they can hide while the ball is in play.
   const ui = model.add();

   // Each team has a sign beside them saying whose serve it is.
   const signs = TEAMS.map((t, k) => {
      const pos = [-t.side * 0.8, 1.1, t.side * (COURT_L - 0.9)];
      const toPlayer = cg.normalize(cg.subtract([t.spot[0], 1.1, t.spot[2]], pos));
      ui.add("cube").move(pos[0], 0.45, pos[2]).scale(0.03, 0.45, 0.03).color(0.3, 0.3, 0.35);

      const g2 = new G2();
      model.txtrSrc(3 + k, g2.getCanvas());
      ui.add("square").txtr(3 + k).move(pos).turnY(Math.atan2(toPlayer[0], toPlayer[2])).turnX(-0.4).scale(0.25);

      g2.render = function () {
         const s = S();
         this.setColor([0.1, 0.1, 0.14]).fillRect(-1, -1, 2, 2);
         this.setColor(t.color).fillRect(-1, 0.6, 2, 0.4);
         this.setColor("black");
         fitText(this, `TEAM ${t.name}${myTeam() === k ? " (YOU)" : ""}`, 0, 0.8, 0.13);
         this.setColor("white");
         fitText(this, s.serving === k ? "YOUR SERVE!" : "THEIR SERVE", 0, 0.3, 0.15);
         fitText(this, `score: ${s.score[k]}`, 0, 0.0, 0.1);
         fitText(this, "Hit the floating ball", 0, -0.38, 0.085);
         fitText(this, "with your hand to serve", 0, -0.56, 0.085);
         this.setColor([0.7, 0.7, 0.75]);
         fitText(this, "Left trigger: scene menu", 0, -0.86, 0.065);
      };
      return g2;
   });

   // Net controls stand just past the end of the net, facing the court.
   const netX = -(COURT_W + 0.7);
   ui.add("cube").move(netX, 0.45, 0).scale(0.03, 0.45, 0.03).color(0.3, 0.3, 0.35);
   const netG2 = new G2();
   model.txtrSrc(5, netG2.getCanvas());
   const netPanel = ui.add("square").txtr(5).move(netX, 1.2, 0).turnY(Math.PI / 2).scale(0.32);

   netG2.render = function () {
      const s = S();
      this.setColor([0.1, 0.1, 0.14]).fillRect(-1, -1, 2, 2);
      this.setColor("white");
      fitText(this, "NET CONTROLS", 0, 0.84, 0.12);
      fitText(this, `net height: ${s.netHeight.toFixed(2)} m`, 0, 0.6, 0.085);
      fitText(this, `gravity: ${s.gravity.toFixed(1)} m/s²`, 0, 0.12, 0.085);
      this.setColor([0.7, 0.7, 0.75]);
      fitText(this, "Left trigger: scene menu", 0, -0.88, 0.065);
      buttonFont(this, 2);
   };
   netG2.addWidget(netPanel, "button", 0, -0.6, "#ff9090", ["  RESET SCORE  "], () => send({ op: "reset" }), 2);
   const netSlider = netG2.addWidget(netPanel, "slider", 0, 0.38, "#80c0ff", "height", value => send({ op: "net", value }), 2.6);
   const gravitySlider = netG2.addWidget(netPanel, "slider", 0, -0.1, "#80ffa0", "floatier →", value => send({ op: "gravity", value }), 2.6);

   const controls = vrControls(model, [netPanel]);
   controls.usePointer(netG2);

   // Each player stands on their team's side, facing the net.
   const mySpot = team => {
      const turn = team === 1 ? Math.PI : 0;
      return cg.mMultiply(cg.mRotateY(turn), cg.mTranslate(cg.scale(TEAMS[team].spot, -1)));
   };

   // Players can walk on their own side and a little past the lines, but not past the net.
   const myArea = team => {
      const far = TEAMS[team].side * (COURT_L + 1.3);
      const near = TEAMS[team].side * 0.3;
      return { x: [-(COURT_W + 1.3), COURT_W + 1.3], z: [Math.min(near, far), Math.max(near, far)] };
   };

   // ---- Every frame ----

   let lastTime = model.time;
   let frame = 0;
   let wasMaster = false;
   let lastState = null;
   let stateTime = 0;
   let shownBall = null;   // where the ball was last drawn
   let myHit = null;       // my latest hit: { pos, vel, time, until }
   const myHands = {};     // my hands' last positions and speeds
   let lastHits = S().hits;
   let flash = 0;

   // I check my own hands against the ball I see. Harder swings hit harder, and the ball always gets some lift.
   const checkMyHits = (s, p, dt, team, master) => {
      for (const hand of ["left", "right"]) {
         const f = clientState.finger(clientID, hand, 1);
         if (!f)
            continue;
         const prev = myHands[hand] || { pos: f, vel: [0, 0, 0] };
         const vel = cg.mix(prev.vel, cg.scale(cg.subtract(f, prev.pos), 1 / Math.max(dt, 1e-3)), 0.5);
         myHands[hand] = { pos: f, vel };

         const touching = cg.distance(p, f) < BALL_R + 0.06;
         const allowed = team >= 0 && (!s.waiting || team === s.serving);
         const cooling = myHit && model.time < myHit.time + 0.3;
         if (!touching || !allowed || cooling)
            continue;

         let hitVel = cg.add(cg.scale(vel, 0.7), cg.normalize(cg.subtract(p, f)));
         hitVel[1] = Math.max(hitVel[1], 2.5);
         const speed = cg.norm(hitVel);
         if (speed > MAX_SPEED)
            hitVel = cg.scale(hitVel, MAX_SPEED / speed);
         hitVel = hitVel.map(v => round(v, 100));
         const pos = p.map(v => round(v, 1000));
         myHit = { pos, vel: hitVel, time: model.time, until: model.time + 0.35 };

         const msg = { op: "hit", pos, vel: hitVel };
         if (master)
            handle(msg, team);
         else
            send(msg);
      }
   };

   model.animate(() => {
      const dt = clamp(model.time - lastTime, 0, 0.05) || 0;
      lastTime = model.time;

      // A client that just took over doesn't know the ball's speed, so the ball falls from where it is.
      const master = isGameMaster();
      if (master && !wasMaster)
         ballVel = [0, 0, 0];
      wasMaster = master;

      server.sync("vbMsgs", (msgs, id) => {
         if (master)
            for (const msg of Object.values(msgs))
               handle(msg, players().indexOf(id) % 2);
      });

      // The master runs the game and shares it about 36 times a second.
      if (master) {
         step(dt);
         S().ballVel = ballVel.map(v => round(v, 100));
         if (frame++ % 2 === 0)
            server.broadcastGlobal("vbState");
      }

      const s = S();
      if (s !== lastState) {
         lastState = s;
         stateTime = model.time;
      }

      // Other players get updates only now and then, so between updates the ball keeps moving
      // at its last speed and eases toward where it should be. After I hit it, it follows my hit.
      const hitting = !master && myHit && model.time < myHit.until;
      let p = s.ball;
      if (hitting)
         p = fly(myHit.pos, myHit.vel, model.time - myHit.time, s.gravity);
      else if (!master && !s.waiting && s.ballVel)
         p = fly(s.ball, s.ballVel, Math.min(model.time - stateTime, 0.2), s.gravity);
      if (!master && shownBall && cg.distance(shownBall, p) < 0.5)
         p = shownBall.map((x, k) => x + (p[k] - x) * 0.4);
      shownBall = p;

      const team = myTeam();
      checkMyHits(s, p, dt, team, master);

      // A flash and a sound on each hit.
      if (s.hits !== lastHits) {
         lastHits = s.hits;
         flash = 0.15;
         if (soundBuffer.length)
            playSoundAtPosition(soundBuffer[6 * Math.random() >> 0], s.ball);
      }
      flash -= dt;

      const h = s.netHeight;
      nets.forEach((net, k) => net.identity().move(0, h - NET_H, 0).turnY(k ? Math.PI : 0).scale(NET_W, NET_H, 1));
      netTape.identity().move(0, h, 0).scale(NET_W, 0.025, 0.015).color(1, 1, 1);
      posts.forEach((post, k) => post.identity().move((k ? 1 : -1) * NET_W, h / 2, 0).scale(0.04, h / 2, 0.04).color(0.4, 0.4, 0.45));
      boards.forEach((board, k) => board.identity().move(0, h + 0.55, k ? -0.03 : 0.03).turnY(k ? Math.PI : 0).scale(0.45, 0.45, 1));

      ball.identity().move(p).scale(BALL_R).color(...(flash > 0 || hitting ? [1, 1, 0.6] : [0.97, 0.95, 0.85]));
      shadow.identity().move(p[0], 0.004, p[2]).scale(BALL_R * 1.2, 0.001, BALL_R * 1.2).color(0.05, 0.05, 0.05);

      // The sliders show the shared values, unless someone is dragging one.
      if (!netG2.isActiveWidget()) {
         netSlider.setValue((s.netHeight - 1.0) / 1.2);
         gravitySlider.setValue((9.8 - s.gravity) / 7.8);
      }

      // The panels only show between points.
      const showUI = s.waiting;
      ui.identity().scale(showUI ? 1 : 0);
      const g2s = showUI ? [scoreG2, ...signs, netG2] : [scoreG2];
      controls.update(g2s, team >= 0 ? mySpot(team) : null, team >= 0 ? myArea(team) : null, showUI);
   });
};

export const deinit = restoreHome;
