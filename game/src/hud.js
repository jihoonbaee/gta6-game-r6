/* Neon Harbor — live instruments, north-up city map and accessible menus.
 * No UI timers use wall time: pause and debug advance share simulation dt.
 */
import { getMissionView, readCheckpoint } from './missions.js';

const cash = (value) => `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const pad = (value) => String(value).padStart(2, '0');
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function element(tag, className, text, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.append(node);
  return node;
}

function instrument(parent, label, className = '') {
  const box = element('div', `instrument ${className}`, undefined, parent);
  element('span', 'eyebrow', label, box);
  return element('strong', 'instrument-value', '', box);
}

export function createHud({ screenLayer, hudLayer, screenshotMode = false } = {}) {
  const hud = {
    screenLayer, hudLayer, screenshotMode, onAction: null, screen: 'title',
    last: null, toast: null, damageRemaining: 0, previousWanted: 0,
    previousClock: 0, screenData: {}, disposed: false,
  };
  hud.root = element('div', 'live-hud', undefined, hudLayer);
  const brand = element('header', 'city-brand', undefined, hud.root);
  element('span', 'brand-rule', '', brand);
  element('strong', 'brand-name', 'NEON HARBOR', brand);
  element('span', 'brand-caption', 'HARBORLINE COURIER', brand);

  const status = element('section', 'status-cluster', undefined, hud.root);
  status.setAttribute('aria-label', 'Player status');
  const time = element('div', 'time-row', undefined, status);
  hud.date = element('span', 'game-date', '', time);
  hud.clock = element('strong', 'game-clock', '', time);
  hud.stars = element('div', 'wanted-stars', undefined, status);
  hud.starNodes = Array.from({ length: 5 }, () => element('span', 'wanted-star', '★', hud.stars));
  hud.pursuit = element('span', 'pursuit-status', '', status);
  hud.money = element('strong', 'cash-value', '', status);
  hud.earnings = element('span', 'shift-value', '', status);
  const vitals = element('div', 'vitals', undefined, status);
  hud.health = instrument(vitals, 'HEALTH', 'health-instrument');
  const healthBar = element('div', 'health-track', undefined, vitals);
  hud.healthFill = element('div', 'health-fill', undefined, healthBar);
  hud.ammoBox = element('div', 'ammo-instrument', undefined, vitals);
  hud.ammo = instrument(hud.ammoBox, 'AMMO');

  hud.contract = element('section', 'contract-card', undefined, hud.root);
  hud.contract.setAttribute('aria-label', 'Current contract');
  const heading = element('div', 'contract-heading', undefined, hud.contract);
  hud.contractNumber = element('strong', 'contract-number', '', heading);
  const titleGroup = element('div', 'contract-titles', undefined, heading);
  hud.newContract = element('span', 'eyebrow contract-tag', '', titleGroup);
  hud.contractTitle = element('h2', 'contract-title', '', titleGroup);
  hud.objective = element('p', 'contract-objective', '', hud.contract);
  const contractFoot = element('div', 'contract-footer', undefined, hud.contract);
  hud.distance = element('span', 'objective-distance', '', contractFoot);
  hud.reward = element('strong', 'contract-reward', '', contractFoot);

  const mapPanel = element('section', 'map-panel', undefined, hud.root);
  const mapHeading = element('div', 'map-heading', undefined, mapPanel);
  element('span', 'map-north', 'N ↑', mapHeading);
  hud.location = element('strong', 'map-location', '', mapHeading);
  hud.map = element('canvas', 'minimap', undefined, mapPanel);
  hud.map.width = 544;
  hud.map.height = 380;
  hud.map.setAttribute('aria-label', 'City map: player, traffic, police and current objective');
  hud.context = hud.map.getContext('2d');
  const legend = element('div', 'map-legend', undefined, mapPanel);
  element('span', 'legend-player', 'YOU', legend);
  element('span', 'legend-objective', 'OBJECTIVE', legend);
  element('span', 'legend-police', 'POLICE', legend);

  hud.vehiclePanel = element('section', 'vehicle-panel', undefined, hud.root);
  hud.vehiclePanel.hidden = true;
  hud.vehicleName = element('span', 'vehicle-name', '', hud.vehiclePanel);
  const speedRow = element('div', 'speed-row', undefined, hud.vehiclePanel);
  hud.gear = element('strong', 'gear', '', speedRow);
  hud.speed = element('strong', 'speed-value', '', speedRow);
  element('span', 'speed-unit', 'KM/H', speedRow);
  hud.speedTrack = element('div', 'speed-track', undefined, hud.vehiclePanel);
  hud.speedFill = element('div', 'speed-fill', undefined, hud.speedTrack);

  hud.hints = element('div', 'control-hints', undefined, hud.root);
  hud.travelHints = element('span', 'travel-hints', '', hud.hints);
  hud.combatHints = element('span', 'combat-hints', 'F SHOOT · R RELOAD · RIGHT MOUSE AIM · SPACE PUNCH', hud.hints);
  hud.crosshair = element('div', 'crosshair', '', hud.root);
  hud.crosshair.hidden = true;
  hud.banner = element('section', 'mission-banner', undefined, hud.root);
  hud.banner.hidden = true;
  hud.banner.setAttribute('role', 'status');
  element('span', 'eyebrow', 'CONTRACT COMPLETE', hud.banner);
  hud.bannerTitle = element('strong', 'banner-title', '', hud.banner);
  hud.bannerReward = element('span', 'banner-reward', '', hud.banner);
  hud.toastNode = element('div', 'toast', '', hud.root);
  hud.toastNode.hidden = true;
  hud.toastNode.setAttribute('role', 'status');
  hud.damage = element('div', 'damage-flash', undefined, hudLayer);
  hud.damage.hidden = true;
  hud.clickHandler = (event) => {
    const button = event.target.closest('button[data-action]');
    if (button && screenLayer.contains(button)) hud.onAction?.(button.dataset.action);
  };
  screenLayer.addEventListener('click', hud.clickHandler);
  return hud;
}

export function showToast(hud, message, duration = 3) {
  if (typeof message !== 'string' || !message || !Number.isFinite(duration) || duration <= 0) return;
  hud.toast = { message, remaining: duration };
}

export function setDamageFlash(hud) {
  if (hud) hud.damageRemaining = 0.42;
}

export function updateHud(hud, { state, world, missions, dt = 0 }) {
  if (hud.disposed) return;
  const mission = getMissionView(missions, world);
  const reset = state.clockSeconds < hud.previousClock;
  if (reset) { hud.toast = null; hud.damageRemaining = 0; hud.previousWanted = 0; }
  const duration = !state.paused && !state.frozen && state.screen === 'playing' ? Math.max(0, dt) : 0;
  hud.damageRemaining = Math.max(0, hud.damageRemaining - duration);
  if (hud.toast) {
    hud.toast.remaining = Math.max(0, hud.toast.remaining - duration);
    if (hud.toast.remaining === 0) hud.toast = null;
  }
  const stars = Math.ceil(clamp(state.wanted, 0, 5));
  if (stars > hud.previousWanted) showToast(hud, `POLICE RESPONSE · ${stars} ${stars === 1 ? 'STAR' : 'STARS'}`, 3);
  else if (stars === 0 && hud.previousWanted > 0 && !state.dead) showToast(hud, 'PURSUIT CLEARED', 3);
  hud.previousWanted = stars;
  hud.previousClock = state.clockSeconds;
  hud.last = { state, world, missions, mission };

  const totalMinutes = Math.floor((17 * 3600 + 42 * 60 + state.clockSeconds) / 60);
  hud.clock.textContent = `${pad(Math.floor(totalMinutes / 60) % 24)}:${pad(totalMinutes % 60)}`;
  const date = new Date(Date.UTC(2018, 5, 18 + Math.floor(totalMinutes / 1440)));
  hud.date.textContent = `${['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][date.getUTCDay()]} · ${date.getUTCDate()} ${['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'][date.getUTCMonth()]}`;
  hud.stars.setAttribute('aria-label', `${stars} wanted stars`);
  hud.starNodes.forEach((node, index) => node.classList.toggle('active', index < stars));
  hud.pursuit.textContent = stars > 0 ? `POLICE PURSUIT${state.heat > 0 ? ` · HEAT ${Math.ceil(state.heat)}s` : ''}` : 'NO ACTIVE PURSUIT';
  hud.pursuit.classList.toggle('is-wanted', stars > 0);
  hud.money.textContent = cash(state.money);
  const earned = state.money - state.shiftStartMoney;
  hud.earnings.textContent = `${earned >= 0 ? '+' : '−'}${cash(Math.abs(earned))} THIS SHIFT`;
  hud.health.textContent = String(Math.ceil(Math.max(0, state.health)));
  hud.healthFill.style.width = `${clamp(state.health, 0, 100)}%`;
  hud.healthFill.classList.toggle('critical', state.health < 25);
  const onFoot = state.actor === 'foot';
  const armed = onFoot && Number.isFinite(state.ammo) && !state.dead;
  hud.ammoBox.hidden = !armed;
  hud.ammo.textContent = state.reloadRemaining > 0 ? `RELOAD ${state.reloadRemaining.toFixed(1)}s` : String(state.ammo).padStart(2, '0');
  hud.location.textContent = world.getLocation();
  hud.contractNumber.textContent = mission.number ?? '✓';
  hud.contractTitle.textContent = mission.title;
  hud.newContract.textContent = mission.newContract ? 'NEW CONTRACT' : mission.complete ? 'HARBORLINE COURIER' : 'ACTIVE CONTRACT';
  hud.newContract.classList.toggle('is-new', mission.newContract);
  hud.objective.textContent = mission.objective;
  hud.reward.hidden = mission.complete;
  hud.reward.textContent = mission.complete ? '' : `${cash(mission.reward)} REWARD`;
  const actorPosition = world.getActorPosition();
  const target = mission.objectivePosition;
  hud.distance.textContent = target ? `${Math.round(Math.hypot(actorPosition.x - target.x, actorPosition.z - target.z))} m · ${missions.index === 0 ? 'MARKED SEDAN' : missions.index === 1 ? 'PIER 04' : missions.index === 2 ? 'MEETING POINT' : 'SAFEHOUSE'}` : 'CITY FREE ROAM';
  const vehicle = world.getActiveVehicle();
  const driving = !onFoot && Boolean(vehicle);
  hud.vehiclePanel.hidden = !driving;
  // Hidden foot instruments are explicitly zeroed; no last-car speed leaks.
  const speed = driving ? Math.abs(vehicle.speed) * 3.6 : 0;
  hud.speed.textContent = String(Math.round(speed)).padStart(3, '0');
  hud.gear.textContent = driving && Math.abs(vehicle.speed) >= 0.1 ? vehicle.speed < 0 ? 'R' : 'D' : 'P';
  hud.vehicleName.textContent = driving ? vehicle.name : '';
  hud.speedFill.style.width = `${driving ? clamp(Math.abs(vehicle.speed) / vehicle.topSpeed * 100, 0, 100) : 0}%`;
  hud.travelHints.textContent = driving ? 'WASD DRIVE · SPACE HANDBRAKE · E EXIT · ESC PAUSE' : 'WASD MOVE · SHIFT RUN · E ENTER CAR · ESC PAUSE';
  hud.combatHints.hidden = !armed;
  hud.crosshair.hidden = !armed || !state.mouse?.aiming;
  hud.banner.hidden = !mission.banner;
  if (mission.banner) {
    hud.bannerTitle.textContent = mission.banner.title;
    hud.bannerReward.textContent = `+${cash(mission.banner.reward)} PAID`;
  }
  hud.toastNode.hidden = !hud.toast;
  if (hud.toast) hud.toastNode.textContent = hud.toast.message;
  hud.damage.hidden = hud.damageRemaining === 0 || state.screen !== 'playing';
  hud.damage.style.opacity = String(hud.damageRemaining / 0.42);
  if (hud.audioButton) hud.audioButton.textContent = `SOUND: ${world.audioEnabled ? 'ON' : 'OFF'}`;
}

function drawMap(hud) {
  if (!hud.context || !hud.last) return;
  const { world, mission } = hud.last;
  const ctx = hud.context;
  const width = hud.map.width, height = hud.map.height;
  const bounds = world.bounds;
  const margin = 15;
  const scale = Math.min((width - margin * 2) / (bounds.maxX - bounds.minX), (height - margin * 2) / (bounds.maxZ - bounds.minZ));
  const left = (width - (bounds.maxX - bounds.minX) * scale) / 2;
  const top = (height - (bounds.maxZ - bounds.minZ) * scale) / 2;
  const point = (position) => [left + (position.x - bounds.minX) * scale, top + (position.z - bounds.minZ) * scale];
  ctx.fillStyle = '#183e4a';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#344a4b';
  ctx.fillRect(left, top, (bounds.maxX - bounds.minX) * scale, (bounds.maxZ - bounds.minZ) * scale);
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, (bounds.maxX - bounds.minX) * scale, (bounds.maxZ - bounds.minZ) * scale);
  ctx.clip();
  ctx.fillStyle = '#748582';
  for (const road of world.roads) {
    const [x, y] = point(road);
    ctx.fillRect(x - road.width * scale / 2, y - road.length * scale / 2, road.width * scale, road.length * scale);
  }
  ctx.fillStyle = '#b2b7a4';
  for (const building of world.buildings) {
    const [x, y] = point(building);
    ctx.fillRect(x - building.width * scale / 2, y - building.depth * scale / 2, building.width * scale, building.depth * scale);
  }
  const dot = (position, color, radius) => {
    const [x, y] = point(position);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
  };
  for (const car of world.vehicles) if (car !== world.getActiveVehicle()) dot(car.position, '#e7e4cb', 2.7);
  for (const officer of world.police) {
    dot(officer.position, '#142c3b', 6.2);
    dot(officer.position, '#65c5ff', 4.1);
  }
  if (mission.objectivePosition) {
    const [x, y] = point(mission.objectivePosition);
    ctx.strokeStyle = '#ffcf72'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ffcf72';
    ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.fill();
  }
  const actor = world.getActiveVehicle() ?? world.player;
  const [x, y] = point(world.getActorPosition());
  ctx.save(); ctx.translate(x, y); ctx.rotate(-(actor.heading || 0));
  ctx.fillStyle = '#f5ffef'; ctx.strokeStyle = '#102d35'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, 9); ctx.lineTo(-6, -6); ctx.lineTo(0, -3); ctx.lineTo(6, -6); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore(); ctx.restore();
}

function menuButton(parent, label, action, primary = false) {
  const button = element('button', `menu-button${primary ? ' primary' : ''}`, label, parent);
  button.type = 'button'; button.dataset.action = action;
  return button;
}

export function setScreen(hud, screen, data = {}) {
  if (!hud || hud.disposed) return;
  hud.screen = screen;
  hud.screenData = { ...hud.screenData, ...data };
  hud.screenLayer.replaceChildren();
  hud.screenLayer.dataset.screen = screen;
  hud.screenLayer.hidden = screen === 'playing';
  hud.root.hidden = screen === 'title';
  hud.audioButton = null;
  hud.damage.hidden = true;
  if (screen === 'playing') {
    if (data.reset) { hud.previousWanted = 0; hud.previousClock = 0; }
    hud.toast = null; hud.toastNode.hidden = true;
    hud.damageRemaining = 0; hud.damage.hidden = true;
    hud.banner.hidden = true;
    return;
  }
  const shell = element('section', `menu-shell menu-${screen}`, undefined, hud.screenLayer);
  shell.setAttribute('aria-label', `${screen} menu`);
  const panel = element('div', 'menu-panel', undefined, shell);
  element('p', 'menu-kicker', 'HARBORLINE COURIER', panel);
  if (screen === 'title') {
    element('h1', 'game-title', 'NEON\nHARBOR', panel);
    element('p', 'menu-subtitle', 'THE FIRST SHIFT', panel);
    element('p', 'menu-copy', 'Rin Kade. One courier shift. Four jobs across a city on the edge of the bay.', panel);
    const profile = readCheckpoint();
    if (profile) element('p', 'profile-note', 'LOCAL PROFILE FOUND · START LOADS YOUR CHECKPOINT', panel);
    menuButton(panel, 'START', 'start', true);
    element('p', 'menu-controls', 'WASD / ARROWS Move or drive · MOUSE Look\nE Enter / exit · SHIFT Run · SPACE Handbrake / punch\nF Shoot · R Reload · RIGHT MOUSE Aim · ESC Pause', panel);
    element('p', 'menu-footnote', 'Progress saves locally every 5 seconds and after each contract.', panel);
  } else if (screen === 'pause') {
    element('h1', 'menu-title', 'SHIFT PAUSED', panel);
    element('p', 'menu-copy', 'Take a breath. The city can wait.', panel);
    menuButton(panel, 'RESUME', 'resume', true);
    menuButton(panel, 'RESTART FROM CHECKPOINT', 'restart');
    hud.audioButton = menuButton(panel, `SOUND: ${(hud.last?.world.audioEnabled ?? hud.screenData.audioEnabled ?? true) ? 'ON' : 'OFF'}`, 'mute');
    menuButton(panel, 'RETURN TO TITLE', 'title');
  } else if (screen === 'death') {
    element('h1', 'menu-title', 'SHIFT INTERRUPTED', panel);
    element('p', 'menu-copy', 'Rin is down. Respawn at Harborline with full health, or reload your last checkpoint.', panel);
    menuButton(panel, 'RESPAWN', 'respawn', true);
    menuButton(panel, 'RESTART FROM CHECKPOINT', 'restart');
  } else if (screen === 'victory') {
    element('h1', 'menu-title', 'FIRST SHIFT.\nFINISHED.', panel);
    element('p', 'menu-copy', 'Congratulations, Rin. Every contract delivered. The harbor is still yours to explore.', panel);
    const earnings = hud.last ? hud.last.state.money - hud.last.state.shiftStartMoney : data.shiftEarnings;
    if (Number.isFinite(earnings)) element('strong', 'victory-total', `${earnings >= 0 ? '+' : ''}${cash(earnings)} THIS SHIFT`, panel);
    menuButton(panel, 'KEEP EXPLORING', 'continue', true);
    menuButton(panel, 'RETURN TO TITLE', 'title');
  }
  if (!hud.screenshotMode) hud.screenLayer.querySelector('button')?.focus({ preventScroll: true });
}

export function renderHud(hud) {
  if (!hud || hud.disposed || hud.root.hidden) return;
  drawMap(hud);
}

export function disposeHud(hud) {
  if (!hud) return;
  hud.screenLayer.removeEventListener('click', hud.clickHandler);
  hud.screenLayer.replaceChildren();
  hud.root.remove(); hud.damage.remove();
  hud.last = null; hud.toast = null; hud.onAction = null; hud.disposed = true;
}
