import * as cg from "../render/core/cg.js";

/*
   A physical control panel: a sloped desk with controls you reach out and use with either trigger.
   - Shape buttons: press one to pick the shape.      - Toggle switch: spin on / off.
   - Dial: grab it and move your hand left or right to set the spin speed.
   - Slider: grab the knob and slide it to set the size. - Color swatches: press one to pick the color.
*/

const PANEL_POS = [0, 1.0, -0.3];
const PANEL_TILT = 0.45;                 // the back edge is raised so the panel faces you
const TARGET_POS = [0, 1.38, -0.65];
const REACH = 0.035;                     // how close your hand must be to use a control

const SHAPES = [
   { form: "cube", label: "CUBE", x: -0.19 },
   { form: "sphere", label: "BALL", x: -0.13 },
   { form: "torusY", label: "RING", x: -0.07 },
];
const COLORS = [[1, 0.3, 0.3], [1, 0.75, 0.2], [0.3, 0.9, 0.4], [0.3, 0.6, 1], [0.8, 0.4, 1]];
const SLIDER = { x0: 0.02, x1: 0.22, z: 0.04 };
const TOGGLE = [0.04, -0.08];
const DIAL = [0.17, -0.08];
const ROW_TOP = -0.08, ROW_BOTTOM = 0.04;

export const init = async model => {
   let shape = 0;
   let colorIndex = 3;
   let size = 0.5;
   let speed = 0.5;
   let spinning = true;
   let angle = 0;
   let drag = null;
   const pressTime = SHAPES.map(() => -1);

   const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
   const inch = 0.0254;

   // clay.text makes a new mesh per call, so reuse one mesh per distinct string.
   const textForms = new Map();
   const textForm = s => {
      if (!textForms.has(s))
         textForms.set(s, clay.text(s));
      return textForms.get(s);
   };

   const panel = model.add().move(PANEL_POS).turnX(PANEL_TILT);

   // Labels lie flat on the panel, readable from where you stand.
   const label = (text, x, z, size = 0.45) => {
      const node = panel.add().move(x, 0.002, z).turnX(-Math.PI / 2).scale(size);
      node.add().move(-text.length * inch / 4, 0, 0).add(textForm(text)).color(0.9, 0.9, 0.95);
      return node;
   };

   panel.add("cube").move(0, -0.012, 0).scale(0.27, 0.01, 0.13).color(0.15, 0.16, 0.2);
   // The stand stops below the tilted underside, so its top doesn't poke through the panel.
   const standTop = PANEL_POS[1] - 0.05;
   model.add("cube").move(PANEL_POS[0], standTop / 2, PANEL_POS[2]).scale(0.04, standTop / 2, 0.04).color(0.1, 0.1, 0.12);
   label("SPIN", TOGGLE[0], ROW_TOP + 0.045);
   label("SPEED", DIAL[0], ROW_TOP + 0.045);
   label("COLOR", -0.14, ROW_BOTTOM + 0.045);
   label("SIZE", (SLIDER.x0 + SLIDER.x1) / 2, ROW_BOTTOM + 0.045);

   const buttons = SHAPES.map(s => {
      panel.add("tubeY").move(s.x, 0.002, ROW_TOP).scale(0.026, 0.002, 0.026).color(0.05, 0.05, 0.05);
      const cap = panel.add("tubeY");
      label(s.label, s.x, ROW_TOP + 0.04, 0.4);
      return cap;
   });

   panel.add("cube").move(TOGGLE[0], 0.006, TOGGLE[1]).scale(0.018, 0.006, 0.026).color(0.08, 0.08, 0.1);
   const lever = panel.add();
   const leverStick = lever.add("cube").move(0, 0.025, 0).scale(0.005, 0.025, 0.005);
   const leverTip = lever.add("sphere").move(0, 0.052, 0).scale(0.009);

   panel.add("tubeY").move(DIAL[0], 0.008, DIAL[1]).scale(0.03, 0.008, 0.03).color(0.3, 0.3, 0.35);
   const dialMarks = panel.add();
   for (let k = 0; k <= 8; k++) {
      const a = (-135 + k * 33.75) * Math.PI / 180;
      dialMarks.add("cube").move(DIAL[0] + Math.sin(a) * 0.04, 0.002, DIAL[1] - Math.cos(a) * 0.04)
         .turnY(-a).scale(0.0015, 0.001, 0.006).color(0.8, 0.8, 0.85);
   }
   const pointer = panel.add();
   pointer.add("cube").move(0, 0.018, -0.017).scale(0.003, 0.003, 0.014).color(1, 0.85, 0.2);

   panel.add("cube").move((SLIDER.x0 + SLIDER.x1) / 2, 0.002, SLIDER.z).scale((SLIDER.x1 - SLIDER.x0) / 2, 0.002, 0.004).color(0.05, 0.05, 0.05);
   const knob = panel.add("cube");

   const swatches = COLORS.map((c, k) => ({ node: panel.add("cube"), x: -0.22 + k * 0.04, color: c }));

   const readout = panel.add().move(-0.25, 0.002, 0.115).turnX(-Math.PI / 2).scale(0.4);
   let readoutText = "";

   // The shape the panel controls.
   const holder = model.add();
   let body = null;
   const showShape = () => {
      if (body)
         holder.remove(body);
      body = holder.add(SHAPES[shape].form);
   };
   showShape();

   // Everything is worked out in the panel's own coordinates (x across, z toward you, y up off the surface).
   const toPanel = p => cg.mTransform(cg.mInverse(panel.getMatrix()), p);
   const near = (p, x, z, r = REACH) => Math.hypot(p[0] - x, p[2] - z) < r && p[1] > -0.02 && p[1] < 0.08;
   const knobX = () => SLIDER.x0 + size * (SLIDER.x1 - SLIDER.x0);

   inputEvents.onPress = hand => {
      const world = inputEvents.pos(hand);
      if (!world)
         return;
      const p = toPanel(world);
      SHAPES.forEach((s, k) => {
         if (near(p, s.x, ROW_TOP)) {
            shape = k;
            pressTime[k] = model.time;
            showShape();
         }
      });
      if (near(p, TOGGLE[0], TOGGLE[1]))
         spinning = !spinning;
      if (near(p, DIAL[0], DIAL[1], 0.045))
         drag = { hand, type: "dial", startX: p[0], startValue: speed };
      if (near(p, knobX(), SLIDER.z) || (p[0] > SLIDER.x0 - 0.01 && p[0] < SLIDER.x1 + 0.01 && near(p, p[0], SLIDER.z, 0.02)))
         drag = { hand, type: "slider" };
      swatches.forEach((s, k) => {
         if (near(p, s.x, ROW_BOTTOM, 0.02))
            colorIndex = k;
      });
   };

   inputEvents.onDrag = hand => {
      const world = inputEvents.pos(hand);
      if (!drag || drag.hand !== hand || !world)
         return;
      const p = toPanel(world);
      if (drag.type === "slider")
         size = clamp((p[0] - SLIDER.x0) / (SLIDER.x1 - SLIDER.x0), 0, 1);
      else
         speed = clamp(drag.startValue + (p[0] - drag.startX) * 5, 0, 1);
   };

   inputEvents.onRelease = hand => {
      if (drag && drag.hand === hand)
         drag = null;
   };

   let lastTime = model.time;

   model.animate(() => {
      const dt = clamp(model.time - lastTime, 0, 0.1) || 0;
      lastTime = model.time;

      // A pressed button sinks for a moment; the selected one stays lit.
      buttons.forEach((cap, k) => {
         const sink = model.time - pressTime[k] < 0.15 ? 0.004 : 0;
         const lit = k === shape;
         cap.identity().move(SHAPES[k].x, 0.012 - sink, ROW_TOP).scale(0.022, 0.008, 0.022)
            .color(...(lit ? [1, 0.85, 0.3] : [0.45, 0.4, 0.3]));
      });

      lever.identity().move(TOGGLE[0], 0.012, TOGGLE[1]).turnX(spinning ? -0.5 : 0.5);
      leverStick.color(0.75, 0.75, 0.8);
      leverTip.color(...(spinning ? [0.3, 1, 0.4] : [1, 0.3, 0.3]));

      pointer.identity().move(DIAL[0], 0, DIAL[1]).turnY(-(-135 + 270 * speed) * Math.PI / 180);
      knob.identity().move(knobX(), 0.01, SLIDER.z).scale(0.008, 0.01, 0.014)
         .color(...(drag && drag.type === "slider" ? [1, 0.85, 0.3] : [0.85, 0.85, 0.9]));
      swatches.forEach((s, k) => s.node.identity().move(s.x, k === colorIndex ? 0.012 : 0.005, ROW_BOTTOM)
         .scale(0.014, k === colorIndex ? 0.012 : 0.005, 0.014).color(...s.color));

      const text = `SIZE ${Math.round(size * 100)}%   SPEED ${Math.round(speed * 100)}%   SPIN ${spinning ? "ON" : "OFF"}`;
      if (text !== readoutText) {
         readoutText = text;
         while (readout.nChildren()) readout.remove(0);
         readout.add(textForm(text)).color(0.3, 0.9, 1);
      }

      if (spinning)
         angle += speed * 3 * dt;
      holder.identity().move(TARGET_POS).turnY(angle).turnX(angle * 0.6).scale(0.04 + 0.12 * size);
      body.color(...COLORS[colorIndex]);
   });
};
