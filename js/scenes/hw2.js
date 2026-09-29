import { ControllerBeam } from "../render/core/controllerInput.js";

export const init = async model => {

  // Game settings

  const TIME_LIMIT = 30;
  const MAX_SCORE_TEXT = 60;
  const TARGET_SIZE = .14;

  const RANGE_X = 2.25;
  const RANGE_Y = 1.15;
  const RANGE_HEIGHT = 1.55;
  const RANGE_Z = -2.45;

  const START_X = 0;
  const START_Y = 1.15;
  const START_Z = -1.15;
  const START_SIZE = .20;

  let score = 0;
  let highScore = 0;
  let timeLeft = TIME_LIMIT;
  let gameState = 'ready';
  let startTime = 0;
  let newHighScore = false;

  // Text positions
  // [x, y, z, size]

  const TITLE_POS = [-.80, 2.28, -.78, 1.75];
  const INSTRUCTIONS_POS = [-.80, 2.05, -.78, 1.25];

  const SCORE_POS = [-.90, 1.68, -.76, 1.55];
  const HIGH_SCORE_POS = [.35, 2.28, -.76, 1.20];
  const TIMER_POS = [.72, 1.68, -.76, 1.55];

  const READY_POS = [-.38, 1.42, -.82, 1.40];
  const GAME_OVER_POS = [-.38, 1.60, -.78, 1.90];
  const NEW_HIGH_POS = [-.58, 1.38, -.78, 1.35];
  const RESTART_POS = [-.85, 1.18, -.78, 1.10];

  // Range background

  let rangeBack = model.add('square');

  rangeBack.move(0, RANGE_HEIGHT, RANGE_Z)
           .scale(RANGE_X, RANGE_Y, 1)
           .color(.04, .05, .07)
           .dull();

  // Target

  let target = model.add();

  let targetHitbox = target.add();
  targetHitbox.scale(1).color(.08, .08, .10).dull();

  let targetOuter = target.add('diskZ');
  targetOuter.move(0, 0, .002).scale(.82).dull();

  let targetMiddle = target.add('diskZ');
  targetMiddle.move(0, 0, .004).scale(.52).color(1, 1, 1).dull();

  let targetCenter = target.add('diskZ');
  targetCenter.move(0, 0, .006).scale(.22).dull();

  let targetX = 0;
  let targetY = RANGE_HEIGHT;
  let targetZ = RANGE_Z + .03;
  let targetColor = 'blue';

  // Random target

  let moveTarget = () => {
    targetX = (Math.random() * 2 - 1) * (RANGE_X - .25);
    targetY = RANGE_HEIGHT + (Math.random() * 2 - 1) * (RANGE_Y - .25);
    targetZ = RANGE_Z + .03;

    targetColor = Math.random() < .5 ? 'blue' : 'red';
  };

  // Start button

  let startButton = model.add();

  let startHitbox = startButton.add();
  startHitbox.scale(1).color(.08, .15, .08).dull();

  let startOuter = startButton.add('diskZ');
  startOuter.move(0, 0, .002).scale(.90).color(.15, .8, .2).dull();

  startButton.add('diskZ')
             .move(0, 0, .004)
             .scale(.55)
             .color(.8, 1, .8)
             .dull();

  // Guns

  let beamL = new ControllerBeam(model, 'left');
  let beamR = new ControllerBeam(model, 'right');

  // Text

  clay.defineTextMesh('hw2Title', 'DUAL TARGET RANGE');

  clay.defineTextMesh('hw2Instructions', `LEFT HAND = BLUE
RIGHT HAND = RED
HIT AS MANY TARGETS AS YOU CAN
YOU HAVE 30 SECONDS`);

  clay.defineTextMesh('hw2Ready', 'SHOOT GREEN BUTTON TO START');
  clay.defineTextMesh('hw2Hit', 'HIT!');
  clay.defineTextMesh('hw2Miss', 'MISS');
  clay.defineTextMesh('hw2Wrong', 'WRONG HAND!');
  clay.defineTextMesh('hw2TimeUp', 'TIME\'S UP!');
  clay.defineTextMesh('hw2NewHigh', 'NEW HIGH SCORE!');
  clay.defineTextMesh('hw2Restart', 'SHOOT GREEN BUTTON TO PLAY AGAIN');

  let titleText = model.add('hw2Title').color(.8, .8, 1);
  let instructionsText = model.add('hw2Instructions').color(.8, .8, .9);
  let readyText = model.add('hw2Ready').color(.3, 1, .4);

  let hitText = model.add('hw2Hit').color(.2, 1, .3);
  let missText = model.add('hw2Miss').color(1, .25, .25);
  let wrongText = model.add('hw2Wrong').color(1, .5, .15);

  let timeUpText = model.add('hw2TimeUp').color(1, .8, .2);
  let newHighText = model.add('hw2NewHigh').color(.2, 1, .3);
  let restartText = model.add('hw2Restart').color(.3, 1, .4);

  // Score text

  let scoreText = [];

  for (let i = 0; i <= MAX_SCORE_TEXT; i++) {
    let name = 'hw2Score' + i;
    clay.defineTextMesh(name, 'SCORE: ' + i);
    scoreText.push(model.add(name).color(.15, .9, 1));
  }

  // High score text

  let highScoreText = [];

  for (let i = 0; i <= MAX_SCORE_TEXT; i++) {
    let name = 'hw2HighScore' + i;
    clay.defineTextMesh(name, 'HIGH SCORE: ' + i);
    highScoreText.push(model.add(name).color(1, .85, .15));
  }

  // Timer text

  let timerText = [];

  for (let i = 0; i <= TIME_LIMIT; i++) {
    let name = 'hw2Time' + i;
    clay.defineTextMesh(name, 'TIME: ' + i);
    timerText.push(model.add(name).color(.3, 1, .35));
  }

  // Hit / miss popup

  let popupType = 'none';
  let popupX = 0;
  let popupY = 0;
  let popupZ = -1.5;
  let popupStart = 0;

  let showPopup = (type, x, y, z) => {
    popupType = type;
    popupX = x;
    popupY = y;
    popupZ = z;
    popupStart = Date.now() / 1000;
  };

  // Text helpers

  let showText = (text, x, y, z, size) => {
    text.identity().move(x, y, z).scale(size);
  };

  let hideText = text => {
    text.identity().move(0, -10, 0).scale(.001);
  };

  let showAt = (text, position) => {
    showText(text, position[0], position[1], position[2], position[3]);
  };

  // Start game

  let startGame = () => {
    score = 0;
    timeLeft = TIME_LIMIT;
    startTime = Date.now() / 1000;
    gameState = 'playing';
    newHighScore = false;
    popupType = 'none';

    moveTarget();
  };

  // Shoot

  inputEvents.onPress = hand => {
    let beam = hand == 'left' ? beamL : beamR;
    beam.update();

    // Start / restart

    if (gameState == 'ready' || gameState == 'over') {
      let buttonHit = beam.hitRect(startHitbox.getGlobalMatrix());

      if (buttonHit) {
        startGame();
        vibrate(hand, .7, 60);
      }

      return;
    }

    // Shoot target

    let hit = beam.hitRect(targetHitbox.getGlobalMatrix());

    if (hit) {
      let correctHand =
        (targetColor == 'blue' && hand == 'left') ||
        (targetColor == 'red' && hand == 'right');

      let shotX = targetX + TARGET_SIZE * hit[0];
      let shotY = targetY + TARGET_SIZE * hit[1];

      // Correct hand

      if (correctHand) {
        score++;

        showPopup('hit', shotX, shotY, targetZ + .05);
        vibrate(hand, 1, 80);

        moveTarget();
      }

      // Wrong hand

      else {
        showPopup('wrong', shotX, shotY, targetZ + .05);
        vibrate(hand, .4, 80);
      }
    }

    // Miss

    else {
      let missHit = beam.hitRect(rangeBack.getGlobalMatrix());

      if (missHit) {
        let shotX = RANGE_X * missHit[0];
        let shotY = RANGE_HEIGHT + RANGE_Y * missHit[1];

        showPopup('miss', shotX, shotY, RANGE_Z + .05);
      }
      else {
        showPopup('miss', 0, 1.5, -1.5);
      }

      vibrate(hand, .25, 30);
    }
  };

  // Animation

  model.animate(() => {
    beamL.update();
    beamR.update();

    let now = Date.now() / 1000;

    // Timer

    if (gameState == 'playing') {
      timeLeft = TIME_LIMIT - (now - startTime);

      if (timeLeft <= 0) {
        timeLeft = 0;

        if (score > highScore) {
          highScore = score;
          newHighScore = true;
        }
        else {
          newHighScore = false;
        }

        gameState = 'over';
      }
    }

    // Target

    if (gameState == 'playing') {
      target.identity()
            .move(targetX, targetY, targetZ)
            .scale(TARGET_SIZE);

      let hoverLeft = beamL.hitRect(targetHitbox.getGlobalMatrix());
      let hoverRight = beamR.hitRect(targetHitbox.getGlobalMatrix());

      if (targetColor == 'blue') {
        targetOuter.color(.1, .25, 1);
        targetCenter.color(.1, .25, 1);
      }
      else {
        targetOuter.color(1, .12, .12);
        targetCenter.color(1, .12, .12);
      }

      if (hoverLeft || hoverRight)
        targetMiddle.color(1, .85, .35);
      else
        targetMiddle.color(1, 1, 1);
    }
    else {
      target.identity().move(0, -10, 0).scale(.001);
    }

    // Start button

    if (gameState == 'ready' || gameState == 'over') {
      startButton.identity()
                 .move(START_X, START_Y, START_Z)
                 .scale(START_SIZE);

      let hoverLeft = beamL.hitRect(startHitbox.getGlobalMatrix());
      let hoverRight = beamR.hitRect(startHitbox.getGlobalMatrix());

      if (hoverLeft || hoverRight)
        startOuter.color(.4, 1, .4);
      else
        startOuter.color(.15, .8, .2);
    }
    else {
      startButton.identity().move(0, -10, 0).scale(.001);
    }

    // Main text

    showAt(titleText, TITLE_POS);

    if (gameState == 'ready')
      showAt(instructionsText, INSTRUCTIONS_POS);
    else
      hideText(instructionsText);

    // Score

    let shownScore = Math.min(score, MAX_SCORE_TEXT);

    for (let i = 0; i < scoreText.length; i++) {
      if (i == shownScore)
        showAt(scoreText[i], SCORE_POS);
      else
        hideText(scoreText[i]);
    }

    // High score

    let shownHighScore = Math.min(highScore, MAX_SCORE_TEXT);

    for (let i = 0; i < highScoreText.length; i++) {
      if (i == shownHighScore)
        showAt(highScoreText[i], HIGH_SCORE_POS);
      else
        hideText(highScoreText[i]);
    }

    // Timer

    let shownTime = Math.ceil(timeLeft);
    shownTime = Math.max(0, Math.min(TIME_LIMIT, shownTime));

    for (let i = 0; i < timerText.length; i++) {
      if (i == shownTime)
        showAt(timerText[i], TIMER_POS);
      else
        hideText(timerText[i]);
    }

    // Ready text

    hideText(readyText);

    if (gameState == 'ready')
      showAt(readyText, READY_POS);

    // Floating feedback

    hideText(hitText);
    hideText(missText);
    hideText(wrongText);

    let popupAge = now - popupStart;

    if (popupType != 'none' && popupAge < .7) {
      let amount = popupAge / .7;
      let floatY = popupY + .18 * amount;
      let popupSize = 1.0 + .2 * amount;

      if (popupType == 'hit')
        showText(hitText, popupX, floatY, popupZ, popupSize);

      if (popupType == 'miss')
        showText(missText, popupX, floatY, popupZ, popupSize);

      if (popupType == 'wrong')
        showText(wrongText, popupX, floatY, popupZ, popupSize);
    }

    // Game over

    hideText(timeUpText);
    hideText(newHighText);
    hideText(restartText);

    if (gameState == 'over') {
      showAt(timeUpText, GAME_OVER_POS);

      if (newHighScore)
        showAt(newHighText, NEW_HIGH_POS);

      showAt(restartText, RESTART_POS);
    }
  });
};