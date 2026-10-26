import * as cg from "../render/core/cg.js";
import { stl } from "../render/core/stl.js";
import { joyStickState } from "../render/core/controllerInput.js";

/*
   SO101 robot arm you drive joint by joint, based on the SO101 scene.
   - Left stick down / up: select the joint below / above in the panel list (or press the right trigger on a ball on the arm).
   - Right stick: move the selected joint. Joints stop at their limits and can't drive the arm into the table.
   - Left trigger: open / close the gripper. Close it around a block to pick it up; open it to drop the block
     (blocks land on the table or stack on another block).
   - The panel above your left hand lists every joint angle; Hide folds it into a small Menu button.

   Annotations
   - A dial on the selected joint: the arc is its full range (red ends are the limits), the needle is where it is.
   - A label with the selected joint's angle.
   - Green area on the table: where the gripper can reach pointing straight down.
   - A line and shadow under the gripper, to judge its height.
   - Motor effort: estimated gravity torque on the shoulder and elbow, as a percent of the servo's max torque.
*/

const BASE_POS = [0, 0.75, -0.3];
const TABLE_HALF = 0.32;
const TABLE_Y = BASE_POS[1] - 0.0024;
const BLOCK_HALF = 0.0125;
const BLOCK_MASS = 0.02;
const GRASP_Y = TABLE_Y + BLOCK_HALF;
const STALL_TORQUE = 1.9;            // STS3215 servo stall torque at 7.4 V, in N*m
const GRIP_MAX = 0.6;                // how far each jaw tilts open, in radians
const GRIP_HOLD = 0.2;               // jaw angle when closed on a block
const JAW_CUT_Z = 0.044;
const JAW_PIVOT = [-0.024, 0, 0.044];
const JOINT_SPEED = 1.2;             // radians per second at full stick
const GRIP_SPEED = 0.8;
const DOWN = [0, -1, 0];
const ORIENT_WEIGHT = 0.05;
const DAMPING = 1e-4;
const IK_JOINTS = [0, 1, 2, 3];
const ARC_RADIUS = 0.04;
const PANEL_SCALE = 0.8;
const PANEL_OFFSET = [-0.12, 0.26, 0];     // puts the panel's bottom edge just above your hand
const TAB_POS = [0, 0.04, 0];

const CONTROLS = ["base turn", "shoulder", "elbow", "wrist bend", "wrist roll", "gripper"];
const BLOCKS = [
   { name: "red", color: [0.9, 0.25, 0.3], angle: 55 },
   { name: "yellow", color: [1, 0.8, 0.2], angle: 90 },
   { name: "blue", color: [0.25, 0.5, 1], angle: 125 },
];

const YELLOW = [1, 0.85, 0.2];
const RED = [1, 0.3, 0.25];
const WHITE = [1, 1, 1];
const GRAY = [0.82, 0.82, 0.86];
const GREEN = [0.3, 1, 0.4];
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
   // If that fails for any reason, load the whole gripper normally so it still shows up.
   const loadSplitMesh = async mesh => {
      try {
         const text = await (await fetch('media/stl/SO101/' + mesh.stl + '.stl')).text();
         const body = [], jaw = [];
         const facets = text.split('facet ');
         for (let n = 1; n < facets.length; n++) {
            const D = facets[n].split(' ');
            const V = [D[15], D[16], D[17], D[1], D[2], D[3],
                       D[24], D[25], D[26], D[1], D[2], D[3],
                       D[33], D[34], D[35], D[1], D[2], D[3]].map(parseFloat);
            if (V.some(v => !Number.isFinite(v)))
               continue;
            const isJaw = (V[2] + V[8] + V[14]) / 3 > JAW_CUT_Z;
            (isJaw ? jaw : body).push(V.slice(0, 6), V.slice(6, 12), V.slice(12, 18));
         }
         if (!body.length || !jaw.length)
            throw new Error(`couldn't find the jaw in ${mesh.stl}`);
         clay.defineMesh('SO101/' + mesh.stl + '_body', clay.trianglesMesh(body));
         clay.defineMesh('SO101/' + mesh.stl + '_jaw', clay.trianglesMesh(jaw));
         console.log("[hw5_robot] gripper loaded, both jaws can open");
      } catch (err) {
         console.warn("[hw5_robot] couldn't split the gripper, loading it whole instead:", err);
         mesh.split = false;
         stl('SO101/' + mesh.stl);
      }
   };

   for (const meshList of Object.values(links))
      for (const mesh of meshList) {
         if (mesh.split)
            loadSplitMesh(mesh);
         else
            stl('SO101/' + mesh.stl);
      }

   const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
   const origin = m => [m[12], m[13], m[14]];
   const horizontal = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
   const inch = 0.0254;
   const deg = r => Math.round(r * 180 / Math.PI);

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

   // Damped least squares: move the tip to a target while keeping the gripper pointing down.
   // Only used to work out the reachable area and the starting pose.
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

   // No joint or the gripper tip may go into the table.
   const clearsTable = M => ["shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll"]
      .every(n => origin(M[n])[1] > TABLE_Y + 0.01) && tipOf(M)[1] > TABLE_Y + 0.004;

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

   // Reachable area: for each direction around the base, the nearest and farthest spot the gripper can reach.
   const tableLimit = dir => Math.min(TABLE_HALF / Math.max(Math.abs(dir[0]), 1e-6), TABLE_HALF / Math.max(Math.abs(dir[2]), 1e-6)) - 0.015;

   const zone = [];
   const R_STEP = 0.012;
   let rowSeed = HOME.slice();
   for (let d = -180; d < 180; d += 8) {
      const th = d * Math.PI / 180;
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
      zone.push({ th, dir, rMin, rMax });
   }

   const reachable = (x, z) => {
      const dx = x - BASE_POS[0], dz = z - BASE_POS[2];
      const f = (Math.atan2(dz, dx) + Math.PI) / (8 * Math.PI / 180);
      const a = zone[Math.floor(f) % zone.length], b = zone[(Math.floor(f) + 1) % zone.length], t = f - Math.floor(f);
      const r = Math.hypot(dx, dz);
      if (a.rMax === null || b.rMax === null) {
         const near = t < 0.5 ? a : b;
         return near.rMax !== null && r >= near.rMin && r <= near.rMax;
      }
      return r >= a.rMin + (b.rMin - a.rMin) * t - 0.006 && r <= a.rMax + (b.rMax - a.rMax) * t + 0.006;
   };

   const areaRods = [];
   const TILE = 0.015;
   for (let x = -TABLE_HALF + TILE / 2; x < TABLE_HALF; x += TILE)
      for (let z = -TABLE_HALF + TILE / 2; z < TABLE_HALF; z += TILE) {
         const px = BASE_POS[0] + x, pz = BASE_POS[2] + z;
         if (reachable(px, pz))
            areaRods.push({ type: "rod", a: [px, TABLE_Y + 0.0005, pz], b: [px, TABLE_Y + 0.0009, pz], width: TILE, nSides: 4, rgb: [0.35, 1, 0.5] });
      }
   if (areaRods.length)
      clay.defineDataMesh("hw5reachArea", areaRods);

   const spotNear = angle => {
      const usable = zone.filter(z => z.rMax !== null);
      if (!usable.length)
         return [BASE_POS[0], GRASP_Y, BASE_POS[2] + 0.18];
      const th = angle * Math.PI / 180;
      const gap = z => Math.abs(Math.atan2(Math.sin(z.th - th), Math.cos(z.th - th)));
      const z = usable.reduce((a, b) => gap(a) < gap(b) ? a : b);
      const r = (z.rMin + z.rMax) / 2;
      return [BASE_POS[0] + z.dir[0] * r, GRASP_Y, BASE_POS[2] + z.dir[2] * r];
   };

   // The arm itself. Meshes load in the background, so parts are added as they arrive.
   const baseNode = model.add().move(BASE_POS).turnX(-Math.PI / 2);
   const node = { robotBaseFrame: baseNode };
   for (const j of joints)
      node[j.name] = node[j.parent].add();
   const created = new Set();
   let jawHinge = null;

   const ensureParts = () => {
      for (const [linkName, meshList] of Object.entries(links)) {
         const parentName = linkName === "base_link" ? "robotBaseFrame" : joints.find(j => j.link === linkName).name;
         for (const mesh of meshList) {
            const partName = 'SO101/' + mesh.stl + (mesh.split ? '_body' : '');
            if (created.has(mesh) || !clay.formMesh(partName))
               continue;
            const place = n => n.move(mesh.xyz).turnZ(mesh.rpy[2]).turnY(mesh.rpy[1]).turnX(mesh.rpy[0]);
            place(node[parentName].add(partName)).color(...mesh.color);
            if (mesh.split) {
               jawHinge = place(node[parentName].add()).add();
               jawHinge.add('SO101/' + mesh.stl + '_jaw').color(...mesh.color);
            }
            created.add(mesh);
         }
      }
   };

   const poseArm = (angles, grip) => {
      const a = angles.slice();
      a[5] = -grip;
      joints.forEach((j, i) => node[j.name].setMatrix(jointMatrix(j, i, a)));
      if (jawHinge)
         jawHinge.identity().move(JAW_PIVOT).turnY(-grip).move(cg.scale(JAW_PIVOT, -1));
   };

   // A relaxed starting pose: every joint well inside its range, the gripper in front of the base at a
   // comfortable height, pointing as close to straight down as possible.
   const startPose = () => {
      const margin = angles => Math.min(...[0, 1, 2, 3].map(i =>
         Math.min(angles[i] - joints[i].lo, joints[i].hi - angles[i]) / (joints[i].hi - joints[i].lo)));
      let seed = 7, best = null;
      const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (let n = 0; n < 4000; n++) {
         const a = [0, 0, 0, 0, 0, 0];
         for (const i of [0, 1, 2, 3])
            a[i] = joints[i].lo + (0.2 + 0.6 * rand()) * (joints[i].hi - joints[i].lo);
         const M = fk(a), tip = tipOf(M);
         const height = tip[1] - TABLE_Y, reach = horizontal(tip, BASE_POS);
         if (!clearsTable(M) || height < 0.08 || height > 0.2 || reach < 0.12 || reach > 0.25 || tip[2] < BASE_POS[2])
            continue;
         const score = margin(a) - 0.3 * (toolAxis(M)[1] + 1);
         if (!best || score > best.score)
            best = { a, score };
      }
      return best ? best.a : HOME.slice();
   };

   let q, grip, gripGoal, holding, blocks;
   let selected = 2;
   let status = "";

   const reset = () => {
      blocks = BLOCKS.map(b => ({ ...b, pos: spotNear(b.angle) }));
      q = startPose();
      grip = gripGoal = GRIP_MAX * 0.7;
      holding = null;
      status = "Left stick picks a joint, right stick moves it.";
   };
   reset();

   // Drop a released block onto the table, or onto a block underneath it.
   const dropBlock = block => {
      let support = TABLE_Y;
      for (const other of blocks)
         if (other !== block && horizontal(other.pos, block.pos) < BLOCK_HALF * 1.8 && other.pos[1] < block.pos[1])
            support = Math.max(support, other.pos[1] + BLOCK_HALF);
      block.pos = [
         clamp(block.pos[0], BASE_POS[0] - TABLE_HALF + 0.02, BASE_POS[0] + TABLE_HALF - 0.02),
         support + BLOCK_HALF,
         clamp(block.pos[2], BASE_POS[2] - TABLE_HALF + 0.02, BASE_POS[2] + TABLE_HALF - 0.02),
      ];
   };

   model.add("cube").move(BASE_POS[0], TABLE_Y - 0.01, BASE_POS[2]).scale(TABLE_HALF, 0.01, TABLE_HALF).color(0.3, 0.32, 0.36);
   model.add("cube").move(BASE_POS[0], (TABLE_Y - 0.02) / 2, BASE_POS[2]).scale(0.05, (TABLE_Y - 0.02) / 2, 0.05).color(0.2, 0.2, 0.22);

   const annot = model.add();
   const area = areaRods.length ? annot.add("hw5reachArea") : null;
   const blockNodes = BLOCKS.map(() => annot.add("cube"));
   const shadow = annot.add("diskY");
   const dropLine = annot.add("tubeZ");
   const handles = CONTROLS.map(() => annot.add("sphere"));

   const setLine = (n, a, b, r, color) => {
      if (cg.distance(a, b) < 1e-4)
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

   // A dial for each turning joint, shown only on the selected one: the arc is the joint's range, the needle its angle.
   const M0 = fk([0, 0, 0, 0, 0, 0]);
   const dials = [0, 1, 2, 3, 4].map(i => {
      const j = joints[i];
      const frame = node[j.parent].add();
      let frameMatrix = cg.mMultiply(M0[j.parent], cg.mTranslate(j.xyz));
      if (!isZJoint(i))
         frameMatrix = cg.mMultiply(frameMatrix, cg.mRotateZ(j.rpy[2]));

      // Angle 0 on the dial points at the next part of the arm when this joint is at 0.
      const child = i < 3 ? origin(M0[joints[i + 1].name]) : i === 3 ? tipOf(M0) : origin(M0.gripper);
      const c = cg.mTransform(cg.mInverse(frameMatrix), child);
      const phi0 = isZJoint(i) ? Math.atan2(c[1], c[0]) : Math.atan2(-c[2], c[0]);
      const dir = phi => isZJoint(i) ? [Math.cos(phi), Math.sin(phi), 0] : [Math.cos(phi), 0, -Math.sin(phi)];

      const N = 24;
      for (let s = 0; s < N; s++) {
         const a = j.lo + (j.hi - j.lo) * s / N;
         const b = j.lo + (j.hi - j.lo) * (s + 1) / N;
         const nearLimit = Math.min(a - j.lo, j.hi - b) < 0.06 * (j.hi - j.lo);
         frame.add("tubeZ").link(cg.scale(dir(phi0 + a), ARC_RADIUS), cg.scale(dir(phi0 + b), ARC_RADIUS), 0.0012)
            .color(...(nearLimit ? RED : GRAY));
      }
      return { i, j, frame, phi0, dir, needle: frame.add("tubeZ") };
   });

   const placeDial = (d, visible) => {
      d.frame.identity();
      if (!visible) {
         d.frame.scale(0);
         return;
      }
      d.frame.move(d.j.xyz);
      if (!isZJoint(d.i))
         d.frame.turnZ(d.j.rpy[2]);
      d.needle.identity().link([0, 0, 0], cg.scale(d.dir(d.phi0 + q[d.i]), ARC_RADIUS * 1.3), 0.0022).color(...YELLOW);
   };

   const angleLabel = annot.add();
   const angleText = makeText(angleLabel, [0, 0, 0], 1, "center");

   // A joint's center is inside its motor, so each ball sits out along the joint's turning axis, on the side facing you.
   const VIEWER = [0, 1.5, 0.3];
   const axisOf = (i, M) => {
      const j = joints[i];
      let F = cg.mMultiply(M[j.parent], cg.mTranslate(j.xyz));
      if (!isZJoint(i))
         F = cg.mMultiply(F, cg.mRotateZ(j.rpy[2]));
      return isZJoint(i) ? [F[8], F[9], F[10]] : [F[4], F[5], F[6]];
   };
   const outward = (p, axis, d) => cg.add(p, cg.scale(axis, cg.dot(axis, cg.subtract(VIEWER, p)) < 0 ? -d : d));

   const handlePositions = M => {
      const tip = tipOf(M);
      return [
         outward(origin(M.shoulder_pan), axisOf(0, M), 0.05),
         outward(origin(M.shoulder_lift), axisOf(1, M), 0.04),
         outward(origin(M.elbow_flex), axisOf(2, M), 0.04),
         outward(origin(M.wrist_flex), axisOf(3, M), 0.04),
         outward(cg.mix(origin(M.wrist_roll), tip, 0.35), axisOf(3, M), 0.035),
         tip,
      ];
   };

   const limitMargin = i => Math.min(q[i] - joints[i].lo, joints[i].hi - q[i]) / (joints[i].hi - joints[i].lo);

   const rangeBar = i => {
      const n = 10;
      const k = Math.round((q[i] - joints[i].lo) / (joints[i].hi - joints[i].lo) * n);
      return "[" + "-".repeat(k) + "|" + "-".repeat(n - k) + "]";
   };

   // Gravity torque on the shoulder and elbow motors: each mass times g times its horizontal distance from the joint.
   // Masses (kg) are estimates: an STS3215 servo is about 55 g, printed links are guessed.
   const motorEffort = M => {
      const lift = origin(M.shoulder_lift), elbow = origin(M.elbow_flex), wrist = origin(M.wrist_flex), tip = tipOf(M);
      const masses = [
         { m: 0.05, at: cg.mix(lift, elbow, 0.5), level: 1 },
         { m: 0.055, at: elbow, level: 1 },
         { m: 0.04, at: cg.mix(elbow, wrist, 0.5), level: 2 },
         { m: 0.055, at: wrist, level: 2 },
         { m: 0.1, at: cg.mix(wrist, tip, 0.5), level: 2 },
      ];
      if (holding)
         masses.push({ m: BLOCK_MASS, at: tip, level: 2 });
      const torque = (pivot, level) => masses
         .filter(s => s.level >= level)
         .reduce((t, s) => t + s.m * 9.81 * horizontal(s.at, pivot), 0);
      return [Math.round(100 * torque(lift, 1) / STALL_TORQUE), Math.round(100 * torque(elbow, 2) / STALL_TORQUE)];
   };

   // The panel floats above your left hand. Hide folds it into a small Menu button.
   let panelOpen = true;
   const handRoot = model.add();
   const panel = handRoot.add().move(PANEL_OFFSET);
   const tab = handRoot.add();
   panel.add("cube").move(0.12, -0.1175, -0.006).scale(0.13, 0.1325, 0.003).color(0.05, 0.05, 0.08);
   const LINE_COUNT = 12;
   const lines = Array.from({ length: LINE_COUNT }, (_, k) => makeText(panel, [0, -k * 0.016, 0], 0.42));

   const buttons = [
      { label: "Next", action: () => selected = (selected + 1) % CONTROLS.length },
      { label: "Reset", action: reset },
      { label: "Hide", action: () => panelOpen = false },
   ].map((b, i) => {
      const pos = [0.04 + i * 0.08, -0.228, 0.001];
      const disk = panel.add("diskZ").move(pos).scale(0.015, 0.015, 0.003).color(0.2, 0.5, 0.9);
      makeText(panel, [pos[0], pos[1] + 0.028, 0], 0.4, "center").set(b.label);
      return { ...b, local: cg.add(PANEL_OFFSET, pos), disk };
   });

   const tabFace = tab.add().move(TAB_POS);
   tabFace.add("diskZ").scale(0.016, 0.016, 0.003).color(0.2, 0.5, 0.9);
   makeText(tabFace, [0, 0.03, 0], 0.4, "center").set("Menu");

   const handMatrix = left => {
      const M = handRoot.getMatrix().slice();
      M[12] = left[0];
      M[13] = left[1] + 0.05;
      M[14] = left[2];
      return M;
   };

   inputEvents.onPress = hand => {
      const p = inputEvents.pos(hand);
      if (!p)
         return;
      if (hand === "left") {
         gripGoal = holding ? GRIP_MAX : grip > GRIP_MAX / 2 ? 0 : GRIP_MAX;
         return;
      }
      const left = inputEvents.pos("left");
      if (left) {
         const M = handMatrix(left);
         if (!panelOpen && cg.distance(cg.mTransform(M, TAB_POS), p) < 0.03) {
            panelOpen = true;
            return;
         }
         const button = panelOpen && buttons.find(b => cg.distance(cg.mTransform(M, b.local), p) < 0.025);
         if (button) {
            button.action();
            return;
         }
      }
      const spots = handlePositions(fk(q));
      let best = -1, bestDist = 0.05;
      spots.forEach((s, k) => {
         const d = cg.distance(s, p);
         if (d < bestDist) {
            bestDist = d;
            best = k;
         }
      });
      if (best >= 0)
         selected = best;
   };
   inputEvents.onDrag = () => {};
   inputEvents.onRelease = () => {};

   let lastTime = model.time;
   let switchReady = true;

   model.animate(() => {
      const dt = clamp(model.time - lastTime, 0, 0.1) || 0;
      lastTime = model.time;
      ensureParts();

      // Left stick down / up moves to the joint below / above it in the panel list, one step per push.
      const flick = joyStickState.left.y || 0;
      if (switchReady && Math.abs(flick) > 0.6) {
         selected = (selected + (flick > 0 ? 1 : -1) + CONTROLS.length) % CONTROLS.length;
         switchReady = false;
      }
      if (Math.abs(flick) < 0.3)
         switchReady = true;

      // Right stick moves the selected joint, unless that would push the arm into the table.
      const stick = joyStickState.right;
      const raw = Math.abs(stick.x) > Math.abs(stick.y) ? stick.x : -stick.y;
      const amount = Math.abs(raw) > 0.15 ? raw : 0;
      if (amount) {
         if (selected === 5) {
            gripGoal = clamp(gripGoal + amount * GRIP_SPEED * dt, 0, GRIP_MAX);
         } else {
            const j = joints[selected];
            const next = q.slice();
            next[selected] = clamp(q[selected] + amount * JOINT_SPEED * dt, j.lo, j.hi);
            if (clearsTable(fk(next))) {
               q = next;
               status = next[selected] === j.lo || next[selected] === j.hi ? `${CONTROLS[selected]} is at its limit` : "";
            } else {
               status = "Blocked: the arm would hit the table";
            }
         }
      }

      grip += (gripGoal - grip) * Math.min(1, dt * 10);
      if (!Number.isFinite(grip) || !Number.isFinite(gripGoal))
         grip = gripGoal = GRIP_MAX * 0.7;
      if (holding)
         grip = Math.max(grip, GRIP_HOLD);

      const M = fk(q);
      const tip = tipOf(M);

      // Closing on a block picks it up; opening again drops it.
      if (!holding && grip < GRIP_HOLD + 0.03 && gripGoal < grip) {
         const block = blocks.find(b => cg.distance(b.pos, tip) < 0.03);
         if (block) {
            holding = block;
            status = `Picked up the ${block.name} block`;
         }
      }
      if (holding && gripGoal > GRIP_HOLD + 0.1) {
         dropBlock(holding);
         status = `Dropped the ${holding.name} block`;
         holding = null;
      }
      if (holding)
         holding.pos = tip.slice();

      poseArm(q, grip);

      blocks.forEach((b, k) => blockNodes[k].identity().move(b.pos).scale(BLOCK_HALF).color(...b.color));
      const floor = [tip[0], TABLE_Y + 0.002, tip[2]];
      shadow.identity().move(floor).scale(0.008, 0.0005, 0.008).color(0.05, 0.05, 0.05);
      setLine(dropLine, tip, floor, 0.0006, WHITE);
      if (area)
         area.identity().opacity(0.7);

      const spots = handlePositions(M);
      handles.forEach((h, k) => h.identity().move(spots[k]).scale(k === selected ? 0.012 : 0.009)
         .color(...(k === selected ? YELLOW : WHITE)).opacity(k === selected ? 0.9 : 0.5));
      dials.forEach(d => placeDial(d, d.i === selected));

      const value = k => k === 5
         ? holding ? `holding ${holding.name}` : `${Math.round(100 * grip / GRIP_MAX)}% open`
         : `${deg(q[k])} deg`;
      angleLabel.identity().move(cg.add(spots[selected], [0, 0.06, 0]));
      try {
         angleLabel.faceViewer();
      } catch (e) {}
      angleLabel.scale(0.6);
      angleText.set(`${CONTROLS[selected]}: ${value(selected)}`, YELLOW);

      const hand = inputEvents.pos("left");
      if (hand) {
         handRoot.identity().move(hand[0], hand[1] + 0.05, hand[2]);
         try {
            handRoot.faceViewer();
         } catch (e) {}
         handRoot.scale(PANEL_SCALE);
      }
      panel.identity().move(PANEL_OFFSET).scale(panelOpen ? 1 : 0);
      tab.identity().scale(panelOpen ? 0 : 1);

      const [shoulder, elbow] = motorEffort(M);
      const effortColor = Math.max(shoulder, elbow) > 70 ? RED : Math.max(shoulder, elbow) > 40 ? YELLOW : GREEN;
      const rows = [
         ["ROBOT ARM", WHITE],
         [`Selected: ${CONTROLS[selected]}`, YELLOW],
         ...CONTROLS.map((name, k) => [
            k === 5 ? `${name.padEnd(11)}${value(k)}` : `${name.padEnd(11)}${value(k).padStart(8)} ${rangeBar(k)}`,
            k === selected ? YELLOW : k < 5 && limitMargin(k) < 0.05 ? RED : WHITE,
         ]),
         [`Motor effort: shoulder ${shoulder}%, elbow ${elbow}%`, effortColor],
         [status, CYAN],
         ["Left stick: pick joint. Right stick: move", GRAY],
         ["Left trigger: open / close gripper", GRAY],
      ];
      rows.forEach(([text, color], k) => lines[k].set(text, color));
   });
};
