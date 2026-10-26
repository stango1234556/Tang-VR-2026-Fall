// Shared helpers for the hw6 scenes.

import * as cg from "../render/core/cg.js";
import { joyStickState } from "../render/core/controllerInput.js";
import { lcb, rcb } from "../handle_scenes.js";

const WALK_SPEED = 2;   // meters per second at full stick

// Draws text, shrinking it if it would be wider than maxW.
export const fitText = (g2, text, x, y, h, maxW = 1.85, align = "center") => {
   g2.textHeight(h);
   const w = 2 * g2.getContext().measureText(text).width / g2.getCanvas().width;
   if (w > maxW)
      g2.textHeight(h * maxW / w);
   g2.text(text, x, y, align);
   return g2;
};

// A G2 button sizes itself from the current font but measures text at half width,
// so call this at the end of render() with the button's size.
export const buttonFont = (g2, size) => g2.textHeight(0.09 * size);

// VR controls:
//  - aim the right beam at a panel and pull the right trigger to click
//  - the left trigger opens and closes the scene menu
//  - the left stick walks you the way you push it, relative to where you look
export const vrControls = (model, panels) => {
   if (!window.hw6Home)
      window.hw6Home = window.worldCoords.slice();

   const cursor = model.add("sphere");
   let menuOpen = false;
   let leftWas = false;
   let placedKey = null;
   let lastTime = performance.now() / 1000;

   // Walking moves the world the opposite way under you.
   const walk = dt => {
      const x = joyStickState.left.x || 0;
      const y = joyStickState.left.y || 0;
      if (!window.vr || Math.hypot(x, y) < 0.15)
         return;
      const head = clay.root().inverseViewMatrix(0);
      const forward = cg.normalize([-head[8], 0, -head[10]]);
      const right = [-forward[2], 0, forward[0]];
      const step = WALK_SPEED * dt;
      window.worldCoords[12] -= step * (right[0] * x - forward[0] * y);
      window.worldCoords[14] -= step * (right[2] * x - forward[2] * y);
   };

   // If your head leaves the area { x: [lo, hi], z: [lo, hi] }, the world slides to put you back on the edge.
   const keepInside = area => {
      const W = window.worldCoords;
      const head = clay.root().inverseViewMatrix(0).slice(12, 15);
      const p = cg.mTransform(cg.mInverse(W), head);
      const dx = Math.max(area.x[0], Math.min(area.x[1], p[0])) - p[0];
      const dz = Math.max(area.z[0], Math.min(area.z[1], p[2])) - p[2];
      W[12] -= W[0] * dx + W[8] * dz;
      W[14] -= W[2] * dx + W[10] * dz;
   };

   const menuLabel = () => {
      for (let i = 0; i < clay.vrWidgets.nChildren(); i++) {
         const info = clay.vrWidgets.child(i).getInfo();
         if (info === "<open>" || info === "<close>")
            return clay.vrWidgets.child(i);
      }
      return null;
   };

   // Opening the menu takes you back to the start spot, where the menu is.
   const setMenu = open => {
      menuOpen = open;
      window.isMenuClosed = !open;
      const label = menuLabel();
      if (label)
         label.info(open ? "<close>" : "<open>");
      if (open)
         window.worldCoords = window.hw6Home.slice();
      placedKey = null;
   };

   // Widgets only listen to the right beam, leaving the left trigger free for the menu.
   const usePointer = g2 => {
      const mouseUVZ = g2.computeUVZ;
      g2.computeUVZ = m => window.vr && !window.handtracking && rcb ? rcb.hitRect(m) : mouseUVZ(m);
      return g2;
   };

   // Call every frame.
   //  spot: the worldCoords that put you at your place in the game, or null
   //  area: where you can walk, or null for anywhere
   //  showPanels: false while the panels are hidden
   const update = (g2s, spot, area, showPanels = true) => {
      const leftDown = !!(lcb && lcb.down) && !window.handtracking;
      if (leftDown && !leftWas)
         setMenu(!menuOpen);
      leftWas = leftDown;
      if (menuOpen && window.isMenuClosed)
         setMenu(false);

      if (!menuOpen && spot && spot.join() !== placedKey) {
         window.worldCoords = spot;
         placedKey = spot.join();
      }

      const now = performance.now() / 1000;
      walk(Math.min(0.05, now - lastTime));
      lastTime = now;
      if (window.vr && area && !menuOpen)
         keepInside(area);

      // A dot shows where the right beam hits a panel.
      let best = null;
      if (window.vr && rcb && showPanels)
         for (const panel of panels) {
            const hit = rcb.hitRect(panel.getGlobalMatrix());
            if (hit && (!best || hit[2] < best.dist))
               best = { panel, dist: hit[2] };
         }
      if (best)
         cursor.identity().move(rcb.hitPoint(best.panel.getGlobalMatrix())).scale(0.012).color(1, 1, 1);
      else
         cursor.identity().scale(0);

      // Hide the left trigger from the widgets while they update.
      const lcbDown = lcb ? lcb.down : false;
      if (lcb)
         lcb.down = false;
      for (const g2 of g2s)
         g2.update();
      if (lcb)
         lcb.down = lcbDown;
   };

   return { usePointer, update, isMenuOpen: () => menuOpen };
};

// Decides which client runs the game: normally the first to join. Every client sends a heartbeat,
// and if a tab stops running (in the background, or a headset asleep), the next active client takes over.
if (!window.hw6Beats)
   window.hw6Beats = {};
const seen = {};   // id -> [last heartbeat, when it last changed]
let myBeat = 0;
let lastBeat = 0;
let firstCall = 0;

export const isGameMaster = () => {
   if (!window.clients || window.clientID === undefined)
      return false;
   const now = performance.now();
   firstCall = firstCall || now;

   if (now - lastBeat > 200) {
      lastBeat = now;
      window.hw6Beats[clientID] = ++myBeat;
      server.broadcastGlobalElement("hw6Beats", clientID);
   }
   for (const id of clients) {
      const beat = window.hw6Beats[id];
      if (!seen[id] || seen[id][0] !== beat)
         seen[id] = [beat, now];
   }

   // Right after joining, everyone counts as active until their heartbeats arrive.
   const active = id => {
      if (id === clientID)
         return true;
      if (window.hw6Beats[id] === undefined)
         return now - firstCall < 2000;
      return now - seen[id][1] < 1500;
   };
   return clients.find(active) === clientID;
};

// Puts you back where you started when the scene closes.
export const restoreHome = () => {
   if (window.hw6Home)
      window.worldCoords = window.hw6Home;
   delete window.hw6Home;
};
