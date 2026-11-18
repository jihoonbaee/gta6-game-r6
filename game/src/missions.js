/* Neon Harbor — contracts, shift economy and the single local checkpoint.
 * Written for the R8 brief. Timers advance only through simulation updates.
 */
export const SAVE_KEY = 'neon-harbor-save';
export const SHIFT_START_MONEY = 2450;
export const CONTRACTS = Object.freeze([
  Object.freeze({ title: 'A LIGHTER TOUCH', reward: 400, objective: 'Steal the marked Solaris Vela.' }),
  Object.freeze({ title: 'PIER RUN', reward: 650, objective: 'Drive to Pier 04.' }),
  Object.freeze({ title: 'THE MEETING', reward: 850, objective: 'Reach the meeting point on foot.' }),
  Object.freeze({ title: 'LAST LIGHT', reward: 1200, objective: 'Lose the police, then reach the Safehouse.' }),
]);
const ACTIVATION_DELAY = 1.25;
const validIndex = (value, completed = false) => Number.isInteger(value) && value >= 0 && value <= (completed ? CONTRACTS.length : CONTRACTS.length - 1);
const nonnegative = (value, fallback = 0) => Number.isFinite(value) && value >= 0 ? value : fallback;

export function createMissions({ screenshotMode = false } = {}) {
  const missions = { screenshotMode, disposed: false };
  resetMissions(missions);
  return missions;
}

export function resetMissions(missions) {
  Object.assign(missions, {
    index: 0, complete: false, activeSeconds: 0, seenPursuit: false,
    contractRemaining: 5, banner: null, objectivePosition: null,
    loadReady: false, world: null,
  });
}

export function setMissionIndex(missions, index, { announce = true } = {}) {
  if (missions.disposed || !validIndex(index)) return false;
  missions.index = index;
  missions.complete = false;
  missions.activeSeconds = 0;
  missions.seenPursuit = false;
  missions.contractRemaining = announce ? 5 : 0;
  missions.banner = null;
  missions.objectivePosition = null;
  if (missions.world?.state) {
    missions.world.state.missionIndex = index;
    missions.world.state.won = false;
  }
  if (missions.world) syncObjective(missions, missions.world);
  return true;
}

function destination(missions, world) {
  if (missions.complete) return null;
  if (missions.index === 0) return world.markedVehicle?.position ?? null;
  if (missions.index === 1) return world.locations.pier;
  if (missions.index === 2) return world.locations.meeting;
  // The center of the Safehouse is solid. Its front apron is walkable.
  const warehouse = world.locations.safehouse;
  return { x: warehouse.x, y: 0, z: warehouse.z - 13 };
}

function syncObjective(missions, world) {
  missions.objectivePosition = destination(missions, world);
  world.setObjective(missions.objectivePosition);
  if (world.markedVehicle?.marker) world.markedVehicle.marker.visible = !missions.complete && missions.index === 0;
  if (world.objectiveMarker) {
    world.objectiveMarker.visible = !missions.complete && missions.index !== 0;
    if (missions.objectivePosition) world.objectiveMarker.position.copy(missions.objectivePosition);
  }
}

export function getMissionView(missions, world) {
  const contract = CONTRACTS[missions.index] ?? null;
  const objectivePosition = world ? destination(missions, world) : missions.objectivePosition;
  return {
    index: missions.index, number: contract ? String(missions.index + 1).padStart(2, '0') : null,
    title: contract?.title ?? 'SHIFT COMPLETE', reward: contract?.reward ?? 0,
    objective: missions.complete ? 'All contracts complete. Explore Neon Harbor.' : contract.objective,
    newContract: !missions.complete && missions.contractRemaining > 0,
    complete: missions.complete, seenPursuit: missions.seenPursuit,
    objectivePosition, banner: missions.banner,
  };
}

export function updateMissions(missions, dt, state, world) {
  const events = [];
  if (missions.disposed) return events;
  missions.world = world;
  state.missionIndex = missions.index;
  syncObjective(missions, world);
  if (!Number.isFinite(dt) || dt < 0 || state.paused || state.frozen || !state.running || state.screen !== 'playing' || state.dead || state.health <= 0) return events;
  missions.activeSeconds += dt;
  missions.contractRemaining = Math.max(0, missions.contractRemaining - dt);
  if (missions.banner) {
    missions.banner.remaining = Math.max(0, missions.banner.remaining - dt);
    if (missions.banner.remaining === 0) missions.banner = null;
  }
  if (missions.complete) return events;
  if (missions.index === 3 && state.wanted > 0) missions.seenPursuit = true;
  if (missions.activeSeconds < ACTIVATION_DELAY) return events;

  const position = world.getActorPosition();
  const target = missions.objectivePosition;
  const nearby = target && Math.hypot(position.x - target.x, position.z - target.z) <= (missions.index === 1 ? 10 : 5);
  const vehicle = world.getActiveVehicle();
  const passed = [
    () => state.actor === 'vehicle' && vehicle != null && vehicle.id === world.markedVehicle?.id,
    () => state.actor === 'vehicle' && vehicle != null && nearby,
    () => state.actor === 'foot' && nearby,
    () => missions.seenPursuit && state.wanted === 0 && nearby,
  ][missions.index]();
  if (!passed) return events;

  const completed = CONTRACTS[missions.index];
  missions.index += 1;
  missions.complete = missions.index === CONTRACTS.length;
  missions.activeSeconds = 0;
  missions.contractRemaining = missions.complete ? 0 : 5;
  missions.seenPursuit = false;
  missions.banner = { title: completed.title, reward: completed.reward, remaining: 4.5 };
  state.missionIndex = missions.index;
  syncObjective(missions, world);
  world.playSound?.('mission');
  events.push({ type: 'reward', amount: completed.reward });
  if (missions.complete) events.push({ type: 'victory' });
  else if (missions.index === 3) {
    // A real police response starts the final escape; never reduce existing heat.
    state.wanted = Math.max(state.wanted, 2);
    state.heat = Math.max(state.heat, 18);
    missions.seenPursuit = true;
    world.syncPolice(world, Math.ceil(state.wanted));
  }
  return events;
}

export function getMissionSnapshot(missions) {
  return { index: missions.index, complete: missions.complete, activeSeconds: missions.activeSeconds, seenPursuit: missions.seenPursuit };
}

export function applyMissionSnapshot(missions, snapshot) {
  if (!snapshot || !validIndex(snapshot.index, true)) return false;
  missions.index = snapshot.index;
  missions.complete = snapshot.index === CONTRACTS.length;
  missions.activeSeconds = nonnegative(snapshot.activeSeconds);
  missions.seenPursuit = snapshot.seenPursuit === true;
  missions.contractRemaining = 0;
  missions.banner = null;
  if (missions.world) syncObjective(missions, missions.world);
  return true;
}

export function readCheckpoint() {
  try {
    const raw = globalThis.localStorage.getItem(SAVE_KEY);
    if (raw === null) return null;
    const data = JSON.parse(raw);
    if (!data || Array.isArray(data) || typeof data !== 'object') return null;
    const recognizable = validIndex(data.mission?.index, true) || Number.isFinite(data.money) || Number.isFinite(data.health) || (data.world && typeof data.world === 'object');
    return recognizable ? data : null;
  } catch {
    return null;
  }
}

export function saveCheckpoint(missions, state, worldSnapshot) {
  if (missions.disposed || missions.screenshotMode || !missions.loadReady || !state.running || state.paused || state.dead || !['playing', 'victory'].includes(state.screen)) return false;
  const checkpoint = {
    version: 1, mission: getMissionSnapshot(missions),
    money: state.money, shiftStartMoney: state.shiftStartMoney,
    health: state.health, wanted: state.wanted, heat: state.heat,
    actor: state.actor, vehicleId: state.vehicleId,
    world: worldSnapshot, clockSeconds: state.clockSeconds,
  };
  try {
    globalThis.localStorage.setItem(SAVE_KEY, JSON.stringify(checkpoint));
    return true;
  } catch {
    return false;
  }
}

export function loadCheckpoint(missions, state, checkpoint, restoreWorld) {
  // The binding reads the slot before reset. No autosave is allowed until here.
  missions.loadReady = false;
  if (!checkpoint || typeof checkpoint !== 'object') {
    missions.loadReady = true;
    return false;
  }
  if (checkpoint.world) {
    const actor = checkpoint.actor ?? checkpoint.world.actor;
    restoreWorld({ ...checkpoint.world, actor, vehicleId: checkpoint.vehicleId ?? checkpoint.world.vehicleId });
  }
  // Apply scalar state AFTER world reset/restore, which clears combat state.
  if (Number.isFinite(checkpoint.money)) state.money = checkpoint.money;
  if (Number.isFinite(checkpoint.shiftStartMoney)) state.shiftStartMoney = checkpoint.shiftStartMoney;
  if (Number.isFinite(checkpoint.health) && checkpoint.health >= 0 && checkpoint.health <= 100) state.health = checkpoint.health;
  if (Number.isFinite(checkpoint.wanted) && checkpoint.wanted >= 0 && checkpoint.wanted <= 5) state.wanted = checkpoint.wanted;
  if (Number.isFinite(checkpoint.heat) && checkpoint.heat >= 0) state.heat = checkpoint.heat;
  if (Number.isFinite(checkpoint.clockSeconds) && checkpoint.clockSeconds >= 0) state.clockSeconds = checkpoint.clockSeconds;
  applyMissionSnapshot(missions, checkpoint.mission);
  state.missionIndex = missions.index;
  state.won = missions.complete;
  missions.loadReady = true;
  return true;
}

export function disposeMissions(missions) {
  if (!missions) return;
  missions.banner = null;
  missions.world = null;
  missions.objectivePosition = null;
  missions.loadReady = false;
  missions.disposed = true;
}
