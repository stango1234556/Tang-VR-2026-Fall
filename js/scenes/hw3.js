import * as cg from "../render/core/cg.js";
import { lcb, rcb } from "../handle_scenes.js";

server.init('pingPongGame', {
	ball: [0, 1.00, -1.65],
	vel: [.20, .70, -1.35],
	score: [0, 0],
	playing: false,
	winner: -1,
	owner: -1
});

server.init('pingPongPaddles', {
	pos: [
		[0, .88, -.84],
		[0, .88, -2.46]
	],
	vel: [
		[0, 0, 0],
		[0, 0, 0]
	]
});

export const init = async model => {

	// Game settings

	const WIN_SCORE = 5;

	const TABLE_Y = .65;
	const TABLE_TOP = .69;
	const TABLE_CENTER_Z = -1.65;
	const TABLE_HALF_X = .72;
	const TABLE_HALF_Z = .90;

	const NEAR_EDGE = TABLE_CENTER_Z + TABLE_HALF_Z;
	const FAR_EDGE = TABLE_CENTER_Z - TABLE_HALF_Z;

	const NET_Z = TABLE_CENTER_Z;
	const NET_TOP = .88;

	const PLAYER1_HOME_Z = -.84;
	const PLAYER2_HOME_Z = -2.46;

	const BALL_RADIUS = .045;
	const GRAVITY = -2.3;

	const HIT_WIDTH = .28;
	const HIT_HEIGHT = .33;
	const HIT_DEPTH = .15;

	const PADDLE_MIN_X = -.65;
	const PADDLE_MAX_X = .65;
	const PADDLE_MIN_Y = .70;
	const PADDLE_MAX_Y = 1.35;

	const PLAYER1_MIN_Z = -1.08;
	const PLAYER1_MAX_Z = -.55;
	const PLAYER2_MIN_Z = -2.75;
	const PLAYER2_MAX_Z = -2.22;

	const X_SENSITIVITY = 1.18;
	const Y_SENSITIVITY = 1.15;
	const Z_SENSITIVITY = 1.18;

	let myRole = -1;

	let lastPhysicsTime = Date.now() / 1000;
	let lastBallSend = 0;
	let lastPaddleSend = 0;
	let lastPaddleHit = 0;

	let remoteBall = [0, 1.00, TABLE_CENTER_Z];
	let remoteVel = [.20, .70, -1.35];
	let remoteBallTime = Date.now() / 1000;

	let controllerAnchor = null;
	let paddleAnchor = null;

	let previousPaddlePos = [
		[0, .88, PLAYER1_HOME_Z],
		[0, .88, PLAYER2_HOME_Z]
	];

	let localPaddleVelocity = [
		[0, 0, 0],
		[0, 0, 0]
	];

	let previousPaddleTime = Date.now() / 1000;
	let localHitSent = false;

	let servePending = false;
	let serveTime = 0;
	let nextServeDirection = -1;

	const PLAYER1_ROLE_POS = [-.32, 1.35, -1.05];
	const PLAYER2_ROLE_POS = [.32, 1.35, -1.05];
	const START_POS = [0, 1.42, -1.45];
	const RESET_POS = [0, 1.28, -1.30];

	let player1RoleButton = model.add('sphere');
	let player2RoleButton = model.add('sphere');
	let startButton = model.add('sphere');
	let resetButton = model.add('sphere');

	let table = model.add('cube');
	let centerLine = model.add('cube');
	let net = model.add('cube');
	let netPost1 = model.add('cube');
	let netPost2 = model.add('cube');

	let ball = model.add('sphere');

	let paddle1 = model.add();
	let paddle1Face = paddle1.add('diskZ');
	let paddle1Handle = paddle1.add('cube');

	let paddle2 = model.add();
	let paddle2Face = paddle2.add('diskZ');
	let paddle2Handle = paddle2.add('cube');

	// Text

	clay.defineTextMesh('hw3Title', 'MULTIPLAYER TABLE TENNIS');
	clay.defineTextMesh('hw3Choose', 'CHOOSE YOUR PLAYER');
	clay.defineTextMesh('hw3Player1', 'PLAYER 1');
	clay.defineTextMesh('hw3Player2', 'PLAYER 2');
	clay.defineTextMesh('hw3Start', 'SHOOT GREEN BALL TO START');
	clay.defineTextMesh('hw3Reset', 'PLAY AGAIN');
	clay.defineTextMesh('hw3Playing', 'FIRST TO 5 WINS');
	clay.defineTextMesh('hw3Player1Win', 'PLAYER 1 WINS!');
	clay.defineTextMesh('hw3Player2Win', 'PLAYER 2 WINS!');

	let titleText = model.add('hw3Title').color(1, 1, 1);
	let chooseText = model.add('hw3Choose').color(.8, .8, 1);
	let player1Text = model.add('hw3Player1').color(.15, .65, 1);
	let player2Text = model.add('hw3Player2').color(1, .45, .1);
	let startText = model.add('hw3Start').color(.3, 1, .4);
	let resetText = model.add('hw3Reset').color(1, .25, .25);
	let playingText = model.add('hw3Playing').color(.8, .8, .9);
	let player1WinText = model.add('hw3Player1Win').color(.15, .65, 1);
	let player2WinText = model.add('hw3Player2Win').color(1, .45, .1);

	let player1ScoreText = [];
	let player2ScoreText = [];

	for (let i = 0; i <= WIN_SCORE; i++) {
		let name1 = 'hw3P1Score' + i;
		let name2 = 'hw3P2Score' + i;

		clay.defineTextMesh(name1, 'P1: ' + i);
		clay.defineTextMesh(name2, 'P2: ' + i);

		player1ScoreText.push(model.add(name1).color(.15, .65, 1));
		player2ScoreText.push(model.add(name2).color(1, .45, .1));
	}

	// Helpers

	let hide = obj => {
		obj.identity().move(0, -10, 0).scale(.001);
	};

	let showText = (obj, x, y, z, size) => {
		obj.identity().move(x, y, z).scale(size);
	};

	let clamp = (value, min, max) => {
		return Math.max(min, Math.min(max, value));
	};

	let round3 = value => {
		return Math.round(value * 1000) / 1000;
	};

	let roundVec = v => {
		return [round3(v[0]), round3(v[1]), round3(v[2])];
	};

	let beamHits = (hand, pos, radius) => {
		let beam = hand == 'left' ? lcb : rcb;
		let point = beam.projectOntoBeam(pos);
		return cg.distance(point, pos) < radius;
	};

	let viewPos = pos => {
		if (myRole != 1)
			return [pos[0], pos[1], pos[2]];

		return [
			-pos[0],
			pos[1],
			2 * TABLE_CENTER_Z - pos[2]
		];
	};

	let getDisplayBall = now => {
		if (!pingPongGame.playing || myRole == pingPongGame.owner)
			return pingPongGame.ball;

		let elapsed = clamp(now - remoteBallTime, 0, .07);

		return [
			remoteBall[0] + remoteVel[0] * elapsed,
			remoteBall[1] + remoteVel[1] * elapsed
				+ .5 * GRAVITY * elapsed * elapsed,
			remoteBall[2] + remoteVel[2] * elapsed
		];
	};

	let getDisplayVelocity = now => {
		if (!pingPongGame.playing || myRole == pingPongGame.owner)
			return pingPongGame.vel;

		let elapsed = clamp(now - remoteBallTime, 0, .07);

		return [
			remoteVel[0],
			remoteVel[1] + GRAVITY * elapsed,
			remoteVel[2]
		];
	};

	let clampPaddle = (player, pos) => {
		let zMin = player == 0 ? PLAYER1_MIN_Z : PLAYER2_MIN_Z;
		let zMax = player == 0 ? PLAYER1_MAX_Z : PLAYER2_MAX_Z;

		return [
			clamp(pos[0], PADDLE_MIN_X, PADDLE_MAX_X),
			clamp(pos[1], PADDLE_MIN_Y, PADDLE_MAX_Y),
			clamp(pos[2], zMin, zMax)
		];
	};

	let chooseRole = player => {
		myRole = player;

		previousPaddlePos[player] = pingPongPaddles.pos[player].slice();
		previousPaddleTime = Date.now() / 1000;

		controllerAnchor = null;
		paddleAnchor = pingPongPaddles.pos[player].slice();

		remoteBall = pingPongGame.ball.slice();
		remoteVel = pingPongGame.vel.slice();
		remoteBallTime = Date.now() / 1000;

		localHitSent = false;
	};

	let sendPaddle = (player, pos, vel) => {
		pos = clampPaddle(player, pos);

		pingPongPaddles.pos[player] = pos.slice();
		pingPongPaddles.vel[player] = vel.slice();

		server.send('pingPongPaddles', {
			op: 'paddle',
			player: player,
			pos: roundVec(pos),
			vel: roundVec(vel)
		});
	};

	let sendBallState = (p, v, now) => {
		server.send('pingPongGame', {
			op: 'ball',
			owner: pingPongGame.owner,
			ball: roundVec(p),
			vel: roundVec(v)
		});

		lastBallSend = now;
	};

	let sendStart = direction => {
		if (myRole < 0)
			return;

		let ballStart = [0, 1.02, TABLE_CENTER_Z];

		let velocity = [
			direction < 0 ? .20 : -.20,
			.72,
			direction * 1.38
		];

		pingPongGame.owner = myRole;
		pingPongGame.ball = ballStart.slice();
		pingPongGame.vel = velocity.slice();
		pingPongGame.playing = true;

		remoteBall = ballStart.slice();
		remoteVel = velocity.slice();
		remoteBallTime = Date.now() / 1000;

		localHitSent = false;

		server.send('pingPongGame', {
			op: 'start',
			owner: myRole,
			ball: ballStart,
			vel: velocity
		});

		lastPhysicsTime = Date.now() / 1000;
		lastBallSend = lastPhysicsTime;
		servePending = false;
	};

	let scorePoint = (player, now) => {
		let newScore = [
			pingPongGame.score[0],
			pingPongGame.score[1]
		];

		newScore[player]++;

		let winner = -1;

		if (newScore[player] >= WIN_SCORE)
			winner = player;

		pingPongGame.score = newScore;
		pingPongGame.winner = winner;
		pingPongGame.playing = false;
		pingPongGame.ball = [0, 1.00, TABLE_CENTER_Z];

		remoteBall = pingPongGame.ball.slice();
		remoteVel = [0, 0, 0];
		remoteBallTime = now;

		localHitSent = false;

		server.send('pingPongGame', {
			op: 'point',
			owner: pingPongGame.owner,
			score: newScore,
			winner: winner
		});

		if (winner < 0) {
			servePending = true;
			serveTime = now + 1.2;
			nextServeDirection = player == 0 ? -1 : 1;
		}
	};

	let resetGame = () => {
		pingPongGame.ball = [0, 1.00, TABLE_CENTER_Z];
		pingPongGame.vel = [.20, .72, -1.38];
		pingPongGame.score = [0, 0];
		pingPongGame.playing = false;
		pingPongGame.winner = -1;
		pingPongGame.owner = -1;

		pingPongPaddles.pos = [
			[0, .88, PLAYER1_HOME_Z],
			[0, .88, PLAYER2_HOME_Z]
		];

		pingPongPaddles.vel = [
			[0, 0, 0],
			[0, 0, 0]
		];

		remoteBall = pingPongGame.ball.slice();
		remoteVel = pingPongGame.vel.slice();
		remoteBallTime = Date.now() / 1000;

		servePending = false;
		lastPaddleHit = 0;
		localHitSent = false;
		controllerAnchor = null;

		if (myRole >= 0) {
			paddleAnchor = pingPongPaddles.pos[myRole].slice();
			previousPaddlePos[myRole] = pingPongPaddles.pos[myRole].slice();
			previousPaddleTime = Date.now() / 1000;
		}

		server.send('pingPongGame', {
			op: 'reset',
			owner: -1
		});

		server.send('pingPongPaddles', {
			op: 'reset'
		});
	};

	// VR controls

	inputEvents.onPress = hand => {
		if (myRole < 0) {
			if (beamHits(hand, PLAYER1_ROLE_POS, .16)) {
				chooseRole(0);
				vibrate(hand, .7, 70);
				return;
			}

			if (beamHits(hand, PLAYER2_ROLE_POS, .16)) {
				chooseRole(1);
				vibrate(hand, .7, 70);
				return;
			}
		}

		if (myRole >= 0 && pingPongGame.winner >= 0) {
			if (beamHits(hand, RESET_POS, .16)) {
				resetGame();
				vibrate(hand, .8, 80);
				return;
			}
		}

		if (
			myRole >= 0 &&
			!pingPongGame.playing &&
			pingPongGame.winner < 0 &&
			pingPongGame.owner < 0 &&
			!servePending
		) {
			if (beamHits(hand, START_POS, .14)) {
				let direction = myRole == 0 ? -1 : 1;

				sendStart(direction);
				vibrate(hand, .8, 80);
			}
		}
	};

	// VR paddle movement

	let updateVRPaddle = now => {
		if (myRole < 0)
			return;

		let controllerPos = inputEvents.pos('right');

		if (
			!controllerPos ||
			controllerPos.length < 3 ||
			controllerPos[1] < .25
		) {
			return;
		}

		if (controllerAnchor == null) {
			controllerAnchor = controllerPos.slice();
			paddleAnchor = pingPongPaddles.pos[myRole].slice();
			previousPaddlePos[myRole] = paddleAnchor.slice();
			previousPaddleTime = now;
			return;
		}

		let dx = controllerPos[0] - controllerAnchor[0];
		let dy = controllerPos[1] - controllerAnchor[1];
		let dz = controllerPos[2] - controllerAnchor[2];

		let target;

		if (myRole == 0) {
			target = [
				paddleAnchor[0] + dx * X_SENSITIVITY,
				paddleAnchor[1] + dy * Y_SENSITIVITY,
				paddleAnchor[2] + dz * Z_SENSITIVITY
			];
		}
		else {
			target = [
				paddleAnchor[0] - dx * X_SENSITIVITY,
				paddleAnchor[1] + dy * Y_SENSITIVITY,
				paddleAnchor[2] - dz * Z_SENSITIVITY
			];
		}

		target = clampPaddle(myRole, target);

		let current = pingPongPaddles.pos[myRole];

		let smooth = [
			current[0] * .45 + target[0] * .55,
			current[1] * .45 + target[1] * .55,
			current[2] * .45 + target[2] * .55
		];

		let dt = Math.max(.001, now - previousPaddleTime);

		let rawVel = [
			(smooth[0] - previousPaddlePos[myRole][0]) / dt,
			(smooth[1] - previousPaddlePos[myRole][1]) / dt,
			(smooth[2] - previousPaddlePos[myRole][2]) / dt
		];

		localPaddleVelocity[myRole] = [
			localPaddleVelocity[myRole][0] * .60 + rawVel[0] * .40,
			localPaddleVelocity[myRole][1] * .60 + rawVel[1] * .40,
			localPaddleVelocity[myRole][2] * .60 + rawVel[2] * .40
		];

		pingPongPaddles.pos[myRole] = smooth;
		pingPongPaddles.vel[myRole] = localPaddleVelocity[myRole].slice();

		previousPaddlePos[myRole] = smooth.slice();
		previousPaddleTime = now;

		if (now - lastPaddleSend > .04) {
			sendPaddle(myRole, smooth, localPaddleVelocity[myRole]);
			lastPaddleSend = now;
		}
	};

	// Ball aiming

	let returnBall = (
		player,
		p,
		v,
		paddleOverride = null,
		paddleVelOverride = null
	) => {
		let paddle = paddleOverride || pingPongPaddles.pos[player];
		let paddleVel = paddleVelOverride || pingPongPaddles.vel[player];

		let offsetX = p[0] - paddle[0];

		let targetX =
			p[0] +
			offsetX * 1.65 +
			paddleVel[0] * .14;

		targetX = clamp(targetX, -.58, .58);

		let targetZ;

		if (player == 0) {
			targetZ = TABLE_CENTER_Z - .50;
			targetZ += clamp(paddleVel[2] * .10, -.16, .16);
			targetZ = clamp(targetZ, FAR_EDGE + .18, NET_Z - .18);
			p[2] = paddle[2] - .06;
		}
		else {
			targetZ = TABLE_CENTER_Z + .50;
			targetZ += clamp(paddleVel[2] * .10, -.16, .16);
			targetZ = clamp(targetZ, NET_Z + .18, NEAR_EDGE - .18);
			p[2] = paddle[2] + .06;
		}

		p[1] = Math.max(p[1], .88);

		let flightTime = .70 + paddleVel[1] * .020;
		flightTime = clamp(flightTime, .68, .80);

		let landingY = TABLE_TOP + BALL_RADIUS;

		v[0] = (targetX - p[0]) / flightTime;
		v[2] = (targetZ - p[2]) / flightTime;

		v[1] =
			(
				landingY -
				p[1] -
				.5 * GRAVITY * flightTime * flightTime
			) /
			flightTime;

		v[1] += .18;

		return [p, v];
	};

	// Non-owner checks its own paddle

	let checkLocalPaddleHit = now => {
		if (
			myRole < 0 ||
			myRole == pingPongGame.owner ||
			!pingPongGame.playing
		) {
			return;
		}

		let p = getDisplayBall(now).slice();
		let v = getDisplayVelocity(now).slice();

		let paddle = pingPongPaddles.pos[myRole];
		let paddleVel = pingPongPaddles.vel[myRole];

		let movingTowardPaddle =
			myRole == 0
				? v[2] > 0
				: v[2] < 0;

		let movingAway =
			myRole == 0
				? v[2] < 0
				: v[2] > 0;

		if (movingAway)
			localHitSent = false;

		if (!movingTowardPaddle || localHitSent)
			return;

		let hitZ = Math.abs(p[2] - paddle[2]) < HIT_DEPTH + .06;
		let hitX = Math.abs(p[0] - paddle[0]) < HIT_WIDTH;
		let hitY = Math.abs(p[1] - paddle[1]) < HIT_HEIGHT;

		if (hitZ && hitX && hitY) {
			server.send('pingPongGame', {
				op: 'hit',
				player: myRole,
				ball: roundVec(p),
				vel: roundVec(v),
				paddlePos: roundVec(paddle),
				paddleVel: roundVec(paddleVel)
			});

			let result = returnBall(
				myRole,
				p.slice(),
				v.slice(),
				paddle,
				paddleVel
			);

			remoteBall = result[0].slice();
			remoteVel = result[1].slice();
			remoteBallTime = now;

			localHitSent = true;
			vibrate('right', .45, 45);
		}
	};

	// Ball physics

	let updateBallPhysics = (now, dt) => {
		if (
			myRole != pingPongGame.owner ||
			!pingPongGame.playing
		) {
			return;
		}

		let oldBall = pingPongGame.ball.slice();
		let p = pingPongGame.ball.slice();
		let v = pingPongGame.vel.slice();

		let forceBallSend = false;

		v[1] += GRAVITY * dt;

		p[0] += v[0] * dt;
		p[1] += v[1] * dt;
		p[2] += v[2] * dt;

		if (p[0] > TABLE_HALF_X - BALL_RADIUS) {
			p[0] = TABLE_HALF_X - BALL_RADIUS;
			v[0] = -Math.abs(v[0]) * .8;
			forceBallSend = true;
		}

		if (p[0] < -TABLE_HALF_X + BALL_RADIUS) {
			p[0] = -TABLE_HALF_X + BALL_RADIUS;
			v[0] = Math.abs(v[0]) * .8;
			forceBallSend = true;
		}

		let overTable =
			p[2] < NEAR_EDGE &&
			p[2] > FAR_EDGE;

		let surface = TABLE_TOP + BALL_RADIUS;

		if (
			overTable &&
			oldBall[1] > surface &&
			p[1] <= surface &&
			v[1] < 0
		) {
			p[1] = surface;
			v[1] = Math.max(.40, Math.abs(v[1]) * .78);
			forceBallSend = true;
		}

		let crossedNet =
			(
				oldBall[2] < NET_Z &&
				p[2] >= NET_Z
			) ||
			(
				oldBall[2] > NET_Z &&
				p[2] <= NET_Z
			);

		if (
			crossedNet &&
			p[1] < NET_TOP + BALL_RADIUS
		) {
			if (v[2] > 0) {
				p[2] = NET_Z - .03;
				v[2] = -Math.abs(v[2]) * .8;
			}
			else {
				p[2] = NET_Z + .03;
				v[2] = Math.abs(v[2]) * .8;
			}

			forceBallSend = true;
		}

		let player = pingPongGame.owner;
		let paddle = pingPongPaddles.pos[player];

		let movingTowardPaddle =
			player == 0
				? v[2] > 0
				: v[2] < 0;

		let crossedPaddle;

		if (player == 0) {
			crossedPaddle =
				(
					oldBall[2] < paddle[2] &&
					p[2] >= paddle[2]
				) ||
				Math.abs(p[2] - paddle[2]) < HIT_DEPTH;
		}
		else {
			crossedPaddle =
				(
					oldBall[2] > paddle[2] &&
					p[2] <= paddle[2]
				) ||
				Math.abs(p[2] - paddle[2]) < HIT_DEPTH;
		}

		if (
			movingTowardPaddle &&
			crossedPaddle &&
			now - lastPaddleHit > .08
		) {
			let hitX = Math.abs(p[0] - paddle[0]) < HIT_WIDTH;
			let hitY = Math.abs(p[1] - paddle[1]) < HIT_HEIGHT;

			if (hitX && hitY) {
				let result = returnBall(player, p, v);

				p = result[0];
				v = result[1];

				lastPaddleHit = now;
				forceBallSend = true;

				vibrate('right', .45, 45);
			}
		}

		if (p[2] > NEAR_EDGE + .40) {
			scorePoint(1, now);
			return;
		}

		if (p[2] < FAR_EDGE - .40) {
			scorePoint(0, now);
			return;
		}

		if (p[1] < .05) {
			if (p[2] > NET_Z)
				scorePoint(1, now);
			else
				scorePoint(0, now);

			return;
		}

		pingPongGame.ball = p;
		pingPongGame.vel = v;

		if (
			forceBallSend ||
			now - lastBallSend > .033
		) {
			sendBallState(p, v, now);
		}
	};

	// Animation

	model.animate(() => {
		let now = Date.now() / 1000;
		let dt = Math.min(.04, now - lastPhysicsTime);

		lastPhysicsTime = now;

		server.sync('pingPongPaddles', msgs => {
			for (let id in msgs) {
				let msg = msgs[id];

				if (
					msg.op == 'paddle' &&
					msg.player != myRole
				) {
					pingPongPaddles.pos[msg.player] = msg.pos.slice();
					pingPongPaddles.vel[msg.player] = msg.vel.slice();
				}

				if (msg.op == 'reset') {
					pingPongPaddles.pos = [
						[0, .88, PLAYER1_HOME_Z],
						[0, .88, PLAYER2_HOME_Z]
					];

					pingPongPaddles.vel = [
						[0, 0, 0],
						[0, 0, 0]
					];

					controllerAnchor = null;

					if (myRole >= 0) {
						paddleAnchor = pingPongPaddles.pos[myRole].slice();
						previousPaddlePos[myRole] = pingPongPaddles.pos[myRole].slice();
						previousPaddleTime = now;
					}
				}
			}
		});

		server.sync('pingPongGame', msgs => {
			for (let id in msgs) {
				let msg = msgs[id];

				if (msg.op == 'start') {
					pingPongGame.owner = msg.owner;
					pingPongGame.ball = msg.ball.slice();
					pingPongGame.vel = msg.vel.slice();
					pingPongGame.playing = true;

					remoteBall = msg.ball.slice();
					remoteVel = msg.vel.slice();
					remoteBallTime = now;

					localHitSent = false;
					servePending = false;
					lastPhysicsTime = now;
				}

				if (
					msg.op == 'ball' &&
					myRole != pingPongGame.owner &&
					msg.owner == pingPongGame.owner
				) {
					pingPongGame.ball = msg.ball.slice();
					pingPongGame.vel = msg.vel.slice();

					remoteBall = msg.ball.slice();
					remoteVel = msg.vel.slice();
					remoteBallTime = now;

					let movingAway =
						myRole == 0
							? msg.vel[2] < 0
							: msg.vel[2] > 0;

					if (movingAway)
						localHitSent = false;
				}

				if (
					msg.op == 'hit' &&
					myRole == pingPongGame.owner &&
					msg.player != pingPongGame.owner &&
					pingPongGame.playing &&
					now - lastPaddleHit > .08
				) {
					let movingTowardPlayer =
						msg.player == 0
							? pingPongGame.vel[2] > 0
							: pingPongGame.vel[2] < 0;

					if (movingTowardPlayer) {
						let result = returnBall(
							msg.player,
							msg.ball.slice(),
							msg.vel.slice(),
							msg.paddlePos.slice(),
							msg.paddleVel.slice()
						);

						pingPongGame.ball = result[0];
						pingPongGame.vel = result[1];

						lastPaddleHit = now;

						sendBallState(
							pingPongGame.ball,
							pingPongGame.vel,
							now
						);
					}
				}

				if (msg.op == 'point') {
					pingPongGame.owner = msg.owner;
					pingPongGame.score = msg.score.slice();
					pingPongGame.winner = msg.winner;
					pingPongGame.playing = false;

					pingPongGame.ball = [
						0,
						1.00,
						TABLE_CENTER_Z
					];

					remoteBall = pingPongGame.ball.slice();
					remoteVel = [0, 0, 0];
					remoteBallTime = now;

					localHitSent = false;
				}

				if (msg.op == 'reset') {
					pingPongGame.ball = [
						0,
						1.00,
						TABLE_CENTER_Z
					];

					pingPongGame.vel = [
						.20,
						.72,
						-1.38
					];

					pingPongGame.score = [0, 0];
					pingPongGame.playing = false;
					pingPongGame.winner = -1;
					pingPongGame.owner = -1;

					remoteBall = pingPongGame.ball.slice();
					remoteVel = pingPongGame.vel.slice();
					remoteBallTime = now;

					servePending = false;
					lastPaddleHit = 0;
					localHitSent = false;
				}
			}
		});

		updateVRPaddle(now);
		checkLocalPaddleHit(now);
		updateBallPhysics(now, dt);

		if (
			myRole == pingPongGame.owner &&
			servePending &&
			pingPongGame.winner < 0 &&
			now >= serveTime
		) {
			sendStart(nextServeDirection);
		}

		// Table

		table
			.identity()
			.move(0, TABLE_Y, TABLE_CENTER_Z)
			.scale(TABLE_HALF_X, .04, TABLE_HALF_Z)
			.color(.05, .30, .18)
			.dull();

		centerLine
			.identity()
			.move(0, TABLE_TOP + .005, TABLE_CENTER_Z)
			.scale(.012, .008, TABLE_HALF_Z)
			.color(.85, .85, .85)
			.dull();

		net
			.identity()
			.move(0, .79, NET_Z)
			.scale(TABLE_HALF_X, .10, .012)
			.color(.75, .75, .80)
			.dull();

		netPost1
			.identity()
			.move(-TABLE_HALF_X, .79, NET_Z)
			.scale(.018, .12, .018)
			.color(.2, .2, .2)
			.dull();

		netPost2
			.identity()
			.move(TABLE_HALF_X, .79, NET_Z)
			.scale(.018, .12, .018)
			.color(.2, .2, .2)
			.dull();

		let paddle1Pos = viewPos(pingPongPaddles.pos[0]);
		let paddle2Pos = viewPos(pingPongPaddles.pos[1]);

		let displayBall = getDisplayBall(now);
		let ballPos = viewPos(displayBall);

		paddle1
			.identity()
			.move(paddle1Pos);

		paddle1Face
			.identity()
			.scale(.15, .18, .025)
			.color(.15, .65, 1)
			.dull();

		paddle1Handle
			.identity()
			.move(0, -.22, 0)
			.scale(.035, .10, .025)
			.color(.25, .12, .05)
			.dull();

		paddle2
			.identity()
			.move(paddle2Pos);

		paddle2Face
			.identity()
			.scale(.15, .18, .025)
			.color(1, .45, .1)
			.dull();

		paddle2Handle
			.identity()
			.move(0, -.22, 0)
			.scale(.035, .10, .025)
			.color(.25, .12, .05)
			.dull();

		ball
			.identity()
			.move(ballPos)
			.scale(BALL_RADIUS)
			.color(1, 1, 1)
			.dull();

		// UI

		showText(
			titleText,
			-.325,
			2.00,
			-1,
			1.40
		);

		if (myRole < 0) {
			showText(
				chooseText,
				-.18,
				1.64,
				-1,
				1.15
			);

			player1RoleButton
				.identity()
				.move(PLAYER1_ROLE_POS)
				.scale(.14)
				.color(.15, .65, 1)
				.dull();

			player2RoleButton
				.identity()
				.move(PLAYER2_ROLE_POS)
				.scale(.14)
				.color(1, .45, .1)
				.dull();

			showText(
				player1Text,
				-.37,
				1.13,
				-1,
				.70
			);

			showText(
				player2Text,
				.26,
				1.13,
				-1,
				.70
			);
		}
		else {
			hide(chooseText);
			hide(player1RoleButton);
			hide(player2RoleButton);
			hide(player1Text);
			hide(player2Text);
		}

		for (let i = 0; i <= WIN_SCORE; i++) {
			if (i == pingPongGame.score[0]) {
				showText(
					player1ScoreText[i],
					-.43,
					1.84,
					-1,
					1.25
				);
			}
			else {
				hide(player1ScoreText[i]);
			}

			if (i == pingPongGame.score[1]) {
				showText(
					player2ScoreText[i],
					.30,
					1.84,
					-1,
					1.25
				);
			}
			else {
				hide(player2ScoreText[i]);
			}
		}

		hide(startButton);
		hide(startText);

		if (
			myRole >= 0 &&
			!pingPongGame.playing &&
			pingPongGame.winner < 0 &&
			pingPongGame.owner < 0 &&
			!servePending
		) {
			startButton
				.identity()
				.move(START_POS)
				.scale(.13)
				.color(.2, 1, .3)
				.dull();

			showText(
				startText,
				-.15,
				1.68,
				-1,
				.65
			);
		}

		hide(resetButton);
		hide(resetText);

		if (
			myRole >= 0 &&
			pingPongGame.winner >= 0
		) {
			resetButton
				.identity()
				.move(RESET_POS)
				.scale(.14)
				.color(1, .15, .15)
				.dull();

			showText(
				resetText,
				-.07,
				1.08,
				-1,
				.72
			);
		}

		hide(playingText);
		hide(player1WinText);
		hide(player2WinText);

		if (pingPongGame.owner >= 0) {
			showText(
				playingText,
				-.09,
				1.77,
				-1,
				.62
			);
		}

		if (pingPongGame.winner == 0) {
			showText(
				player1WinText,
				-.16,
				1.55,
				-.9,
				1.25
			);
		}

		if (pingPongGame.winner == 1) {
			showText(
				player2WinText,
				-.16,
				1.55,
				-.9,
				1.25
			);
		}
	});
};