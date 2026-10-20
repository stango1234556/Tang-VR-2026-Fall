import * as cg from "../render/core/cg.js";
import { stl } from "../render/core/stl.js";

/*
   SO101 pick-and-place planner, based on the SO101 scene.
   You set up the job, the robot shows its plan, then you run it.
   - Right trigger: drag the red block or the blue pad around the table.
   - Left trigger: run the plan (pick up the block and place it on the pad).

   Annotations
   - Ghost arms at the pick and place poses: green if the pose works, red if not.
   - Planned path: the exact route the gripper will take.
   - Reach outline: where the gripper can reach pointing straight down.
   - Dimension lines: distance from the base to the block, and from the block to the pad.
   - Dashboard: a dial per joint (red ends are the limits), motor load, and what the robot is doing.

   Console helpers: run(), toggleOutline()
*/

const BASE_POS = [0, 0.85, -0.35];
const TABLE_HALF = 0.32;
const TABLE_Y = BASE_POS[1] - 0.0024;
const BLOCK_HALF = 0.0125;
const BLOCK_MASS = 0.02;
const GRASP_Y = TABLE_Y + BLOCK_HALF;
const LIFT_HEIGHT = 0.07;
const STALL_TORQUE = 1.9;            // STS3215 servo stall torque at 7.4 V, in N*m
const GRIP_OPEN = 0.4;               // how far each jaw tilts open, in radians
const GRIP_CLOSED = 0;
const GRIP_HOLD = 0.2;
const JAW_CUT_Z = 0.044;
const JAW_PIVOT = [-0.024, 0, 0.044];
const SPEED = 0.12;
const GHOST_OPACITY = 0.3;
const DOWN = [0, -1, 0];
const ORIENT_WEIGHT = 0.05;
const DAMPING = 1e-4;
const IK_JOINTS = [0, 1, 2, 3];
const JOINT_LABELS = ["pan", "lift", "elbow", "wrist"];
const PANEL_POS = [BASE_POS[0] - 0.62, BASE_POS[1] + 0.45, BASE_POS[2] + 0.2];

const GREEN = [0.3, 1, 0.4];
const YELLOW = [1, 0.85, 0.2];
const RED = [1, 0.3, 0.25];
const WHITE = [1, 1, 1];
const GRAY = [0.6, 0.6, 0.65];
const CYAN = [0.3, 0.9, 1];

export const init = async model => {
   const printed = [1, .82, .12], motor = [.1, .1, .1];

   const links = {
      base_link: [
         { stl: 'base_motor_holder_so101_v1'       , xyz: [-0.00636471, -0.0000994414, -0.0024], rpy: [1.5708, 0, 1.5708], color: printed },
         { stl: 'base_so101_v2'                    , xyz: [-0.00636471, 0, -0.0024], rpy: [1.5708, 0, 1.5708], color: printed },
         { stl: 'sts3215_03a_v1'                   , xyz: [0.0263353, 0, 0.0437], rpy: [0, 0, 0], color: motor },
         { stl: 'waveshare_mounting_plate_so101_v2', xyz: [-0.0309827, -0.000199441, 0.0474], rpy: [1.5708, 0, 1.5708], color: printed },
      ],
      shoulder_link: [
         { stl: 'sts3215_03a_v1'            , xyz: [-0.0303992, 0.000422241, -0.0417], rpy: [1.5708, 1.5708, 0], color: motor },
         { stl: 'motor_holder_so101_base_v1', xyz: [-0.0675992, -0.000177759, 0.0158499], rpy: [1.5708, -1.5708, 0], color: printed },
         { stl: 'rotation_pitch_so101_v1'   , xyz: [0.0122008, 0.0000222413, 0.0464], rpy: [-1.5708, 0, 0], color: printed },
      ],
      upper_arm_link: [
         { stl: 'sts3215_03a_v1'    , xyz: [-0.11257, -0.0155, 0.0187], rpy: [-3.14159, 0, -1.5708], color: motor },
         { stl: 'upper_arm_s0101_v1', xyz: [-0.065085, 0.012, 0.0182], rpy: [3.14159, 0, 0], color: printed },
      ],
      lower_arm_link: [
         { stl: 'under_arm_so101_v1'         , xyz: [-0.0648499, -0.032, 0.0182], rpy: [3.14159, 0, 0], color: printed },
         { stl: 'motor_holder_so101_wrist_v1', xyz: [-0.0648499, -0.032, 0.018], rpy: [-3.14159, 0, 0], color: printed },
         { stl: 'sts3215_03a_v1'             , xyz: [-0.1224, 0.0052, 0.0187], rpy: [-3.14159, 0, -3.14159], color: motor },
      ],
      wrist_link: [
         { stl: 'sts3215_03a_no_horn_v1'   , xyz: [0, -0.0424, 0.0306], rpy: [1.5708, 1.5708, 0], color: motor },
         { stl: 'wrist_roll_pitch_so101_v2', xyz: [0, -0.028, 0.0181], rpy: [-1.5708, -1.5708, 0], color: printed },
      ],
      gripper_link: [
         { stl: 'sts3215_03a_v1'              , xyz: [0.0077, 0.0001, -0.0234], rpy: [-1.5708, 0, 0], color: motor },
         { stl: 'wrist_roll_follower_so101_v1', xyz: [0, -0.000218214, 0.000949706], rpy: [-3.14159, 0, 0], color: printed, split: true },
      ],
      gripper_frame_link: [],
      moving_jaw_so101_v1_link: [
         { stl: 'moving_jaw_so101_v1', xyz: [0, 0, 0.0189], rpy: [0, 0, 0], color: printed },
      ],
   };

   const joints = [
      { name: 'shoulder_pan' , parent: 'robotBaseFrame', xyz: [ 0.0388353,  0          ,  0.0624   ], rpy: [ 3.14159, 0        , -3.14159], lo: -1.91986 , hi: 1.91986, link: 'shoulder_link'            },
      { name: 'shoulder_lift', parent: 'shoulder_pan'  , xyz: [-0.0303992, -0.0182778  , -0.0542   ], rpy: [-1.5708 ,-1.5708   ,  0      ], lo: -1.74533 , hi: 1.74533, link: 'upper_arm_link'           },
      { name: 'elbow_flex'   , parent: 'shoulder_lift' , xyz: [-0.11257  , -0.028      ,  0        ], rpy: [ 0      , 0        ,  1.5708 ], lo: -1.69    , hi: 1.69   , link: 'lower_arm_link'           },
      { name: 'wrist_flex'   , parent: 'elbow_flex'    , xyz: [-0.1349   ,  0.0052     ,  0        ], rpy: [ 0      , 0        , -1.5708 ], lo: -1.65806 , hi: 1.65806, link: 'wrist_link'               },
      { name: 'wrist_roll'   , parent: 'wrist_flex'    , xyz: [ 0        , -0.0611     ,  0.0181   ], rpy: [ 1.5708 , 0.0486795,  3.14159], lo: -2.74385 , hi: 2.84121, link: 'gripper_link'             },
      { name: 'gripper'      , parent: 'wrist_roll'    , xyz: [ 0.0202   ,  0.0188     , -0.0234   ], rpy: [ 1.5708 , 0        ,  0      ], lo: -0.174533, hi: 1.74533, link: 'moving_jaw_so101_v1_link' },
      { name: 'gripper_frame', parent: 'wrist_roll'    , xyz: [-0.0079   , -0.000218121, -0.0981274], rpy: [ 0      , 3.14159  ,  0      ], fixed: true,                link: 'gripper_frame_link'       },
   ];

   // The fixed jaw is part of the gripper body mesh, so cut it into its own mesh to let it hinge open.
   const loadSplitMesh = async file => {
      const text = await (await fetch('media/stl/SO101/' + file + '.stl')).text();
      const body = [], jaw = [];
      const facets = text.split('facet ');
      for (let n = 1; n < facets.length; n++) {
         const D = facets[n].split(' ');
         const V = [D[15], D[16], D[17], D[1], D[2], D[3],
                    D[24], D[25], D[26], D[1], D[2], D[3],
                    D[33], D[34], D[35], D[1], D[2], D[3]].map(parseFloat);
         const isJaw = (V[2] + V[8] + V[14]) / 3 > JAW_CUT_Z;
         (isJaw ? jaw : body).push(V.slice(0, 6), V.slice(6, 12), V.slice(12, 18));
      }
      clay.defineMesh('SO101/' + file + '_body', clay.trianglesMesh(body));
      clay.defineMesh('SO101/' + file + '_jaw', clay.trianglesMesh(jaw));
   };

   for (const meshList of Object.values(links))
      for (const mesh of meshList) {
         if (mesh.split)
            loadSplitMesh(mesh.stl);
         else
            stl('SO101/' + mesh.stl);
      }

   const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
   const origin = m => [m[12], m[13], m[14]];
   const horizontal = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
   const inch = 0.0254;

   // Forward kinematics, matching how the SO101 scene poses each joint.
   const isZJoint = i => i === 0 || i === 2 || i === 3;
   const BASE = cg.mMultiply(cg.mTranslate(BASE_POS), cg.mRotateX(-Math.PI / 2));

   const jointMatrix = (j, i, angles) => {
      let x = j.rpy[0], y = j.rpy[1], z = j.rpy[2];
      if (!j.fixed) {
         if (isZJoint(i))
            z += angles[i];
         else
            y += angles[i];
      }
      let M = cg.mTranslate(j.xyz);
      M = cg.mMultiply(M, cg.mRotateZ(z));
      M = cg.mMultiply(M, cg.mRotateY(y));
      return cg.mMultiply(M, cg.mRotateX(x));
   };

   const fk = angles => {
      const M = { robotBaseFrame: BASE };
      joints.forEach((j, i) => M[j.name] = cg.mMultiply(M[j.parent], jointMatrix(j, i, angles)));
      return M;
   };

   const tipOf = M => origin(M.gripper_frame);
   const toolAxis = M => cg.normalize(cg.subtract(tipOf(M), origin(M.wrist_roll)));

   const solveLinear = (A, b) => {
      const n = b.length;
      const M = A.map((row, i) => [...row, b[i]]);
      for (let c = 0; c < n; c++) {
         let p = c;
         for (let r = c + 1; r < n; r++)
            if (Math.abs(M[r][c]) > Math.abs(M[p][c]))
               p = r;
         [M[c], M[p]] = [M[p], M[c]];
         for (let r = c + 1; r < n; r++) {
            const f = M[r][c] / M[c][c];
            for (let k = c; k <= n; k++)
               M[r][k] -= f * M[c][k];
         }
      }
      const x = new Array(n).fill(0);
      for (let r = n - 1; r >= 0; r--) {
         let s = M[r][n];
         for (let k = r + 1; k < n; k++)
            s -= M[r][k] * x[k];
         x[r] = s / M[r][r];
      }
      return x;
   };

   // Damped least squares: move the tip to the target while keeping the gripper pointing down.
   const solveIK = (angles, target, iterations) => {
      const task = M => [...tipOf(M), ...cg.scale(toolAxis(M), ORIENT_WEIGHT)];
      const goal = [...target, ...cg.scale(DOWN, ORIENT_WEIGHT)];
      for (let it = 0; it < iterations; it++) {
         const current = task(fk(angles));
         const e = cg.subtract(goal, current);
         if (cg.norm(e.slice(0, 3)) < 0.0005)
            break;
         const J = IK_JOINTS.map(k => {
            const probe = angles.slice();
            probe[k] += 1e-4;
            return cg.scale(cg.subtract(task(fk(probe)), current), 1e4);
         });
         const A = J.map((a, r) => J.map((b, c) => cg.dot(a, b) + (r === c ? DAMPING : 0)));
         const dq = solveLinear(A, J.map(col => cg.dot(col, e)));
         IK_JOINTS.forEach((k, i) => {
            angles[k] = clamp(angles[k] + clamp(dq[i], -0.15, 0.15), joints[k].lo, joints[k].hi);
         });
      }
      return cg.distance(tipOf(fk(angles)), target);
   };

   // A pose works if the gripper gets there pointing straight down, without any joint dipping into the table.
   const clearsTable = M => ["shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll"]
      .every(n => origin(M[n])[1] > TABLE_Y + 0.01);

   const HOME = [0, -0.6, 0.8, 0.9, 0, 0];

   const solvePose = (seed, p, iterations = 30, tryHome = true) => {
      let best = null;
      for (const start of tryHome ? [seed, HOME] : [seed]) {
         const angles = start.slice();
         const err = solveIK(angles, p, iterations);
         const M = fk(angles);
         const ok = err < 0.005 && toolAxis(M)[1] < -0.85 && clearsTable(M);
         if (!best || (ok && !best.ok) || (ok === best.ok && err < best.err))
            best = { q: angles, ok, err };
      }
      return best;
   };

   // Reach outline: for each direction around the base, the nearest and farthest spot the gripper can reach.
   const tableLimit = dir => Math.min(TABLE_HALF / Math.max(Math.abs(dir[0]), 1e-6), TABLE_HALF / Math.max(Math.abs(dir[2]), 1e-6)) - 0.015;

   const zone = [];
   const R_STEP = 0.012;
   let rowSeed = HOME.slice();
   for (let deg = -180; deg < 180; deg += 8) {
      const th = deg * Math.PI / 180;
      const dir = [Math.cos(th), 0, Math.sin(th)];
      const limit = tableLimit(dir);
      let rMin = null, rMax = null;
      let seed = rowSeed.slice();
      for (let r = 0.06; r <= limit; r += R_STEP) {
         const pose = solvePose(seed, [BASE_POS[0] + dir[0] * r, GRASP_Y, BASE_POS[2] + dir[2] * r], 20, rMin === null);
         if (pose.ok) {
            seed = pose.q;
            if (rMin === null) {
               rMin = r;
               rowSeed = pose.q;
            }
            rMax = r;
         }
      }
      zone.push({ th, dir, rMin, rMax, atEdge: rMax !== null && rMax > limit - R_STEP - 0.001 });
   }

   const zonePoint = (z, r) => [BASE_POS[0] + z.dir[0] * r, TABLE_Y + 0.0015, BASE_POS[2] + z.dir[2] * r];

   const outlineRods = [];
   const rod = (a, b) => outlineRods.push({ type: "rod", a, b, width: 0.004, nSides: 4, rgb: [0.3, 0.95, 0.45] });
   zone.forEach((z, i) => {
      const next = zone[(i + 1) % zone.length];
      if (z.rMax === null)
         return;
      if (next.rMax !== null) {
         if (!z.atEdge && !next.atEdge)
            rod(zonePoint(z, z.rMax), zonePoint(next, next.rMax));
         rod(zonePoint(z, z.rMin), zonePoint(next, next.rMin));
      }
      const prev = zone[(i - 1 + zone.length) % zone.length];
      if (next.rMax === null || prev.rMax === null)
         rod(zonePoint(z, z.rMin), zonePoint(z, z.rMax));
   });
   if (outlineRods.length)
      clay.defineDataMesh("hw5reachOutline", outlineRods);

   const spotNear = deg => {
      const usable = zone.filter(z => z.rMax !== null);
      if (!usable.length)
         return [BASE_POS[0], GRASP_Y, BASE_POS[2] + 0.18];
      const th = deg * Math.PI / 180;
      const gap = z => Math.abs(Math.atan2(Math.sin(z.th - th), Math.cos(z.th - th)));
      const z = usable.reduce((a, b) => gap(a) < gap(b) ? a : b);
      const p = zonePoint(z, (z.rMin + z.rMax) / 2);
      return [p[0], GRASP_Y, p[2]];
   };

   // The real arm and the two see-through ghosts are all built the same way.
   const makeRobot = () => {
      const base = model.add();
      const node = { robotBaseFrame: base };
      for (const j of joints)
         node[j.name] = node[j.parent].add();
      const parts = [];
      const created = new Set();
      let jawHinge = null;

      const robot = {
         ensureParts: () => {
            for (const [linkName, meshList] of Object.entries(links)) {
               const parentName = linkName === "base_link" ? "robotBaseFrame" : joints.find(j => j.link === linkName).name;
               for (const mesh of meshList) {
                  const partName = 'SO101/' + mesh.stl + (mesh.split ? '_body' : '');
                  if (created.has(mesh) || !clay.formMesh(partName))
                     continue;
                  const place = n => n.move(mesh.xyz).turnZ(mesh.rpy[2]).turnY(mesh.rpy[1]).turnX(mesh.rpy[0]);
                  parts.push({ node: place(node[parentName].add(partName)), color: mesh.color });
                  if (mesh.split) {
                     jawHinge = place(node[parentName].add()).add();
                     parts.push({ node: jawHinge.add('SO101/' + mesh.stl + '_jaw'), color: mesh.color });
                  }
                  for (const p of parts)
                     p.node.color(...p.color);
                  created.add(mesh);
               }
            }
         },
         pose: (angles, grip) => {
            const a = angles.slice();
            a[5] = -grip;
            joints.forEach((j, i) => node[j.name].setMatrix(jointMatrix(j, i, a)));
            if (jawHinge)
               jawHinge.identity().move(JAW_PIVOT).turnY(-grip).move(cg.scale(JAW_PIVOT, -1));
         },
         show: visible => {
            base.identity();
            if (visible)
               base.move(BASE_POS).turnX(-Math.PI / 2);
            else
               base.scale(0);
         },
         tint: color => {
            for (const p of parts)
               p.node.color(...color).opacity(GHOST_OPACITY);
         },
      };
      robot.show(true);
      return robot;
   };

   const arm = makeRobot();
   const pickGhost = makeRobot();
   const placeGhost = makeRobot();

   let blockPos = spotNear(60);
   let padPos = spotNear(125);
   let pickPose = solvePose(HOME, blockPos);
   let placePose = solvePose(HOME, padPos);

   const q = HOME.slice();
   let target = [blockPos[0], GRASP_Y + LIFT_HEIGHT, blockPos[2]];
   solveIK(q, target, 60);

   let grip = GRIP_OPEN;
   let gripClosed = false;
   let holding = false;
   let running = false;
   let path = [];
   let step = 0;
   let wait = 0;
   let dragging = null;
   let showOutline = true;
   let status = "Move the block and pad, then press the left trigger.";
   let tip = tipOf(fk(q));

   const above = p => [p[0], GRASP_Y + LIFT_HEIGHT, p[2]];
   const at = p => [p[0], GRASP_Y, p[2]];

   // Over the block, down, grab, up, an arc over to the pad, down, release, up.
   const buildPath = from => {
      const points = [{ p: from, label: "Moving over the block" }, { p: above(blockPos), label: "Lowering onto the block" },
                      { p: at(blockPos), action: "close", label: "Lifting the block" }, { p: above(blockPos), label: "Carrying it to the pad" }];
      const a = above(blockPos), b = above(padPos);
      const mid = cg.add(cg.mix(a, b, 0.5), [0, 0.06, 0]);
      for (let i = 1; i < 8; i++) {
         const t = i / 8;
         const p = cg.add(cg.add(cg.scale(a, (1 - t) * (1 - t)), cg.scale(mid, 2 * t * (1 - t))), cg.scale(b, t * t));
         points.push({ p, label: "Carrying it to the pad" });
      }
      points.push({ p: b, label: "Lowering onto the pad" }, { p: at(padPos), action: "open", label: "Backing away" }, { p: b, label: "Done" });
      return points;
   };

   const planOK = () => pickPose.ok && placePose.ok;

   const replan = () => {
      pickPose = solvePose(pickPose.q, blockPos, 15);
      placePose = solvePose(placePose.q, padPos, 15);
   };

   const run = () => {
      if (running)
         return;
      if (!planOK()) {
         status = "Can't run: move the red parts of the plan into the green outline.";
         return;
      }
      path = buildPath(tip.slice());
      step = 0;
      wait = 0;
      running = true;
   };

   const updateRun = dt => {
      const next = path[step + 1];
      status = path[step].label;
      if (!next) {
         running = false;
         replan();
         status = "Done! Move the pad somewhere else and run again.";
         return;
      }
      const d = cg.subtract(next.p, target);
      const dist = cg.norm(d);
      if (dist > SPEED * dt) {
         target = cg.add(target, cg.scale(d, SPEED * dt / dist));
         return;
      }
      target = next.p.slice();
      if (next.action && wait === 0) {
         if (next.action === "close") {
            gripClosed = true;
            holding = true;
         } else {
            gripClosed = false;
            holding = false;
            blockPos = at(padPos);
         }
      }
      wait += dt;
      if (next.action && wait < 0.5)
         return;
      wait = 0;
      step++;
   };

   model.add("cube").move(BASE_POS[0], TABLE_Y - 0.01, BASE_POS[2]).scale(TABLE_HALF, 0.01, TABLE_HALF).color(0.3, 0.32, 0.36);
   model.add("cube").move(BASE_POS[0], (TABLE_Y - 0.02) / 2, BASE_POS[2]).scale(0.05, (TABLE_Y - 0.02) / 2, 0.05).color(0.2, 0.2, 0.22);

   const annot = model.add();
   const blockNode = annot.add("cube");
   const padNode = annot.add("diskY");
   const shadow = annot.add("diskY");
   const dropLine = annot.add("tubeZ");
   const outline = outlineRods.length ? annot.add("hw5reachOutline") : null;
   const pathNodes = Array.from({ length: 20 }, () => annot.add("tubeZ"));
   const dimNodes = Array.from({ length: 6 }, () => annot.add("tubeZ"));

   const setLine = (n, a, b, r, color) => {
      if (!a || !b || cg.distance(a, b) < 1e-4)
         n.identity().scale(0);
      else
         n.identity().link(a, b, r).color(...color);
   };

   // clay.text makes a new mesh per call, so reuse one mesh per distinct string.
   const textForms = new Map();
   const textForm = s => {
      if (!textForms.has(s))
         textForms.set(s, clay.text(s));
      return textForms.get(s);
   };

   const makeText = (parent, pos, size, align = "left") => {
      const holder = parent.add().move(pos).scale(size);
      const t = { holder, text: null, glyphs: null };
      t.set = (text, color = WHITE) => {
         if (text !== t.text) {
            if (t.glyphs)
               holder.remove(t.glyphs);
            t.glyphs = null;
            if (text) {
               const width = Math.max(...text.split("\n").map(l => l.length));
               t.glyphs = holder.add().move(align === "center" ? -width * inch / 4 : 0, 0, 0);
               t.glyphs.add(textForm(text));
            }
            t.text = text;
         }
         if (t.glyphs)
            t.glyphs.child(0).color(...color);
      };
      return t;
   };

   const dimLabels = [0, 1].map(() => {
      const node = annot.add();
      return { node, text: makeText(node, [0, 0, 0], 1, "center") };
   });

   // A dimension line flat on the table, with end ticks and a label you read looking down.
   const drawDimension = (k, a, b, label) => {
      const lift = p => [p[0], TABLE_Y + 0.003, p[2]];
      const A = lift(a), B = lift(b);
      const d = cg.normalize(cg.subtract(B, A));
      const side = cg.scale([-d[2], 0, d[0]], 0.008);
      setLine(dimNodes[3 * k], A, B, 0.0008, WHITE);
      setLine(dimNodes[3 * k + 1], cg.subtract(A, side), cg.add(A, side), 0.0008, WHITE);
      setLine(dimNodes[3 * k + 2], cg.subtract(B, side), cg.add(B, side), 0.0008, WHITE);
      const mid = cg.mix(A, B, 0.5);
      dimLabels[k].node.identity().move(mid[0], mid[1], mid[2] + 0.012).turnX(-Math.PI / 2).scale(0.45);
      dimLabels[k].text.set(label);
   };

   const panel = model.add().move(PANEL_POS).turnY(0.6);
   panel.add("cube").move(0.16, -0.19, -0.006).scale(0.17, 0.2, 0.003).color(0.08, 0.08, 0.12);
   makeText(panel, [0, 0, 0], 0.55).set("ROBOT PICK AND PLACE");
   const statusText = makeText(panel, [0, -0.03, 0], 0.42);
   const planText = makeText(panel, [0, -0.07, 0], 0.42);
   makeText(panel, [0, -0.1, 0], 0.4).set("JOINTS (red = joint limit)", GRAY);
   makeText(panel, [0, -0.235, 0], 0.4).set("MOTOR LOAD (rough estimate)", GRAY);
   makeText(panel, [0, -0.315, 0], 0.33).set(
      "Green outline: gripper can reach straight down\n" +
      "Ghost arms: the planned pick and place poses\n" +
      "Right trigger: move the block or the pad\n" +
      "Left trigger: run the plan", GRAY);

   // A dial per joint: the arc is the joint's full range, the needle is where it is now.
   const dialAngle = t => (210 - 240 * t) * Math.PI / 180;
   const dials = IK_JOINTS.map(i => {
      const c = [0.04 + i * 0.08, -0.15, 0.001];
      const r = 0.026;
      const point = (t, s) => [c[0] + s * Math.cos(dialAngle(t)), c[1] + s * Math.sin(dialAngle(t)), c[2]];
      const N = 20;
      for (let s = 0; s < N; s++) {
         const t0 = s / N, t1 = (s + 1) / N;
         const nearLimit = t0 < 0.06 || t1 > 0.94;
         panel.add("tubeZ").link(point(t0, r), point(t1, r), 0.0012).color(...(nearLimit ? RED : GRAY));
      }
      makeText(panel, [c[0], c[1] - 0.034, 0], 0.35, "center").set(JOINT_LABELS[i]);
      return { i, c, point, needle: panel.add("tubeZ"), value: makeText(panel, [c[0], c[1] - 0.048, 0], 0.35, "center") };
   });

   const bars = ["lift", "elbow"].map((name, k) => {
      const y = -0.262 - k * 0.026;
      makeText(panel, [0, y + 0.005, 0], 0.35).set(name);
      panel.add("cube").move(0.16, y, 0.001).scale(0.1, 0.004, 0.001).color(0.2, 0.2, 0.25);
      return { y, fill: panel.add("cube"), value: makeText(panel, [0.27, y + 0.005, 0], 0.35) };
   });

   const limitMargin = (angles, i) => Math.min(angles[i] - joints[i].lo, joints[i].hi - angles[i]) / (joints[i].hi - joints[i].lo);
   const marginColor = m => m < 0.05 ? RED : m < 0.15 ? YELLOW : GREEN;
   const loadColor = pct => pct > 70 ? RED : pct > 40 ? YELLOW : GREEN;

   // Rough mass model (kg): links at their midpoints, motors at the joints.
   const motorLoad = M => {
      const lift = origin(M.shoulder_lift), elbow = origin(M.elbow_flex), wrist = origin(M.wrist_flex);
      const masses = [
         { m: 0.08, at: cg.mix(lift, elbow, 0.5), level: 1 },
         { m: 0.055, at: elbow, level: 1 },
         { m: 0.06, at: cg.mix(elbow, wrist, 0.5), level: 2 },
         { m: 0.11, at: cg.mix(wrist, tip, 0.5), level: 2 },
      ];
      if (holding)
         masses.push({ m: BLOCK_MASS, at: tip, level: 2 });
      const torque = (pivot, level) => masses
         .filter(s => s.level >= level)
         .reduce((t, s) => t + s.m * 9.81 * horizontal(s.at, pivot), 0);
      return [Math.round(100 * torque(lift, 1) / STALL_TORQUE), Math.round(100 * torque(elbow, 2) / STALL_TORQUE)];
   };

   const onTable = p => [
      clamp(p[0], BASE_POS[0] - TABLE_HALF + 0.02, BASE_POS[0] + TABLE_HALF - 0.02),
      GRASP_Y,
      clamp(p[2], BASE_POS[2] - TABLE_HALF + 0.02, BASE_POS[2] + TABLE_HALF - 0.02),
   ];

   inputEvents.onPress = hand => {
      const p = inputEvents.pos(hand);
      if (!p || running)
         return;
      if (hand === "left") {
         run();
         return;
      }
      if (horizontal(p, blockPos) < 0.04 && Math.abs(p[1] - GRASP_Y) < 0.08)
         dragging = "block";
      else if (horizontal(p, padPos) < 0.04 && Math.abs(p[1] - GRASP_Y) < 0.08)
         dragging = "pad";
   };

   inputEvents.onDrag = hand => {
      const p = inputEvents.pos(hand);
      if (hand !== "right" || !dragging || !p)
         return;
      if (dragging === "block")
         blockPos = onTable(p);
      else
         padPos = onTable(p);
      replan();
   };

   inputEvents.onRelease = hand => {
      if (hand === "right")
         dragging = null;
   };

   window.run = run;
   window.toggleOutline = () => showOutline = !showOutline;

   let lastTime = model.time;

   model.animate(() => {
      const dt = Math.min(0.1, model.time - lastTime);
      lastTime = model.time;

      for (const robot of [arm, pickGhost, placeGhost])
         robot.ensureParts();

      if (running)
         updateRun(dt);
      solveIK(q, target, 8);

      const gripGoal = holding ? GRIP_HOLD : gripClosed ? GRIP_CLOSED : GRIP_OPEN;
      grip += (gripGoal - grip) * Math.min(1, dt * 8);
      arm.pose(q, grip);

      const M = fk(q);
      tip = tipOf(M);
      if (holding)
         blockPos = tip.slice();

      const ok = planOK();
      pickGhost.show(!running);
      placeGhost.show(!running);
      if (!running) {
         pickGhost.pose(pickPose.q, GRIP_OPEN);
         placeGhost.pose(placePose.q, GRIP_HOLD);
         pickGhost.tint(pickPose.ok ? GREEN : RED);
         placeGhost.tint(placePose.ok ? GREEN : RED);
      }

      const route = running ? path.slice(step).map(s => s.p) : buildPath(tip).map(s => s.p);
      if (running)
         route[0] = target;
      pathNodes.forEach((n, k) => setLine(n, route[k], route[k + 1], 0.0012, running || ok ? CYAN : RED));

      blockNode.identity().move(blockPos).scale(BLOCK_HALF).color(0.9, 0.25, 0.3);
      padNode.identity().move(padPos[0], TABLE_Y + 0.0012, padPos[2]).scale(0.022, 0.0005, 0.022).color(0.2, 0.55, 1);
      const floor = [tip[0], TABLE_Y + 0.002, tip[2]];
      shadow.identity().move(floor).scale(0.008, 0.0005, 0.008).color(0.05, 0.05, 0.05);
      setLine(dropLine, tip, floor, 0.0006, WHITE);
      if (outline)
         outline.identity().scale(showOutline ? 1 : 0);

      const cm = (a, b) => `${(horizontal(a, b) * 100).toFixed(1)} cm`;
      drawDimension(0, BASE_POS, blockPos, cm(BASE_POS, blockPos));
      drawDimension(1, blockPos, padPos, cm(blockPos, padPos));

      statusText.set(status, CYAN);
      if (running)
         planText.set("Running the plan...", WHITE);
      else if (ok)
         planText.set("Plan OK: press the left trigger", GREEN);
      else {
         const what = !pickPose.ok && !placePose.ok ? "Block and pad" : !pickPose.ok ? "Block" : "Pad";
         planText.set(`${what} out of reach (red ghost)`, RED);
      }

      for (const d of dials) {
         const j = joints[d.i];
         const t = (q[d.i] - j.lo) / (j.hi - j.lo);
         const color = marginColor(limitMargin(q, d.i));
         d.needle.identity().link(d.c, d.point(t, 0.022), 0.0018).color(...color);
         d.value.set(`${Math.round(q[d.i] * 180 / Math.PI)} deg`, color);
      }

      motorLoad(M).forEach((pct, k) => {
         const b = bars[k];
         const w = 0.1 * clamp(pct, 0, 100) / 100;
         b.fill.identity().move(0.06 + w, b.y, 0.002).scale(Math.max(w, 1e-4), 0.004, 0.001).color(...loadColor(pct));
         b.value.set(`${pct}%`, loadColor(pct));
      });
   });
};
