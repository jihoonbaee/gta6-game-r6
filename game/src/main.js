import {
  createWorld,
  resetWorld,
  updateWorld,
  renderWorld,
  disposeWorld,
  getWorldSnapshot,
  applyWorldSnapshot,
} from './world.js';
import {
  createHud,
  updateHud,
  renderHud,
  setScreen,
  setDamageFlash,
  disposeHud,
} from './hud.js';
import {
  createMissions,
  updateMissions,
  resetMissions,
  setMissionIndex,
  disposeMissions,
  SHIFT_START_MONEY,
  readCheckpoint,
  saveCheckpoint as storeCheckpoint,
  loadCheckpoint as restoreCheckpoint,
} from './missions.js';

const SAVE_INTERVAL = 5;
const SHOT_SCENES = new Set(['harbor-pursuit', 'street-life', 'police-response', 'first-shift']);

const root = document.querySelector('#game-root');
const canvas = document.querySelector('#game-canvas');
const screenLayer = document.querySelector('#screen-layer');
const hudLayer = document.querySelector('#hud-layer');
const shotName = new URLSearchParams(location.search).get('shot');
const screenshotMode = SHOT_SCENES.has(shotName);

const state = {
  screen: 'title',
  running: false,
  frozen: false,
  paused: false,
  dead: false,
  won: false,
  elapsed: 0,
  saveElapsed: 0,
  clockSeconds: 0,
  money: SHIFT_START_MONEY,
  shiftStartMoney: SHIFT_START_MONEY,
  health: 100,
  wanted: 0,
  heat: 0,
  ammo: 12,
  reloadRemaining: 0,
  actor: 'foot',
  vehicleId: null,
  missionIndex: 0,
  keys: new Set(),
  mouse: { dx: 0, dy: 0, aiming: false },
  actions: { interact: false, shoot: false, melee: false, reload: false },
};

let world;
let hud;
let missions;
let previousFrame = 0;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const wantedStars = () => Math.ceil(clamp(state.wanted, 0, 5));

function requestPointerLock() {
  // Navigation or browser policy may reject capture; keyboard play still works.
  root.requestPointerLock?.()?.catch(() => {});
}

function saveCheckpoint() {
  return storeCheckpoint(missions, state, getWorldSnapshot(world));
}

function loadCheckpoint(checkpoint = readCheckpoint()) {
  const loaded = restoreCheckpoint(missions, state, checkpoint, (snapshot) => applyWorldSnapshot(world, snapshot));
  state.actor = world.actor;
  state.vehicleId = world.vehicleId;
  world.syncPolice(world, wantedStars());
  return loaded;
}

function makeShotStage(name) {
  const stages = {
    'harbor-pursuit': { mission: 3, actor: 'vehicle', wanted: 2, area: 'harbor' },
    'street-life': { mission: 2, actor: 'foot', wanted: 0, area: 'tideline' },
    'police-response': { mission: 3, actor: 'foot', wanted: 3, area: 'tideline' },
    'first-shift': { mission: 0, actor: 'foot', wanted: 0, area: 'harbor' },
  };
  const stage = stages[name];
  if (!stage) return;
  state.screen = 'playing';
  state.running = true;
  state.actor = stage.actor;
  state.wanted = stage.wanted;
  state.missionIndex = stage.mission;
  setMissionIndex(missions, stage.mission, { announce: false });
  world.stageForScreenshot(stage);
  // The stage resets the world, so install staged state after it returns.
  state.actor = world.actor;
  state.vehicleId = world.vehicleId;
  state.wanted = stage.wanted;
  state.heat = stage.wanted ? 18 : 0;
  world.syncPolice(world, wantedStars());
  setScreen(hud, 'playing');
}

function resetSession({ checkpoint = true } = {}) {
  const stored = checkpoint ? readCheckpoint() : null;
  state.elapsed = 0;
  state.saveElapsed = 0;
  state.clockSeconds = 0;
  state.money = SHIFT_START_MONEY;
  state.shiftStartMoney = SHIFT_START_MONEY;
  state.health = 100;
  state.wanted = 0;
  state.heat = 0;
  state.ammo = 12;
  state.reloadRemaining = 0;
  state.actor = 'foot';
  state.vehicleId = null;
  state.dead = false;
  state.won = false;
  state.paused = false;
  state.keys.clear();
  state.mouse = { dx: 0, dy: 0, aiming: false };
  state.actions = { interact: false, shoot: false, melee: false, reload: false };
  resetWorld(world);
  resetMissions(missions);
  loadCheckpoint(stored);
  state.running = true;
  state.screen = 'playing';
  setScreen(hud, 'playing', { reset: true });
  updateHud(hud, { state, world, missions, dt: 0 });
  if (state.health <= 0) enterDeath();
}

function beginFromTitle() {
  resetSession({ checkpoint: true });
  if (!state.dead) requestPointerLock();
}

function togglePause() {
  if (state.screen === 'title' || state.screen === 'death' || state.screen === 'victory') return;
  state.paused = !state.paused;
  state.screen = state.paused ? 'pause' : 'playing';
  state.mouse.dx = 0;
  state.mouse.dy = 0;
  state.mouse.aiming = false;
  state.keys.clear();
  state.actions = { interact: false, shoot: false, melee: false, reload: false };
  setScreen(hud, state.screen, { hasProfile: Boolean(readCheckpoint()) });
  if (state.paused && document.pointerLockElement) document.exitPointerLock?.();
  else if (!state.paused) requestPointerLock();
}

function setDamage(amount, source = 'impact') {
  state.health = Math.max(0, state.health - Math.max(0, amount));
  setDamageFlash(hud, source);
  if (state.health === 0) enterDeath();
}

function enterDeath() {
  state.dead = true;
  state.screen = 'death';
  state.running = false;
  state.paused = false;
  state.ammo = 12;
  state.reloadRemaining = 0;
  state.heat = 0;
  state.wanted = 0;
  world.clearTransientEffects(world);
  setScreen(hud, 'death', { hasProfile: Boolean(readCheckpoint()) });
  if (document.pointerLockElement) document.exitPointerLock?.();
}

function onKeyDown(event) {
  const key = event.key.toLowerCase();
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) event.preventDefault();
  if (key === 'escape') {
    if (!event.repeat) togglePause();
    return;
  }
  if (state.screen !== 'playing' || state.paused) return;
  state.keys.add(key);
  if (key === 'e') state.actions.interact = true;
  if (key === 'f') state.actions.shoot = true;
  if (key === 'r') state.actions.reload = true;
  if (key === ' ') state.actions.melee = true;
}

function onKeyUp(event) {
  state.keys.delete(event.key.toLowerCase());
}

function onMouseMove(event) {
  if (state.screen !== 'playing' || state.paused || state.frozen) return;
  if (document.pointerLockElement === root) {
    state.mouse.dx += event.movementX;
    state.mouse.dy += event.movementY;
  }
}

function onMouseDown(event) {
  if (state.screen !== 'playing' || state.paused || state.frozen) return;
  if (event.button === 2) {
    event.preventDefault();
    state.mouse.aiming = true;
  }
  if (event.button === 0) state.actions.shoot = true;
}

function onMouseUp(event) {
  if (state.paused || state.frozen) return;
  if (event.button === 2) state.mouse.aiming = false;
}

function consumeInput() {
  const input = {
    forward: state.keys.has('w') || state.keys.has('arrowup'),
    backward: state.keys.has('s') || state.keys.has('arrowdown'),
    left: state.keys.has('a') || state.keys.has('arrowleft'),
    right: state.keys.has('d') || state.keys.has('arrowright'),
    run: state.keys.has('shift'),
    handbrake: state.keys.has(' '),
    aiming: state.mouse.aiming,
    lookX: state.mouse.dx,
    lookY: state.mouse.dy,
    interact: state.actions.interact,
    shoot: state.actions.shoot,
    melee: state.actions.melee,
    reload: state.actions.reload,
  };
  state.mouse.dx = 0;
  state.mouse.dy = 0;
  state.actions = { interact: false, shoot: false, melee: false, reload: false };
  return input;
}

function simulateStep(dt) {
  state.elapsed += dt;
  state.clockSeconds += dt;
  state.saveElapsed += dt;
  const input = consumeInput();
  const events = updateWorld(world, dt, input, state);
  for (const event of events) {
    if (event.type === 'crime') {
      state.wanted = Math.max(state.wanted, event.level);
      state.heat = Math.max(state.heat, event.heat);
    } else if (event.type === 'damage') {
      setDamage(event.amount, event.source);
    } else if (event.type === 'actor') {
      state.actor = event.actor;
      state.vehicleId = event.vehicleId ?? null;
    }
  }
  if (state.heat > 0) state.heat = Math.max(0, state.heat - dt);
  else if (state.wanted > 0) state.wanted = Math.max(0, state.wanted - 0.22 * dt);
  world.syncPolice(world, wantedStars(), dt);
  const missionEvents = updateMissions(missions, dt, state, world);
  for (const event of missionEvents) {
    if (event.type === 'reward') {
      state.money += event.amount;
      saveCheckpoint();
    }
    if (event.type === 'victory') {
      state.won = true;
      state.screen = 'victory';
      state.paused = true;
      state.mouse.aiming = false;
      state.keys.clear();
      state.mouse.dx = 0;
      state.mouse.dy = 0;
      state.actions = { interact: false, shoot: false, melee: false, reload: false };
      setScreen(hud, 'victory', { shiftEarnings: state.money - state.shiftStartMoney });
      if (document.pointerLockElement) document.exitPointerLock?.();
    }
  }
  if (state.health <= 0 && !state.dead) enterDeath();
  if (state.saveElapsed >= SAVE_INTERVAL) {
    state.saveElapsed %= SAVE_INTERVAL;
    saveCheckpoint();
  }
  updateHud(hud, {
    state,
    world,
    missions,
    shiftEarnings: state.money - state.shiftStartMoney,
    wantedStars: wantedStars(),
    clockSeconds: state.clockSeconds,
    dt,
  });
}

function frame(timestamp) {
  if (!previousFrame) previousFrame = timestamp;
  const frameDt = Math.min((timestamp - previousFrame) / 1000, 0.05);
  previousFrame = timestamp;
  if (state.running && !state.paused && !state.frozen) simulateStep(frameDt);
  renderWorld(world, canvas);
  renderHud(hud);
  if (screenshotMode && !state.frozen) {
    state.frozen = true;
    state.running = false;
    window.__NEON_HARBOR_READY__ = true;
    window.dispatchEvent(new CustomEvent('neon-harbor-ready', { detail: { shot: shotName } }));
  }
  requestAnimationFrame(frame);
}

function advanceSimulation(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0 || state.paused || state.screen === 'title' || !state.running) return false;
  let remaining = seconds;
  const step = 1 / 60;
  while (remaining > 0 && state.running && !state.paused) {
    const dt = Math.min(step, remaining);
    simulateStep(dt);
    remaining -= dt;
  }
  renderWorld(world, canvas);
  renderHud(hud);
  return true;
}

function setDebugMission(index) {
  if (!Number.isInteger(index) || index < 0 || index > 3) return false;
  setMissionIndex(missions, index);
  state.missionIndex = index;
  return true;
}

function wireHudActions() {
  hud.onAction = (action) => {
    if (action === 'start') beginFromTitle();
    else if (action === 'resume') togglePause();
    else if (action === 'continue' && state.screen === 'victory') {
      state.paused = false;
      state.screen = 'playing';
      setScreen(hud, 'playing');
      requestPointerLock();
    } else if (action === 'restart') {
      resetSession({ checkpoint: true });
      if (!state.dead) requestPointerLock();
    } else if (action === 'title') {
      state.running = false;
      state.paused = false;
      state.screen = 'title';
      setScreen(hud, 'title', { hasProfile: Boolean(readCheckpoint()) });
      if (document.pointerLockElement) document.exitPointerLock?.();
    } else if (action === 'respawn') {
      state.health = 100;
      state.wanted = 0;
      state.heat = 0;
      state.dead = false;
      state.ammo = 12;
      state.reloadRemaining = 0;
      state.keys.clear();
      state.mouse = { dx: 0, dy: 0, aiming: false };
      state.actions = { interact: false, shoot: false, melee: false, reload: false };
      resetWorld(world);
      state.actor = 'foot';
      state.vehicleId = null;
      state.running = true;
      state.screen = 'playing';
      setScreen(hud, 'playing', {});
      updateHud(hud, { state, world, missions, dt: 0 });
      requestPointerLock();
    } else if (action === 'mute') {
      world.setAudioEnabled(world, !world.audioEnabled);
      setScreen(hud, state.screen, { audioEnabled: world.audioEnabled });
    }
  };
}

function initialize() {
  world = createWorld({ canvas, screenshotMode });
  world.state = state;
  missions = createMissions({ screenshotMode });
  hud = createHud({ screenLayer, hudLayer, canvas, screenshotMode, hasProfile: Boolean(readCheckpoint()) });
  wireHudActions();
  setScreen(hud, 'title', { hasProfile: Boolean(readCheckpoint()) });
  if (screenshotMode) makeShotStage(shotName);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('contextmenu', (event) => event.preventDefault());
  window.addEventListener('blur', () => {
    state.keys.clear();
    state.mouse.aiming = false;
  });
  window.addEventListener('resize', () => world.resize(world));
  window.__NEON_HARBOR__ = {
    start: () => resetSession({ checkpoint: true }),
    pause: togglePause,
    advance: advanceSimulation,
    setMission: setDebugMission,
    getState: () => ({ ...state, keys: undefined, mouse: undefined, actions: undefined }),
    getSnapshot: () => ({
      ...getWorldSnapshot(world),
      policeCount: world.police.length,
      speedKmh: world.speedKmh,
    }),
    reset: () => resetSession({ checkpoint: false }),
  };
  requestAnimationFrame(frame);
}

window.addEventListener('beforeunload', () => {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  disposeWorld(world);
  disposeHud(hud);
  disposeMissions(missions);
});

initialize();
