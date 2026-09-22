import { ControllerBeam } from "../render/core/controllerInput.js";

window.clawInfo = {
  x: 0,
  z: 0,
  dropID: 0
};

export const init = async model => {
  let clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // Machine
  let machine = model.add();

  machine.add('cube')
    .move(0, -.50, 0)
    .scale(.48, .04, .36)
    .color(.18, .20, .25);

  let postPositions = [
    [-.45, -.33],
    [.45, -.33],
    [-.45, .33],
    [.45, .33]
  ];

  for (let i = 0; i < postPositions.length; i++) {
    machine.add('cube')
      .move(postPositions[i][0], 0, postPositions[i][1])
      .scale(.035, .50, .035)
      .color(.25, .30, .40);
  }

  machine.add('cube')
    .move(0, .50, -.33)
    .scale(.48, .035, .035)
    .color(.25, .30, .40);

  machine.add('cube')
    .move(0, .50, .33)
    .scale(.48, .035, .035)
    .color(.25, .30, .40);

  machine.add('cube')
    .move(-.45, .50, 0)
    .scale(.035, .035, .36)
    .color(.25, .30, .40);

  machine.add('cube')
    .move(.45, .50, 0)
    .scale(.035, .035, .36)
    .color(.25, .30, .40);

  // Prizes
  let prizes = [];

  let addPrize = (shape, x, y, z, size, color) => {
    let node = machine.add(shape);

    node
      .move(x, y, z)
      .scale(size)
      .color(color[0], color[1], color[2]);

    let target = machine.add();

    prizes.push({
      node: node,
      target: target,
      x: x,
      y: y,
      z: z,
      size: size,
      color: color,
      state: 'machine'
    });
  };

  addPrize('sphere', -.22, -.40, -.10, .085, [1, .2, .2]);
  addPrize('sphere', .02, -.40, -.15, .08, [.2, .5, 1]);
  addPrize('cube', .22, -.40, .05, .075, [1, .8, .1]);
  addPrize('sphere', -.12, -.40, .14, .075, [.3, 1, .4]);

  // Controls
  machine.add('cube')
    .move(-.12, -.36, .43)
    .scale(.24, .045, .11)
    .color(.18, .22, .30);

  machine.add('sphere')
    .move(-.20, -.30, .46)
    .scale(.055, .022, .055)
    .color(.08, .08, .10);

  let joystick = machine.add();

  joystick.move(-.20, -.30, .46);

  joystick.add('tubeY')
    .move(0, .065, 0)
    .scale(.015, .065, .015)
    .color(.65, .65, .70);

  let joystickKnob = joystick.add('sphere');

  joystickKnob
    .move(0, .14, 0)
    .scale(.038)
    .color(.2, .45, 1);

  let joystickTarget = machine.add();

  joystickTarget
    .move(-.20, -.20, .55)
    .scale(.11, .14, 1);

  let dropButton = machine.add();

  dropButton.move(.04, -.30, .46);

  dropButton.add('sphere')
    .scale(.047, .022, .047)
    .color(1, .1, .1);

  let buttonTarget = machine.add();

  buttonTarget
    .move(.04, -.28, .55)
    .scale(.08, .08, 1);

  // Chute
  let chuteX = .30;
  let chuteY = -.38;
  let chuteZ = .28;

  machine.add('cube')
    .move(chuteX, -.45, .34)
    .scale(.14, .025, .15)
    .color(.15, .18, .24);

  machine.add('cube')
    .move(chuteX, -.37, .20)
    .scale(.14, .08, .025)
    .color(.22, .26, .34);

  machine.add('cube')
    .move(.17, -.37, .34)
    .scale(.025, .08, .15)
    .color(.22, .26, .34);

  machine.add('cube')
    .move(.43, -.37, .34)
    .scale(.025, .08, .15)
    .color(.22, .26, .34);

  // Claw hierarchy
  let carriage = machine.add();

  carriage.add('cube')
    .scale(.10, .035, .10)
    .color(.7, .7, .75);

  let cable = carriage.add('tubeY');

  cable.color(.5, .5, .55);

  let head = carriage.add();

  head.add('sphere')
    .scale(.065)
    .color(.8, .8, .85);

  let finger1 = head.add();

  finger1.add('tubeY')
    .move(0, -.085, 0)
    .scale(.020, .10, .020)
    .color(.8, .8, .85);

  let finger2 = head.add();

  finger2.add('tubeY')
    .move(0, -.085, 0)
    .scale(.020, .10, .020)
    .color(.8, .8, .85);

  let finger3 = head.add();

  finger3.add('tubeY')
    .move(0, -.085, 0)
    .scale(.020, .10, .020)
    .color(.8, .8, .85);

  // Controller beams
  let beamL = new ControllerBeam(model, 'left');
  let beamR = new ControllerBeam(model, 'right');

  let hoverJoystick = {
    left: false,
    right: false
  };

  let hoverButton = {
    left: false,
    right: false
  };

  let hoverPrize = {
    left: -1,
    right: -1
  };

  // Interaction state
  let activeHand = null;
  let dragStart = [0, 0, 0];

  let clawX = 0;
  let clawZ = 0;

  let joystickMoveX = 0;
  let joystickMoveZ = 0;
  let joystickTiltX = 0;
  let joystickTiltZ = 0;

  let lastFrameTime = Date.now() / 1000;

  let buttonHand = null;
  let buttonPressed = false;

  let heldPrize = -1;
  let heldPrizeHand = null;

  let prizeDragStart = [0, 0, 0];
  let prizeStart = [0, 0, 0];

  let phase = 'idle';
  let phaseStart = 0;

  let drop = 0;
  let closeAmount = 0;
  let dropHand = null;

  let lastDropID = clawInfo.dropID;

  let caughtPrize = -1;
  let fallingPrize = -1;

  let prizeFallStart = 0;
  let prizeFallStartY = 0;

  let moveStartX = 0;
  let moveStartZ = 0;

  // Claw drop
  let startDrop = hand => {
    if (phase != 'idle')
      return;

    phase = 'dropping';
    phaseStart = Date.now() / 1000;

    drop = 0;
    closeAmount = 0;
    dropHand = hand;
  };

  let tryGrabPrize = () => {
    let closest = -1;
    let closestDistance = 1000;

    for (let i = 0; i < prizes.length; i++) {
      if (prizes[i].state != 'machine')
        continue;

      let dx = clawX - prizes[i].x;
      let dz = clawZ - prizes[i].z;

      let distance = Math.sqrt(dx * dx + dz * dz);

      if (distance < .045 && distance < closestDistance) {
        closest = i;
        closestDistance = distance;
      }
    }

    caughtPrize = closest;

    if (caughtPrize >= 0) {
      prizes[caughtPrize].state = 'caught';

      if (dropHand)
        vibrate(dropHand, 1, 100);
    }
  };

  // Press
  inputEvents.onPress = hand => {
    if (
      phase == 'idle' &&
      hoverPrize[hand] >= 0 &&
      activeHand == null &&
      heldPrize < 0
    ) {
      heldPrize = hoverPrize[hand];
      heldPrizeHand = hand;

      let p = inputEvents.pos(hand);
      let prize = prizes[heldPrize];

      prizeDragStart = [p[0], p[1], p[2]];
      prizeStart = [prize.x, prize.y, prize.z];

      prize.state = 'held';

      vibrate(hand, .7, 50);

      return;
    }

    if (
      phase == 'idle' &&
      hoverButton[hand] &&
      activeHand == null &&
      heldPrize < 0
    ) {
      buttonHand = hand;
      buttonPressed = true;

      clawInfo.x = clawX;
      clawInfo.z = clawZ;
      clawInfo.dropID++;

      lastDropID = clawInfo.dropID;

      server.broadcastGlobal('clawInfo');

      startDrop(hand);
      vibrate(hand, .8, 60);

      return;
    }

    if (
      phase != 'idle' ||
      !hoverJoystick[hand] ||
      activeHand != null ||
      heldPrize >= 0
    )
      return;

    activeHand = hand;

    let p = inputEvents.pos(hand);

    dragStart = [p[0], p[1], p[2]];

    joystickMoveX = 0;
    joystickMoveZ = 0;

    vibrate(hand, .4, 25);
  };

  // Drag
  inputEvents.onDrag = hand => {
    if (heldPrizeHand == hand && heldPrize >= 0) {
      let p = inputEvents.pos(hand);
      let prize = prizes[heldPrize];

      prize.x =
        prizeStart[0] +
        1.8 * (p[0] - prizeDragStart[0]);

      prize.y =
        prizeStart[1] +
        1.8 * (p[1] - prizeDragStart[1]);

      prize.z =
        prizeStart[2] +
        1.8 * (p[2] - prizeDragStart[2]);

      return;
    }

    if (activeHand != hand || phase != 'idle')
      return;

    let p = inputEvents.pos(hand);

    let dx = p[0] - dragStart[0];
    let dz = p[2] - dragStart[2];

    joystickMoveX = clamp(dx * 5, -1, 1);
    joystickMoveZ = clamp(dz * 5, -1, 1);

    joystickTiltZ = -joystickMoveX * .35;
    joystickTiltX = joystickMoveZ * .35;
  };

  // Release
  inputEvents.onRelease = hand => {
    if (heldPrizeHand == hand && heldPrize >= 0) {
      prizes[heldPrize].state = 'free';

      heldPrize = -1;
      heldPrizeHand = null;

      vibrate(hand, .2, 20);
    }

    if (activeHand == hand) {
      activeHand = null;

      joystickMoveX = 0;
      joystickMoveZ = 0;
      joystickTiltX = 0;
      joystickTiltZ = 0;

      clawInfo.x = clawX;
      clawInfo.z = clawZ;

      server.broadcastGlobal('clawInfo');

      vibrate(hand, .15, 15);
    }

    if (buttonHand == hand) {
      buttonHand = null;
      buttonPressed = false;
    }
  };

  // Animations
  machine
    .move(0, 1.12, -1.00)
    .animate(() => {
      let shared = server.synchronize('clawInfo');

      if (shared) {
        if (
          activeHand == null &&
          phase == 'idle'
        ) {
          clawX = shared.x;
          clawZ = shared.z;
        }

        if (shared.dropID > lastDropID) {
          lastDropID = shared.dropID;

          clawX = shared.x;
          clawZ = shared.z;

          if (phase == 'idle')
            startDrop(null);
        }
      }

      beamL.update();
      beamR.update();

      hoverJoystick.left =
        !!beamL.hitRect(
          joystickTarget.getGlobalMatrix()
        );

      hoverJoystick.right =
        !!beamR.hitRect(
          joystickTarget.getGlobalMatrix()
        );

      hoverButton.left =
        !!beamL.hitRect(
          buttonTarget.getGlobalMatrix()
        );

      hoverButton.right =
        !!beamR.hitRect(
          buttonTarget.getGlobalMatrix()
        );

      hoverPrize.left = -1;
      hoverPrize.right = -1;

      for (let i = 0; i < prizes.length; i++) {
        let prize = prizes[i];

        let canPickUp =
          prize.state == 'chute' ||
          prize.state == 'free';

        if (canPickUp) {
          prize.target
            .identity()
            .move(
              prize.x,
              prize.y,
              prize.z + .02
            )
            .scale(
              prize.size * 1.5,
              prize.size * 1.5,
              1
            );

          if (
            hoverPrize.left < 0 &&
            beamL.hitRect(
              prize.target.getGlobalMatrix()
            )
          )
            hoverPrize.left = i;

          if (
            hoverPrize.right < 0 &&
            beamR.hitRect(
              prize.target.getGlobalMatrix()
            )
          )
            hoverPrize.right = i;
        }
        else {
          prize.target
            .identity()
            .move(0, -10, 0)
            .scale(.01);
        }
      }

      if (
        hoverJoystick.left ||
        hoverJoystick.right ||
        activeHand != null
      ) {
        joystickKnob.color(.5, .7, 1);
      }
      else {
        joystickKnob.color(.2, .45, 1);
      }

      joystick
        .identity()
        .move(-.20, -.30, .46)
        .turnX(joystickTiltX)
        .turnZ(joystickTiltZ);

      let buttonDepth =
        buttonPressed ? -.018 : 0;

      dropButton
        .identity()
        .move(
          .04,
          -.30 + buttonDepth,
          .46
        );

      let now = Date.now() / 1000;
      let frameTime = clamp(now - lastFrameTime, 0, .05);
      let t = now - phaseStart;

      lastFrameTime = now;

      if (activeHand != null && phase == 'idle') {
        clawX = clamp(
          clawX + joystickMoveX * .35 * frameTime,
          -.34,
          .34
        );

        clawZ = clamp(
          clawZ + joystickMoveZ * .30 * frameTime,
          -.22,
          .22
        );

        clawInfo.x = clawX;
        clawInfo.z = clawZ;

        server.broadcastGlobal('clawInfo');
      }

      // Claw animations
      if (phase == 'dropping') {
        drop =
          .62 *
          clamp(t / .9, 0, 1);

        closeAmount = 0;

        if (t >= .9) {
          phase = 'closing';
          phaseStart = now;

          if (dropHand)
            vibrate(dropHand, 1, 70);
        }
      }
      else if (phase == 'closing') {
        drop = .62;

        closeAmount =
          clamp(t / .30, 0, 1);

        if (t >= .30) {
          tryGrabPrize();

          phase = 'rising';
          phaseStart = now;
        }
      }
      else if (phase == 'rising') {
        drop =
          .62 *
          (1 - clamp(t / .9, 0, 1));

        closeAmount = 1;

        if (t >= .9) {
          drop = 0;

          if (caughtPrize >= 0) {
            moveStartX = clawX;
            moveStartZ = clawZ;

            phase = 'movingToChute';
            phaseStart = now;
          }
          else {
            phase = 'idle';
            phaseStart = 0;

            closeAmount = 0;
            dropHand = null;
          }
        }
      }
      else if (phase == 'movingToChute') {
        let moveAmount =
          clamp(t / .8, 0, 1);

        clawX =
          moveStartX +
          (chuteX - moveStartX) *
          moveAmount;

        clawZ =
          moveStartZ +
          (chuteZ - moveStartZ) *
          moveAmount;

        drop = 0;
        closeAmount = 1;

        if (t >= .8) {
          phase = 'releasingPrize';
          phaseStart = now;
        }
      }
      else if (phase == 'releasingPrize') {
        drop = 0;

        closeAmount =
          1 -
          clamp(t / .25, 0, 1);

        if (
          caughtPrize >= 0 &&
          t >= .12
        ) {
          fallingPrize = caughtPrize;

          prizes[fallingPrize].state =
            'falling';

          prizeFallStartY =
            prizes[fallingPrize].y;

          prizeFallStart = now;

          caughtPrize = -1;
        }

        if (t >= .35) {
          phase = 'idle';
          phaseStart = 0;

          drop = 0;
          closeAmount = 0;
          dropHand = null;

          clawInfo.x = clawX;
          clawInfo.z = clawZ;

          server.broadcastGlobal(
            'clawInfo'
          );
        }
      }

      // Moving claw
      carriage
        .identity()
        .move(
          clawX,
          .40,
          clawZ
        );

      cable
        .identity()
        .move(
          0,
          -.05 - drop / 2,
          0
        )
        .scale(
          .015,
          .05 + drop / 2,
          .015
        );

      head
        .identity()
        .move(
          0,
          -.10 - drop,
          0
        );

      let openAngle = .65;
      let closedAngle = .20;

      let angle =
        openAngle +
        (closedAngle - openAngle) *
        closeAmount;

      finger1
        .identity()
        .move(0, -.035, .055)
        .turnX(-angle);

      finger2
        .identity()
        .move(.048, -.035, -.028)
        .turnY(2 * Math.PI / 3)
        .turnX(-angle);

      finger3
        .identity()
        .move(-.048, -.035, -.028)
        .turnY(4 * Math.PI / 3)
        .turnX(-angle);

      // Carrying prize
      if (caughtPrize >= 0) {
        let prize =
          prizes[caughtPrize];

        prize.x = clawX;
        prize.z = clawZ;
        prize.y = .22 - drop;

        prize.node
          .identity()
          .move(
            prize.x,
            prize.y,
            prize.z
          )
          .scale(prize.size);
      }

      // Dropping prize into chute
      if (fallingPrize >= 0) {
        let prize =
          prizes[fallingPrize];

        let fallTime =
          now - prizeFallStart;

        prize.x = chuteX;
        prize.z = chuteZ;

        prize.y =
          prizeFallStartY -
          1.0 * fallTime;

        if (prize.y <= chuteY) {
          prize.y = chuteY;
          prize.state = 'chute';

          fallingPrize = -1;
        }

        prize.node
          .identity()
          .move(
            prize.x,
            prize.y,
            prize.z
          )
          .scale(prize.size);
      }

      // Picking up prize
      for (let i = 0; i < prizes.length; i++) {
        let prize = prizes[i];

        if (
          i != caughtPrize &&
          i != fallingPrize
        ) {
          prize.node
            .identity()
            .move(
              prize.x,
              prize.y,
              prize.z
            )
            .scale(prize.size);
        }

        let highlighted =
          hoverPrize.left == i ||
          hoverPrize.right == i ||
          heldPrize == i;

        if (highlighted) {
          prize.node.color(
            Math.min(
              1,
              prize.color[0] + .25
            ),
            Math.min(
              1,
              prize.color[1] + .25
            ),
            Math.min(
              1,
              prize.color[2] + .25
            )
          );
        }
        else {
          prize.node.color(
            prize.color[0],
            prize.color[1],
            prize.color[2]
          );
        }
      }
    });
};