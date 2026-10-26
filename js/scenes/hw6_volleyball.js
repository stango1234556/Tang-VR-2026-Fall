import * as cg from "../render/core/cg.js";
import { G2 } from "../util/g2.js";
import { loadSound, playSoundAtPosition } from "../util/positional-audio.js";

/*
   VOLLEYBALL (two teams), based on bouncing.js.
   Players take turns joining BLUE and ORANGE. Hit the ball with your hands; swing faster to hit harder.
   If the ball lands on your side, the other team scores. If it lands out, the last team to touch it loses the point.

   - SERVE panel beside each team: tosses the ball up (or just touch the floating ball).
   - Net post: net height, how floaty the ball is, and RESET SCORE.
   - Scoreboard above the net, one side facing each team.

   The first player (the master) runs the physics and shares it with everyone.
   Widget presses are sent to the master as messages.
*/

const COURT_W = 2.2;     // half the court's width
const COURT_L = 3.2;     // half the court's length; the net is in the middle at z = 0
const BALL_R = 0.14;
const MAX_SPEED = 9;
const TEAMS = [
   { name: "BLUE", color: [0.3, 0.55, 1], spot: [0, 0, 1.6], side: 1 },
   { name: "ORANGE", color: [1, 0.55, 0.2], spot: [0, 0, -1.6], side: -1 },
];

const soundBuffer = [];
for (let i = 0; i < 6; i++)
   loadSound('../../media/sound/bounce/' + i + '.wav', buffer => soundBuffer[i] = buffer);

// Where the ball floats while a team gets ready to serve.
const servePos = team => [0, 1.6, TEAMS[team].side * 1.2];

const newState = () => ({
   ball: servePos(0),
   waiting: true,
   serving: 0,
   score: [0, 0],
   netHeight: 1.6,
   gravity: 4,
   lastTeam: -1,
   hits: 0,
   message: "BLUE serves first",
   messageTime: 3,
});

let startWorldCoords = null;

export const init = async model => {
   server.init("vbMsgs", {});
   if (!window.vbState)
      window.vbState = newState();
   const S = () => window.vbState;

   const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
   const players = () => window.clients || [];
   const send = msg => server.send("vbMsgs", msg);
   const myTeam = () => {
      if (!window.clients || window.clientID === undefined || clients.indexOf(clientID) < 0)
         return -1;
      return clients.indexOf(clientID) % 2;
   };

   // The ball's speed is only kept by the master.
   let ballVel = [0, 0, 0];
   let cooldown = 0;
   const handPrev = {};

   // The master applies messages from the widgets.
   const handle = msg => {
      const s = S();
      if (msg.op === "serve" && s.waiting && s.serving === msg.team) {
         s.waiting = false;
         ballVel = [0, 4.5, -TEAMS[msg.team].side * 0.3];
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

   // The master moves the ball each frame.
   const step = dt => {
      const s = S();
      s.messageTime = Math.max(0, s.messageTime - dt);
      cooldown -= dt;

      // Every player's hands, and how fast each one is moving.
      const hands = [];
      players().forEach((id, slot) => {
         for (const hand of ["left", "right"]) {
            const f = clientState.finger(id, hand, 1);
            if (!f)
               continue;
            const key = id + hand;
            const prev = handPrev[key] || f;
            const vel = cg.scale(cg.subtract(f, prev), 1 / Math.max(dt, 1e-3));
            hands.push({ pos: f, vel, team: slot % 2 });
            handPrev[key] = f;
         }
      });

      // While waiting to serve, the ball floats in front of the serving team.
      if (s.waiting) {
         const home = servePos(s.serving);
         s.ball = [home[0], home[1] + 0.05 * Math.sin(Date.now() / 300), home[2]];
      }

      // A hand hits the ball: harder swings hit harder, and the ball always gets some lift.
      const b = s.ball;
      for (const h of hands) {
         const touching = cg.distance(b, h.pos) < BALL_R + 0.06;
         const allowed = !s.waiting || h.team === s.serving;
         if (cooldown > 0 || !touching || !allowed)
            continue;
         const away = cg.normalize(cg.subtract(b, h.pos));
         ballVel = cg.add(cg.scale(h.vel, 1.1), cg.scale(away, 1.5));
         ballVel[1] = Math.max(ballVel[1], 2.5);
         const speed = cg.norm(ballVel);
         if (speed > MAX_SPEED)
            ballVel = cg.scale(ballVel, MAX_SPEED / speed);
         s.waiting = false;
         s.lastTeam = h.team;
         s.hits++;
         cooldown = 0.2;
      }

      if (s.waiting)
         return;

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

      s.ball = next.map(v => Math.round(v * 1000) / 1000);

      // The ball hits the floor: someone scores.
      if (next[1] < BALL_R) {
         const side = next[2] > 0 ? 0 : 1;
         const inBounds = Math.abs(next[0]) <= COURT_W && Math.abs(next[2]) <= COURT_L;
         if (inBounds)
            point(1 - side);
         else
            point(s.lastTeam >= 0 ? 1 - s.lastTeam : 1 - side);
      }
   };

   // The court
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

   const netMesh = model.add("cube");
   const netTape = model.add("cube");
   const posts = [model.add("tubeY"), model.add("tubeY")];
   const ball = model.add("sphere");
   const shadow = model.add("diskY");

   // Scoreboard above the net: one canvas shown on two boards, one facing each team.
   const scoreG2 = new G2();
   model.txtrSrc(2, scoreG2.getCanvas());
   const boards = [model.add("square").txtr(2), model.add("square").txtr(2)];
   scoreG2.render = function () {
      const s = S();
      this.setColor([0.05, 0.05, 0.08, 0.85]).fillRect(-1, -0.6, 2, 1.2);
      TEAMS.forEach((t, k) => {
         const x = k === 0 ? -0.5 : 0.5;
         this.setColor(t.color).textHeight(0.1).text(t.name, x, 0.38, "center");
         this.textHeight(0.4).text(`${s.score[k]}`, x, 0.02, "center");
      });
      let message = "";
      if (s.messageTime > 0)
         message = s.message;
      else if (s.waiting)
         message = `${TEAMS[s.serving].name} to serve`;
      this.setColor("white").textHeight(0.08).text(message, 0, -0.42, "center");
   };

   // Each team's SERVE panel stands beside them, turned toward them.
   const servePanels = TEAMS.map((t, k) => {
      const pos = [-t.side * 0.75, 1.1, t.side * 1.3];
      const toPlayer = cg.normalize(cg.subtract([t.spot[0], 1.1, t.spot[2]], pos));
      model.add("cube").move(pos[0], 0.5, pos[2]).scale(0.03, 0.5, 0.03).color(0.3, 0.3, 0.35);

      const g2 = new G2();
      model.txtrSrc(3 + k, g2.getCanvas());
      const panel = model.add("square").txtr(3 + k).move(pos).turnY(Math.atan2(toPlayer[0], toPlayer[2])).turnX(-0.4).scale(0.15);

      g2.render = function () {
         const s = S();
         const you = myTeam() === k ? " (YOU)" : "";
         const status = s.waiting && s.serving === k ? "YOUR SERVE!" : `score: ${s.score[k]}`;
         this.setColor([0.1, 0.1, 0.14]).fillRect(-1, -1, 2, 2);
         this.setColor(t.color).fillRect(-1, 0.65, 2, 0.35);
         this.setColor("black").textHeight(0.12).text(`TEAM ${t.name}${you}`, 0, 0.82, "center");
         this.setColor("white").textHeight(0.1).text(status, 0, 0.35, "center");
         this.textHeight(0.06).text("Touch the ball to serve,", 0, -0.45, "center");
         this.text("or press SERVE to toss it up", 0, -0.58, "center");
      };
      g2.addWidget(panel, "button", 0, 0.0, "#ffd060", ["SERVE"], () => send({ op: "serve", team: k }), 1.5);
      return g2;
   });

   // Net controls on the net post, facing the court.
   const netG2 = new G2();
   model.txtrSrc(5, netG2.getCanvas());
   const netPanel = model.add("square").txtr(5).move(-(COURT_W + 0.25), 1.15, 0).turnY(Math.PI / 2).scale(0.2);
   netG2.render = function () {
      const s = S();
      this.setColor([0.1, 0.1, 0.14]).fillRect(-1, -1, 2, 2);
      this.setColor("white").textHeight(0.1).text("NET CONTROLS", 0, 0.8, "center");
      this.textHeight(0.065);
      this.text(`net height ${s.netHeight.toFixed(2)} m`, 0, 0.5, "center");
      this.text(`gravity ${s.gravity.toFixed(1)} m/s^2`, 0, 0.05, "center");
   };
   const netSlider = netG2.addWidget(netPanel, "slider", 0, 0.32, "#80c0ff", "net height", value => send({ op: "net", value }));
   const gravitySlider = netG2.addWidget(netPanel, "slider", 0, -0.13, "#80ffa0", "floatier ->", value => send({ op: "gravity", value }));
   netG2.addWidget(netPanel, "button", 0, -0.55, "#ff9090", ["RESET SCORE"], () => send({ op: "reset" }));

   // Move each player to their team's side, facing the net.
   startWorldCoords = window.worldCoords.slice();
   let placedTeam = -2;
   const placeMe = team => {
      const spot = TEAMS[team].spot;
      const turn = team === 1 ? Math.PI : 0;
      window.worldCoords = cg.mMultiply(cg.mRotateY(turn), cg.mTranslate(cg.scale(spot, -1)));
   };

   let lastTime = model.time;
   let frame = 0;
   let lastHits = S().hits;
   let flash = 0;

   model.animate(() => {
      const dt = clamp(model.time - lastTime, 0, 0.05) || 0;
      lastTime = model.time;

      server.sync("vbMsgs", msgs => {
         if (isMasterClient())
            for (const msg of Object.values(msgs))
               handle(msg);
      });

      const team = myTeam();
      if (team >= 0 && team !== placedTeam) {
         placeMe(team);
         placedTeam = team;
      }

      // The master runs the game and shares it about 36 times a second.
      if (window.clients && isMasterClient()) {
         step(dt);
         if (frame++ % 2 === 0)
            server.broadcastGlobal("vbState");
      }

      // Everyone draws the shared state, with a flash and a sound on each hit.
      const s = S();
      if (s.hits !== lastHits) {
         lastHits = s.hits;
         flash = 0.15;
         if (soundBuffer.length)
            playSoundAtPosition(soundBuffer[6 * Math.random() >> 0], s.ball);
      }
      flash -= dt;

      const h = s.netHeight;
      netMesh.identity().move(0, h - 0.4, 0).scale(COURT_W + 0.25, 0.4, 0.01).color(0.9, 0.9, 0.95).opacity(0.35);
      netTape.identity().move(0, h, 0).scale(COURT_W + 0.25, 0.025, 0.015).color(1, 1, 1);
      posts.forEach((post, k) => {
         const x = (k ? 1 : -1) * (COURT_W + 0.25);
         post.identity().move(x, h / 2, 0).scale(0.04, h / 2, 0.04).color(0.4, 0.4, 0.45);
      });
      boards.forEach((board, k) => {
         board.identity().move(0, h + 0.55, k ? -0.03 : 0.03).turnY(k ? Math.PI : 0).scale(0.45, 0.45, 1);
      });

      ball.identity().move(s.ball).scale(BALL_R).color(...(flash > 0 ? [1, 1, 0.6] : [0.97, 0.95, 0.85]));
      shadow.identity().move(s.ball[0], 0.004, s.ball[2]).scale(BALL_R * 1.2, 0.001, BALL_R * 1.2).color(0.05, 0.05, 0.05);

      // Keep the sliders showing the shared values, unless someone is dragging one.
      if (!netG2.isActiveWidget()) {
         netSlider.setValue((s.netHeight - 1.0) / 1.2);
         gravitySlider.setValue((9.8 - s.gravity) / 7.8);
      }
      scoreG2.update();
      servePanels.forEach(g2 => g2.update());
      netG2.update();
   });
};

export const deinit = () => {
   if (startWorldCoords)
      window.worldCoords = startWorldCoords;
};
