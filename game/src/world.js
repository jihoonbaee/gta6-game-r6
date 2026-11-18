/* Neon Harbor — original city simulation, written from the R8 design brief.
 * Coordinates: Y is up; heading 0 faces +Z. All distances are world metres.
 * Integration: player.position, vehicles, pedestrians, police, buildings,
 * roads, locations, markedVehicle, objectivePosition, getActorPosition(),
 * getActiveVehicle(), getLocation(), speedKmh and gear are public HUD data.
 * Missions can setObjective(position) and call reportCrime(level, seconds).
 * The binding owns mission progression, money, menus, saves and pause.
 */

const T = globalThis.THREE;
const TAU = Math.PI * 2;
const LIMIT = { minX: -106, maxX: 106, minZ: -106, maxZ: 125 };
const ROAD_AXES = [-72, -24, 24, 72];
const MAGAZINE = 12;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const finite = (n, fallback) => Number.isFinite(n) ? n : fallback;
const headingTo = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
const vec = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);

export function createWorld({ canvas, screenshotMode = false } = {}) {
  if (!T) throw new Error('Load the local Three.js vendor before world.js.');
  const scene = new T.Scene();
  scene.background = new T.Color('#a7d8e5');
  scene.fog = new T.Fog('#b3d8df', 135, 355);
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.22;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  const world = {
    scene, renderer, canvas, screenshotMode,
    camera: new T.PerspectiveCamera(56, 16 / 9, 0.15, 650),
    vehicles: [], pedestrians: [], police: [], buildings: [], roads: [],
    bullets: [], particles: [], materials: new Map(), geometries: new Map(),
    textures: [], labels: [], elapsed: 0, state: null, events: [],
    cameraYaw: Math.PI, cameraPitch: 0.29, cameraReady: false,
    shootingCooldown: 0, meleeCooldown: 0, contactCooldown: 0,
    audioEnabled: true, audio: null, objectivePosition: null,
    locations: {
      spawn: vec(16, 0, 89), pier: vec(70, 0, 112),
      meeting: vec(-14, 0, -15), safehouse: vec(-88, 0, 113),
    },
    bounds: LIMIT,
  };
  world.locations.harbor = world.locations.pier;
  world.locations.tideline = world.locations.meeting;
  world.locations.safeHouse = world.locations.safehouse;
  world.syncPolice = syncPolice;
  world.clearTransientEffects = clearTransientEffects;
  world.setAudioEnabled = setAudioEnabled;
  world.resize = resize;
  world.getActorPosition = () => activeActor(world).position;
  world.getActiveVehicle = () => world.activeVehicle;
  world.getLocation = () => locationName(world.getActorPosition());
  world.setObjective = (position) => {
    world.objectivePosition = position ? vec(position.x, position.y || 0, position.z) : null;
  };
  world.reportCrime = (level, heat) => crime(world, level, heat);
  world.stageForScreenshot = (stage) => stageForScreenshot(world, stage);
  world.playSound = (kind) => sound(world, kind);
  Object.defineProperties(world, {
    activeVehicle: { get: () => world.vehicles.find((v) => v.id === world.vehicleId) || null },
    actorPosition: { get: () => world.getActorPosition() },
    speedKmh: { get: () => world.actor === 'vehicle' ? Math.round(Math.abs(world.activeVehicle?.speed || 0) * 3.6) : 0 },
    gear: { get: () => world.actor !== 'vehicle' || Math.abs(world.activeVehicle?.speed || 0) < 0.1 ? 'P' : world.activeVehicle.speed < 0 ? 'R' : 'D' },
    location: { get: () => world.getLocation() },
    vehicleName: { get: () => world.activeVehicle?.name || '' },
    markedCar: { get: () => world.markedVehicle },
  });
  buildCity(world);
  world.player = makePerson(world, '#ed743d', '#193a52', true);
  world.player.id = 'rin';
  world.scene.add(world.player.mesh);
  buildTraffic(world);
  buildPedestrians(world);
  world.objectiveMarker = makeBeacon(world, '#ffd16a');
  world.scene.add(world.objectiveMarker);
  resetWorld(world);
  resize(world);
  return world;
}

function material(w, color, options = {}) {
  const key = JSON.stringify([color, options]);
  if (!w.materials.has(key)) w.materials.set(key, new T.MeshStandardMaterial({ color, roughness: 0.78, ...options }));
  return w.materials.get(key);
}

function geometry(w, type, args) {
  const key = `${type}:${args.join(',')}`;
  if (!w.geometries.has(key)) w.geometries.set(key, new T[type](...args));
  return w.geometries.get(key);
}

function box(w, parent, x, y, z, sx, sy, sz, color, options = {}) {
  const mesh = new T.Mesh(geometry(w, 'BoxGeometry', [sx, sy, sz]), material(w, color, options));
  mesh.position.set(x, y, z);
  mesh.castShadow = sy > 0.25;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinder(w, parent, x, y, z, radius, height, color, sides = 10) {
  const mesh = new T.Mesh(geometry(w, 'CylinderGeometry', [radius, radius, height, sides]), material(w, color));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function label(w, text, width, height, background = '#173b4a', foreground = '#ffe0a0') {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 768, 128);
  ctx.strokeStyle = foreground;
  ctx.lineWidth = 5;
  ctx.strokeRect(8, 8, 752, 112);
  ctx.fillStyle = foreground;
  ctx.font = 'bold 56px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 384, 66, 730);
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace;
  w.textures.push(texture);
  const mat = new T.MeshBasicMaterial({ map: texture, side: T.DoubleSide });
  w.labels.push(mat);
  return new T.Mesh(geometry(w, 'PlaneGeometry', [width, height]), mat);
}

function sign(w, text, x, y, z, width = 14, yaw = 0) {
  const mesh = label(w, text, width, width / 6);
  mesh.position.set(x, y, z);
  mesh.rotation.y = yaw;
  w.scene.add(mesh);
  return mesh;
}

function buildCity(w) {
  w.scene.add(new T.HemisphereLight('#d6f3ff', '#b18b68', 1.8));
  const sun = new T.DirectionalLight('#ffe3af', 3.1);
  sun.position.set(-65, 115, 50);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, near: 1, far: 320 });
  sun.shadow.normalBias = 0.04;
  sun.shadow.bias = -0.0002;
  sun.shadow.radius = 3;
  w.scene.add(sun);
  box(w, w.scene, 0, -0.65, 9, 220, 1, 238, '#b8c2af');
  w.water = box(w, w.scene, 0, -0.66, 210, 620, 0.25, 160, '#239eaf', { metalness: 0.65, roughness: 0.23 });
  box(w, w.scene, 190, -0.65, 10, 160, 0.2, 420, '#299bab', { metalness: 0.55, roughness: 0.28 });
  for (let i = 0; i < 32; i++) {
    box(w, w.scene, -170 + (i * 31) % 390, -0.49, 140 + (i * 17) % 130, 10 + i % 4, 0.02, 0.12, '#83d5d5', { transparent: true, opacity: 0.5 });
  }
  for (const axis of ROAD_AXES) {
    addRoad(w, axis, 7, 13, 230, 'vertical');
    addRoad(w, 0, axis, 216, 13, 'horizontal');
  }
  addRoad(w, 0, 96, 216, 13, 'horizontal');
  // Raised pavements frame each block, with open, level road crossings.
  for (let ix = 0; ix < 3; ix++) for (let iz = 0; iz < 3; iz++) {
    const x = -48 + ix * 48;
    const z = -48 + iz * 48;
    box(w, w.scene, x, -0.03, z, 34, 0.32, 34, '#d9d4c5');
    const north = z < -30;
    if (north) {
      addBuilding(w, x - 8, z, 11, 20, 8 + ix * 3, ['#eab997', '#c6dac8', '#f1d7b0'][ix]);
      addBuilding(w, x + 8, z, 11, 20, 11 + iz, '#ded1b8');
    } else {
      addBuilding(w, x, z, 23 + ix * 2, 23, 22 + ((ix * 13 + iz * 17) % 45), ['#568a9a', '#97b3b5', '#547480'][ix]);
    }
    for (const side of [-1, 1]) {
      tree(w, x + side * 14, z + 14, north);
      bench(w, x + side * 11, z - 15);
    }
  }
  // Buildings on the outside edges leave the inner street network legible.
  for (let i = 0; i < 5; i++) {
    addBuilding(w, -94, -85 + i * 32, 17, 23, 12 + i * 6, '#d2bca5');
    addBuilding(w, 94, -85 + i * 32, 16, 22, 17 + (i % 3) * 14, '#8caab1');
    addBuilding(w, -80 + i * 39, -95, 25, 14, 9 + i * 2, '#e3c8b0');
  }
  // Port apron, warehouses, stacks and a quay extending over the water.
  box(w, w.scene, 0, -0.05, 113, 216, 0.6, 29, '#b8bbb4');
  addBuilding(w, -88, 114, 24, 16, 8, '#486b70');
  addBuilding(w, -39, 113, 27, 16, 10, '#c4a778');
  sign(w, 'THE SAFEHOUSE', -88, 5.5, 105.85, 18, Math.PI);
  sign(w, 'HARBORLINE COURIER', -39, 6, 104.85, 22, Math.PI);
  box(w, w.scene, 70, -0.04, 141, 26, 0.6, 29, '#abb8b6');
  // The pier end is decorative; a continuous rail keeps actors in the map.
  for (let x = -105; x <= 105; x += 7) {
    cylinder(w, w.scene, x, 0.9, 126, 0.09, 1.8, '#526d77');
    box(w, w.scene, x + 3.5, 1.5, 126, 7, 0.1, 0.1, '#e1dcc2');
    box(w, w.scene, x + 3.5, 0.8, 126, 7, 0.1, 0.1, '#526d77');
  }
  for (let i = 0; i < 8; i++) {
    const x = -8 + (i % 4) * 14;
    const z = 108 + Math.floor(i / 4) * 10;
    const color = ['#d47745', '#4d8c99', '#d0ad5a', '#668785'][i % 4];
    box(w, w.scene, x, 1.6, z, 11, 3.2, 6, color);
    for (let j = -4; j <= 4; j += 1.5) box(w, w.scene, x + j, 1.6, z - 3.05, 0.1, 3, 0.12, '#3e6268');
  }
  sign(w, 'PIER 04', 73, 6.5, 124, 17, Math.PI);
  sign(w, 'TIDELINE AVENUE', -9, 8, 31, 24, Math.PI);
  for (const x of [-104, 104]) {
    for (let z = -102; z < 124; z += 8) box(w, w.scene, x, 0.8, z, 0.4, 1.6, 7.8, '#647d7a');
  }
  box(w, w.scene, 0, 0.65, -107, 215, 1.3, 0.5, '#6c8581');
  for (const x of [-80, -32, 32, 80]) for (const z of [-78, -30, 30, 78, 102]) {
    streetlight(w, x, z);
    if (z < 100) tree(w, x + 3, z + 6, false);
  }
  for (let i = 0; i < 8; i++) {
    cylinder(w, w.scene, -31 + (i % 4) * 48, 0.55, -34 + Math.floor(i / 4) * 96, 0.23, 1.1, '#c55d46');
  }
  for (const x of [-25, 23, 71]) {
    for (let stripe = -4; stripe <= 4; stripe += 2) {
      box(w, w.scene, x + stripe, 0.025, 82, 0.85, 0.025, 4, '#f5e9ce');
    }
  }
  for (let i = 0; i < 3; i++) {
    const boat = new T.Group();
    box(w, boat, 0, 0.25, 0, 4.4, 1.1, 11, '#e6e6d8');
    box(w, boat, 0, 1.3, -1, 3.3, 1.4, 4.1, '#4e8393');
    box(w, boat, 0, 2.1, -1, 3.8, 0.2, 4.8, '#f3d7a0');
    cylinder(w, boat, 0, 3.5, -1, 0.08, 3, '#ebd9af');
    boat.position.set(91 + i * 15, 0, 148 + i * 9);
    boat.rotation.y = -0.3;
    w.scene.add(boat);
  }
  // Port cranes form a recognizable skyline without exterior assets.
  for (const x of [48, 95]) {
    box(w, w.scene, x, 12, 143, 2, 24, 2, '#d8a256');
    box(w, w.scene, x - 9, 24, 143, 24, 1.6, 1.6, '#dfac5d');
    cylinder(w, w.scene, x - 18, 18, 143, 0.07, 12, '#53666a');
  }
}

function addRoad(w, x, z, width, length, direction) {
  w.roads.push({ x, z, width, height: length, length, direction });
  box(w, w.scene, x, -0.08, z, width, 0.12, length, '#45545b');
  const vertical = direction === 'vertical';
  const extent = vertical ? length : width;
  for (let p = -extent / 2 + 4; p < extent / 2; p += 8) {
    const px = vertical ? x : x + p;
    const pz = vertical ? z + p : z;
    if (ROAD_AXES.some((a) => Math.abs((vertical ? pz : px) - a) < 9)) continue;
    box(w, w.scene, px, 0.015, pz, vertical ? 0.16 : 3.8, 0.02, vertical ? 3.8 : 0.16, '#ecce83');
  }
}

function addBuilding(w, x, z, width, depth, height, color) {
  const body = box(w, w.scene, x, height / 2, z, width, height, depth, color);
  w.buildings.push({ x, z, width, depth, height, minX: x - width / 2, maxX: x + width / 2, minZ: z - depth / 2, maxZ: z + depth / 2, mesh: body });
  box(w, w.scene, x, height + 0.25, z, width + 0.6, 0.5, depth + 0.6, '#d1d6cb');
  box(w, w.scene, x + width * 0.2, height + 0.9, z, 3, 1.2, 3, '#637b80');
  const pane = material(w, '#c4e7dc', { emissive: '#a7ccb9', emissiveIntensity: 0.24, metalness: 0.35, roughness: 0.24 });
  // Instance windows to keep the entire city inexpensive to draw.
  const cols = Math.max(1, Math.floor((width - 2) / 3.6));
  const rows = Math.max(1, Math.floor((height - 3) / 3.5));
  const windows = new T.InstancedMesh(geometry(w, 'BoxGeometry', [1.7, 1.5, 0.12]), pane, cols * rows * 2);
  const matrix = new T.Matrix4();
  let index = 0;
  for (const side of [-1, 1]) for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    matrix.makeTranslation(x + (c - (cols - 1) / 2) * 3.6, 3 + r * 3.5, z + side * (depth / 2 + 0.08));
    windows.setMatrixAt(index++, matrix);
  }
  w.scene.add(windows);
  box(w, w.scene, x, 1.3, z + depth / 2 + 0.1, 2, 2.6, 0.18, '#284855');
}

function tree(w, x, z, residential) {
  cylinder(w, w.scene, x, 1.65, z, 0.22, 3.3, '#92795a');
  const crown = new T.Mesh(geometry(w, 'IcosahedronGeometry', [residential ? 2.2 : 2.7, 1]), material(w, residential ? '#79a56f' : '#558d73'));
  crown.position.set(x, 4.4, z);
  crown.scale.y = residential ? 1.2 : 0.7;
  crown.castShadow = true;
  w.scene.add(crown);
}

function bench(w, x, z) {
  box(w, w.scene, x, 0.65, z, 2.6, 0.2, 0.7, '#a57b52');
  box(w, w.scene, x, 1.1, z + 0.4, 2.6, 0.75, 0.12, '#a57b52');
  for (const dx of [-1, 1]) box(w, w.scene, x + dx, 0.3, z, 0.12, 0.6, 0.6, '#38525c');
}

function streetlight(w, x, z) {
  cylinder(w, w.scene, x, 4, z, 0.09, 8, '#3d5964');
  box(w, w.scene, x + 0.9, 7.9, z, 2, 0.12, 0.12, '#3d5964');
  box(w, w.scene, x + 1.8, 7.8, z, 0.8, 0.13, 0.5, '#ffe6a3', { emissive: '#ffcf83', emissiveIntensity: 1 });
}

function makePerson(w, shirt, trousers, protagonist = false) {
  const mesh = new T.Group();
  const torso = box(w, mesh, 0, 1.12, 0, 0.6, 0.67, 0.35, shirt);
  box(w, mesh, 0, 1.67, 0, 0.36, 0.4, 0.36, '#c79876');
  box(w, mesh, 0, 1.9, -0.02, 0.4, 0.12, 0.4, '#283a40');
  const legs = [];
  const arms = [];
  for (const side of [-1, 1]) {
    const leg = new T.Group();
    leg.position.set(side * 0.17, 0.83, 0);
    box(w, leg, 0, -0.36, 0, 0.23, 0.72, 0.25, trousers);
    box(w, leg, 0, -0.73, 0.07, 0.26, 0.15, 0.4, '#23333d');
    mesh.add(leg);
    legs.push(leg);
    const arm = new T.Group();
    arm.position.set(side * 0.4, 1.37, 0);
    box(w, arm, 0, -0.24, 0, 0.19, 0.5, 0.23, shirt);
    box(w, arm, 0, -0.54, 0, 0.16, 0.2, 0.18, '#c79876');
    mesh.add(arm);
    arms.push(arm);
  }
  if (protagonist) {
    box(w, mesh, 0, 1.08, -0.27, 0.52, 0.55, 0.24, '#dbc995');
    box(w, mesh, 0.43, 0.85, 0.25, 0.13, 0.16, 0.4, '#314751');
  }
  return { mesh, position: mesh.position, heading: 0, radius: 0.42, legs, arms, torso, alive: true, fallRemaining: 0, phase: 0 };
}

const MODELS = [
  { name: 'Solaris Vela', width: 1.9, length: 4.5, topSpeed: 28, acceleration: 9 },
  { name: 'Kite Runabout', width: 1.7, length: 3.6, topSpeed: 24, acceleration: 10 },
  { name: 'Meridian GT', width: 1.95, length: 4.4, topSpeed: 37, acceleration: 13 },
  { name: 'Dockhand', width: 2.1, length: 5.3, topSpeed: 19, acceleration: 6.5 },
];

function makeVehicle(w, id, modelIndex, color, police = false) {
  const model = MODELS[modelIndex];
  const mesh = new T.Group();
  const bodyColor = police ? '#f4f2df' : color;
  box(w, mesh, 0, 0.74, 0, model.width, 0.64, model.length, bodyColor, { metalness: 0.4, roughness: 0.28 });
  box(w, mesh, 0, 1.12, -0.15, model.width * 0.86, 0.5, model.length * 0.51, police ? '#22343e' : bodyColor, { metalness: 0.4, roughness: 0.3 });
  box(w, mesh, 0, 1.43, -0.2, model.width * 0.79, 0.14, model.length * 0.38, police ? '#f2eddb' : bodyColor);
  const glass = { metalness: 0.55, roughness: 0.16 };
  box(w, mesh, 0, 1.25, model.length * 0.22, model.width * 0.76, 0.39, 0.07, '#75b7c7', glass);
  box(w, mesh, 0, 1.24, -model.length * 0.28, model.width * 0.76, 0.32, 0.07, '#75b7c7', glass);
  for (const side of [-1, 1]) {
    box(w, mesh, side * (model.width / 2 + 0.02), 1.23, -0.15, 0.04, 0.3, model.length * 0.4, '#6fa4b5', glass);
    box(w, mesh, side * model.width * 0.34, 0.8, model.length / 2 + 0.015, 0.42, 0.18, 0.08, '#fff4cc', { emissive: '#ffe5a0', emissiveIntensity: 0.6 });
    box(w, mesh, side * model.width * 0.34, 0.8, -model.length / 2 - 0.015, 0.42, 0.18, 0.08, '#dd5d4a', { emissive: '#c53124', emissiveIntensity: 0.5 });
  }
  const wheels = [];
  for (const x of [-model.width / 2, model.width / 2]) for (const z of [-model.length * 0.32, model.length * 0.32]) {
    const wheel = cylinder(w, mesh, x, 0.4, z, 0.39, 0.22, '#26343c', 12);
    wheel.rotation.z = Math.PI / 2;
    wheels.push(wheel);
  }
  const sirens = [];
  if (modelIndex === 3 && !police) box(w, mesh, 0, 1.2, -1.35, 1.8, 0.65, 1.8, '#aeaa91');
  if (police) {
    box(w, mesh, 0, 1.58, -0.1, 1.5, 0.12, 0.4, '#243b47');
    for (const side of [-1, 1]) sirens.push(box(w, mesh, side * 0.48, 1.73, -0.1, 0.55, 0.22, 0.35, side < 0 ? '#e84b4b' : '#49a5ff', { emissive: side < 0 ? '#ff1818' : '#157fff', emissiveIntensity: 1.8 }));
    for (const side of [-1, 1]) {
      const decal = label(w, 'NEON HARBOR POLICE', 3, 0.5, '#142936', '#f3e5b8');
      decal.position.set(side * (model.width / 2 + 0.05), 0.87, 0);
      decal.rotation.y = side * Math.PI / 2;
      mesh.add(decal);
    }
  }
  w.scene.add(mesh);
  return { ...model, id, modelIndex, color, mesh, position: mesh.position, heading: 0, speed: 0, health: 100, police, sirens, wheels, stolen: false, ai: !police, stopRemaining: 0, waypoint: 0, route: [], smokeRemaining: 0, stuckTime: 0 };
}

function buildTraffic(w) {
  const colors = ['#ebbd61', '#d16d54', '#63aeb8', '#e9d9bb', '#637e94', '#a3ad7b'];
  for (let i = 0; i < 12; i++) {
    const v = makeVehicle(w, `traffic-${i}`, i === 0 ? 0 : i % 4, colors[i % colors.length]);
    const left = [-76, -28, -76, -28][i % 4];
    const right = [20, 68, 68, 20][i % 4];
    const top = [-76, -28, -76, -28][i % 4];
    const bottom = i === 0 ? 92 : [76, 76, 28, 76][i % 4];
    v.route = [vec(right, 0, bottom), vec(right, 0, top), vec(left, 0, top), vec(left, 0, bottom)];
    const leg = Math.floor(i / 4) % 4;
    v.position.copy(v.route[leg]).lerp(v.route[(leg + 1) % 4], i === 0 ? 3 / (bottom - top) : 0.12 + (i % 4) * 0.19);
    v.waypoint = (leg + 1) % 4;
    v.heading = headingTo(v.position, v.route[v.waypoint]);
    v.cruiseSpeed = 6 + (i % 4) * 1.15;
    v.stopRemaining = i === 0 ? 9 : i * 0.15;
    v.mesh.rotation.y = v.heading;
    v.initial = { position: v.position.clone(), heading: v.heading, waypoint: v.waypoint, stopRemaining: v.stopRemaining };
    w.vehicles.push(v);
  }
  w.markedVehicle = w.vehicles[0];
  w.markedVehicle.marked = true;
  w.markedVehicle.marker = makeBeacon(w, '#ffcf62');
  w.markedVehicle.mesh.add(w.markedVehicle.marker);
}

function makeBeacon(w, color) {
  const group = new T.Group();
  const diamond = new T.Mesh(geometry(w, 'OctahedronGeometry', [0.72, 0]), material(w, color, { emissive: color, emissiveIntensity: 0.65, transparent: true, opacity: 0.9 }));
  diamond.position.y = 4.4;
  group.add(diamond);
  const ring = new T.Mesh(geometry(w, 'TorusGeometry', [1.7, 0.08, 6, 32]), material(w, color, { emissive: color, emissiveIntensity: 0.5 }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.15;
  group.add(ring);
  return group;
}

function buildPedestrians(w) {
  const shirts = ['#ee976c', '#79b8bb', '#e8d7b5', '#a28ba5', '#6d9d86'];
  for (let i = 0; i < 20; i++) {
    const p = makePerson(w, shirts[i % 5], i % 2 ? '#3f5267' : '#655e55');
    const row = Math.floor(i / 5);
    const x = -82 + (i % 5) * 39;
    const z = [-81, -33, 33, 81][row];
    p.id = `pedestrian-${i}`;
    p.start = vec(x, 0.15, z);
    p.end = vec(clamp(x + (i % 2 ? -20 : 20), -95, 95), 0.15, z);
    p.position.copy(p.start);
    p.heading = headingTo(p.start, p.end);
    p.walkSpeed = 0.9 + (i % 4) * 0.15;
    p.direction = 1;
    p.initialHeading = p.heading;
    w.pedestrians.push(p);
    w.scene.add(p.mesh);
  }
}

function activeActor(w) {
  return w.actor === 'vehicle' && w.activeVehicle ? w.activeVehicle : w.player;
}

function locationName(position) {
  if (position.z > 79) return 'Pier 04 · Harbor District';
  if (position.z < -38) return 'Northside Residences';
  return 'Tideline Avenue';
}

// SAT: the full rotated car rectangle is tested against each building AABB.
function rectangleOverlap(a, b, padding = 0) {
  const ax = Math.sin(a.heading || 0);
  const az = Math.cos(a.heading || 0);
  const rx = az;
  const rz = -ax;
  const halfW = a.width / 2 + padding;
  const halfL = a.length / 2 + padding;
  const dx = b.x - a.position.x;
  const dz = b.z - a.position.z;
  const bw = b.width / 2;
  const bl = b.depth / 2;
  return Math.abs(dx) < Math.abs(rx) * halfW + Math.abs(ax) * halfL + bw &&
    Math.abs(dz) < Math.abs(rz) * halfW + Math.abs(az) * halfL + bl &&
    Math.abs(dx * rx + dz * rz) < halfW + bw * Math.abs(rx) + bl * Math.abs(rz) &&
    Math.abs(dx * ax + dz * az) < halfL + bw * Math.abs(ax) + bl * Math.abs(az);
}

function blocked(w, position, width = 0.84, length = width, heading = 0) {
  const sin = Math.sin(heading), cos = Math.cos(heading);
  const ex = Math.abs(cos) * width / 2 + Math.abs(sin) * length / 2;
  const ez = Math.abs(sin) * width / 2 + Math.abs(cos) * length / 2;
  if (position.x - ex < LIMIT.minX || position.x + ex > LIMIT.maxX || position.z - ez < LIMIT.minZ || position.z + ez > LIMIT.maxZ) return true;
  return w.buildings.some((b) => rectangleOverlap({ position, width, length, heading }, b, 0.12));
}

function carsOverlap(a, b, padding = 0.1) {
  // Four separating axes cover both rotated bodies, including long trucks.
  const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
  for (const yaw of [a.heading, b.heading]) {
    for (const axis of [vec(Math.sin(yaw), 0, Math.cos(yaw)), vec(Math.cos(yaw), 0, -Math.sin(yaw))]) {
      const extent = (v) => Math.abs(axis.x * Math.sin(v.heading) + axis.z * Math.cos(v.heading)) * v.length / 2 + Math.abs(axis.x * Math.cos(v.heading) - axis.z * Math.sin(v.heading)) * v.width / 2;
      if (Math.abs(dx * axis.x + dz * axis.z) >= extent(a) + extent(b) + padding) return false;
    }
  }
  return true;
}

function safeFootPosition(w, origin, yaw) {
  for (let radius = 1.8; radius < 14; radius += 0.8) {
    for (const offset of [Math.PI / 2, -Math.PI / 2, Math.PI, 0, Math.PI / 4, -Math.PI / 4, 3 * Math.PI / 4, -3 * Math.PI / 4]) {
      const p = vec(origin.x + Math.sin(yaw + offset) * radius, 0, origin.z + Math.cos(yaw + offset) * radius);
      if (blocked(w, p)) continue;
      const body = { position: p, width: 0.9, length: 0.9, heading: yaw };
      if (![...w.vehicles, ...w.police].some((v) => carsOverlap(body, v, 0.2))) return p;
    }
  }
  return w.locations.spawn.clone();
}

function rememberSafe(w) {
  const a = activeActor(w);
  w.lastSafe = { id: a.id, position: a.position.clone(), heading: a.heading };
}

function switchActor(w, vehicle = null, emit = true) {
  if (vehicle) {
    w.actor = 'vehicle';
    w.vehicleId = vehicle.id;
    vehicle.ai = false;
    w.player.mesh.visible = false;
  } else {
    const old = w.activeVehicle;
    if (old) {
      w.player.position.copy(safeFootPosition(w, old.position, old.heading));
      w.player.heading = old.heading;
    }
    w.actor = 'foot';
    w.vehicleId = null;
    w.player.mesh.visible = true;
  }
  if (w.state) {
    w.state.actor = w.actor;
    w.state.vehicleId = w.vehicleId;
  }
  rememberSafe(w); // Always AFTER the active body has changed.
  if (emit) w.events.push({ type: 'actor', actor: w.actor, vehicleId: w.vehicleId });
}

function interact(w) {
  ensureAudio(w);
  if (w.actor === 'vehicle') { switchActor(w); return; }
  const nearest = w.vehicles.filter((v) => distance(v.position, w.player.position) < 4.4).sort((a, b) => distance(a.position, w.player.position) - distance(b.position, w.player.position))[0];
  if (!nearest) return;
  if (!nearest.stolen) {
    nearest.stolen = true;
    crime(w, 1, 15);
  }
  switchActor(w, nearest);
}

function crime(w, level, heat) {
  const event = { type: 'crime', level: clamp(finite(level, 0), 0, 5), heat: Math.max(0, finite(heat, 0)) };
  if (w.state) {
    w.state.wanted = Math.max(w.state.wanted, event.level);
    w.state.heat = Math.max(w.state.heat, event.heat);
  }
  w.events.push(event);
}

function damage(w, amount, source = 'impact') {
  if (!(amount > 0)) return;
  w.frameDamage += amount;
  w.damageSource = source;
  sparks(w, activeActor(w).position, '#ffb763', 5);
}

function moveFoot(w, dt, input) {
  const p = w.player;
  const forward = Number(Boolean(input.forward)) - Number(Boolean(input.backward));
  const sideways = Number(Boolean(input.right)) - Number(Boolean(input.left));
  const speed = input.run ? 7.5 : input.aiming ? 2.2 : 4;
  const yaw = w.cameraYaw;
  const move = vec(Math.sin(yaw) * forward - Math.cos(yaw) * sideways, 0, Math.cos(yaw) * forward + Math.sin(yaw) * sideways);
  if (move.lengthSq() > 0) {
    move.normalize().multiplyScalar(speed * dt);
    p.heading = input.aiming ? yaw : Math.atan2(move.x, move.z);
    // Sliding is resolved on each axis; the saved position belongs to this actor.
    const next = p.position.clone();
    next.x += move.x;
    const occupied = (position) => blocked(w, position) || [...w.vehicles, ...w.police].some((v) => carsOverlap({ position, width: 0.8, length: 0.8, heading: p.heading }, v));
    if (!occupied(next)) p.position.x = next.x;
    next.copy(p.position); next.z += move.z;
    if (!occupied(next)) p.position.z = next.z;
    p.phase += dt * (input.run ? 13 : 8);
  }
  animatePerson(p, move.lengthSq() > 0 ? Math.sin(p.phase) * 0.65 : 0);
  p.mesh.rotation.y = p.heading;
  rememberSafe(w);
}

function animatePerson(p, swing) {
  p.legs[0].rotation.x = swing;
  p.legs[1].rotation.x = -swing;
  p.arms[0].rotation.x = -swing * 0.7;
  p.arms[1].rotation.x = swing * 0.7;
}

function moveVehicle(w, v, dt, input) {
  const throttle = Number(Boolean(input.forward)) - Number(Boolean(input.backward));
  if (throttle) {
    const braking = v.speed * throttle < -0.3;
    v.speed += throttle * (braking ? 19 : v.acceleration) * dt;
  } else v.speed *= Math.exp(-0.65 * dt);
  if (input.handbrake) v.speed *= Math.exp(-5.5 * dt);
  v.speed = clamp(v.speed, -v.topSpeed * 0.36, v.topSpeed);
  const steer = Number(Boolean(input.left)) - Number(Boolean(input.right));
  const yaw = v.heading + steer * clamp(v.speed / 8, -1, 1) * (input.handbrake ? 2.5 : 1.6) * dt;
  const impact = tryVehicleMove(w, v, dt, yaw, true);
  if (impact > 0) damage(w, Math.max(0, impact - 5) * 2.1, 'collision');
  rememberSafe(w);
}

function tryVehicleMove(w, v, dt, heading, playerControlled = false, police = false) {
  const old = v.position.clone();
  const oldYaw = v.heading;
  const impact = Math.abs(v.speed);
  const steps = Math.max(1, Math.ceil(impact * dt / 0.45));
  for (let s = 0; s < steps; s++) {
    const fraction = (s + 1) / steps;
    v.heading = oldYaw + angleDelta(heading, oldYaw) * fraction;
    v.position.x += Math.sin(v.heading) * v.speed * dt / steps;
    v.position.z += Math.cos(v.heading) * v.speed * dt / steps;
    if (blocked(w, v.position, v.width, v.length, v.heading)) {
      const safe = playerControlled && w.lastSafe?.id === v.id ? w.lastSafe : null;
      v.position.copy(safe ? safe.position : old);
      v.heading = safe ? safe.heading : oldYaw;
      v.mesh.rotation.y = v.heading;
      v.speed = 0;
      if (impact > 3) { sparks(w, v.position, '#ffd795', 8); sound(w, 'impact'); }
      return impact;
    }
    // Police have their own contact response, separate from traffic following.
    const hit = w.vehicles.find((other) => other !== v && carsOverlap(v, other));
    const footHit = w.actor === 'foot' && carsOverlap(v, { position: w.player.position, width: 0.8, length: 0.8, heading: w.player.heading });
    if (hit || footHit) {
      v.position.copy(old);
      v.heading = oldYaw;
      if (hit) {
        if (police && hit === w.activeVehicle) {
          hit.speed *= 0.85;
          const push = hit.position.clone().sub(v.position).normalize().multiplyScalar(0.24);
          const next = hit.position.clone().add(push);
          if (!blocked(w, next, hit.width, hit.length, hit.heading) && !w.vehicles.some((other) => other !== hit && other !== v && carsOverlap({ ...hit, position: next }, other))) hit.position.copy(next);
          if (w.contactCooldown <= 0) { damage(w, 5, 'police'); w.contactCooldown = 0.8; }
        } else if (playerControlled) {
          hit.speed *= 0.55;
          hit.health = Math.max(0, hit.health - impact);
        }
      }
      if (footHit && w.contactCooldown <= 0 && impact > 1) {
        damage(w, police ? 5 : 12, police ? 'police' : 'traffic');
        w.contactCooldown = 1;
      }
      v.speed = 0;
      if (playerControlled && impact > 4) { sparks(w, v.position, '#ffd795', 6); return impact * 0.5; }
      return 0;
    }
    // Traffic does not pass through patrol cars either.
    if (w.police.some((other) => other !== v && carsOverlap(v, other))) {
      v.position.copy(old); v.heading = oldYaw; v.speed = 0;
      return 0;
    }
  }
  v.mesh.rotation.y = v.heading;
  return 0;
}

function updateTraffic(w, dt) {
  for (const v of w.vehicles) {
    if (v === w.activeVehicle) continue;
    if (!v.ai) {
      v.speed *= Math.exp(-0.8 * dt);
      if (Math.abs(v.speed) > 0.05) tryVehicleMove(w, v, dt, v.heading);
      else v.speed = 0;
      continue;
    }
    if (v.stopRemaining > 0) { v.stopRemaining -= dt; v.speed = 0; continue; }
    const target = v.route[v.waypoint];
    if (distance(v.position, target) < 1.1) {
      v.waypoint = (v.waypoint + 1) % v.route.length;
      v.stopRemaining = 0.6 + (Number(v.id.split('-')[1]) % 3) * 0.2;
      v.speed = 0;
      continue;
    }
    const desired = headingTo(v.position, target);
    const yaw = v.heading + clamp(angleDelta(desired, v.heading), -2.2 * dt, 2.2 * dt);
    const cruise = Math.min(v.cruiseSpeed, distance(v.position, target) * 1.5);
    v.speed = Math.min(cruise, v.speed + 4 * dt);
    // Look ahead before contact, leaving visible space between bumpers.
    const lookAhead = { ...v, position: v.position.clone().add(vec(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(2 + v.speed * 0.35)), heading: yaw };
    if (w.vehicles.some((other) => other !== v && carsOverlap(lookAhead, other, 0.35))) v.speed = Math.max(0, v.speed - 16 * dt);
    tryVehicleMove(w, v, dt, yaw);
  }
}

function knockDown(w, p, shot = false) {
  if (!p.alive) return;
  p.alive = false;
  p.fallRemaining = 0.75;
  if (shot) crime(w, 4, 150);
  else crime(w, 3, 140);
  sparks(w, p.position, '#dfb58d', 5);
}

function updatePedestrians(w, dt) {
  for (const p of w.pedestrians) {
    if (!p.alive) {
      p.fallRemaining = Math.max(0, p.fallRemaining - dt);
      p.mesh.rotation.z = (1 - p.fallRemaining / 0.75) * Math.PI / 2;
      if (p.fallRemaining === 0) p.mesh.visible = false;
      continue;
    }
    const target = p.direction > 0 ? p.end : p.start;
    if (distance(p.position, target) < 0.25) p.direction *= -1;
    const goal = p.direction > 0 ? p.end : p.start;
    p.heading = headingTo(p.position, goal);
    const next = p.position.clone().add(vec(Math.sin(p.heading), 0, Math.cos(p.heading)).multiplyScalar(p.walkSpeed * dt));
    if (!blocked(w, next, 0.6)) p.position.copy(next);
    else p.direction *= -1;
    p.phase += dt * 7;
    animatePerson(p, Math.sin(p.phase) * 0.5);
    p.mesh.rotation.y = p.heading;
    const car = w.activeVehicle;
    if (car && Math.abs(car.speed) > 2 && carsOverlap(car, { position: p.position, width: 0.7, length: 0.7, heading: 0 })) {
      knockDown(w, p);
      car.speed *= 0.7;
      damage(w, 12, 'pedestrian collision');
      sound(w, 'impact');
    }
  }
}

// Segment slab intersection returns the FIRST obstruction along a bullet.
function segmentBox(a, b, minX, maxX, minZ, maxZ) {
  let near = 0, far = 1;
  for (const [start, delta, min, max] of [[a.x, b.x - a.x, minX, maxX], [a.z, b.z - a.z, minZ, maxZ]]) {
    if (Math.abs(delta) < 1e-9) { if (start < min || start > max) return null; continue; }
    let t1 = (min - start) / delta, t2 = (max - start) / delta;
    if (t1 > t2) [t1, t2] = [t2, t1];
    near = Math.max(near, t1); far = Math.min(far, t2);
    if (near > far) return null;
  }
  return near;
}

function segmentPerson(a, b, p, radius = 0.55) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const ox = a.x - p.x, oz = a.z - p.z;
  const lengthSq = dx * dx + dz * dz;
  if (!lengthSq) return Math.hypot(ox, oz) <= radius ? 0 : null;
  const projection = -(ox * dx + oz * dz) / lengthSq;
  const discriminant = projection * projection - (ox * ox + oz * oz - radius * radius) / lengthSq;
  if (discriminant < 0) return null;
  const entry = projection - Math.sqrt(discriminant);
  const exit = projection + Math.sqrt(discriminant);
  return exit < 0 || entry > 1 ? null : Math.max(0, entry);
}

function segmentVehicle(a, b, v) {
  const transform = (p) => {
    const dx = p.x - v.position.x, dz = p.z - v.position.z;
    return { x: dx * Math.cos(v.heading) - dz * Math.sin(v.heading), z: dx * Math.sin(v.heading) + dz * Math.cos(v.heading) };
  };
  return segmentBox(transform(a), transform(b), -v.width / 2, v.width / 2, -v.length / 2, v.length / 2);
}

function shoot(w) {
  const s = w.state;
  if (w.actor !== 'foot' || s.reloadRemaining > 0 || w.shootingCooldown > 0 || s.ammo <= 0) return;
  s.ammo--;
  w.shootingCooldown = 0.19;
  crime(w, 2, 18);
  const direction = vec(Math.sin(w.cameraYaw), 0, Math.cos(w.cameraYaw));
  const position = w.player.position.clone().add(vec(0, 1.35, 0)).addScaledVector(direction, 0.7);
  const mesh = new T.Mesh(geometry(w, 'SphereGeometry', [0.07, 5, 4]), material(w, '#fff0a5', { emissive: '#ffbf55', emissiveIntensity: 3 }));
  mesh.position.copy(position);
  w.scene.add(mesh);
  w.bullets.push({ mesh, position: mesh.position, direction, remaining: 1.6 });
  sparks(w, position, '#ffdf89', 3);
  sound(w, 'shot');
}

function updateCombat(w, dt, input) {
  const s = w.state;
  // This single timer controls both ammunition replenishment AND shot gating.
  if (s.reloadRemaining > 0) {
    s.reloadRemaining = Math.max(0, s.reloadRemaining - dt);
    if (s.reloadRemaining === 0) s.ammo = MAGAZINE;
  }
  w.shootingCooldown = Math.max(0, w.shootingCooldown - dt);
  w.meleeCooldown = Math.max(0, w.meleeCooldown - dt);
  if (input.reload && w.actor === 'foot' && s.ammo < MAGAZINE && s.reloadRemaining === 0) s.reloadRemaining = 1;
  if (input.shoot) shoot(w);
  if (input.melee && w.actor === 'foot' && w.meleeCooldown === 0) {
    w.meleeCooldown = 0.55;
    w.player.arms[1].rotation.x = -1.6;
    const victim = w.pedestrians.find((p) => p.alive && distance(p.position, w.player.position) < 1.7 && Math.abs(angleDelta(headingTo(w.player.position, p.position), w.player.heading)) < 1.3);
    if (victim) { knockDown(w, victim); sound(w, 'impact'); }
  }
  for (let i = w.bullets.length - 1; i >= 0; i--) {
    const bullet = w.bullets[i];
    const start = bullet.position.clone();
    const end = start.clone().addScaledVector(bullet.direction, 90 * dt);
    let first = 1.00001, hit = null, kind = '';
    const consider = (t, entity, type) => { if (t !== null && t < first) { first = t; hit = entity; kind = type; } };
    // Buildings win exact ties; a person behind a wall can never be hit.
    for (const building of w.buildings) consider(segmentBox(start, end, building.minX, building.maxX, building.minZ, building.maxZ), building, 'building');
    for (const p of w.pedestrians) if (p.alive) consider(segmentPerson(start, end, p.position), p, 'person');
    for (const v of [...w.vehicles, ...w.police]) consider(segmentVehicle(start, end, v), v, 'vehicle');
    bullet.remaining -= dt;
    if (hit) {
      bullet.position.copy(start).lerp(end, first);
      if (kind === 'person') knockDown(w, hit, true);
      if (kind === 'vehicle') hit.health = Math.max(0, hit.health - 5);
      sparks(w, bullet.position, '#ffd27a', 5);
    } else bullet.position.copy(end);
    if (hit || bullet.remaining <= 0) {
      w.scene.remove(bullet.mesh);
      w.bullets.splice(i, 1);
    }
  }
}

function roadPath(w, from, target) {
  const nodes = [];
  const zs = [...ROAD_AXES, 96];
  for (const x of ROAD_AXES) for (const z of zs) nodes.push(vec(x, 0, z));
  const nearest = (p) => nodes.reduce((best, node, i) => distance(p, node) < distance(p, nodes[best]) ? i : best, 0);
  const start = nearest(from), end = nearest(target);
  const scores = nodes.map(() => Infinity), previous = nodes.map(() => -1);
  scores[start] = 0;
  const open = new Set(nodes.map((_, i) => i));
  while (open.size) {
    let current = -1;
    for (const i of open) if (current < 0 || scores[i] < scores[current]) current = i;
    if (current === end || !Number.isFinite(scores[current])) break;
    open.delete(current);
    for (const next of open) {
      const a = nodes[current], b = nodes[next];
      if (!(a.x === b.x && Math.abs(a.z - b.z) <= 48 || a.z === b.z && Math.abs(a.x - b.x) <= 48)) continue;
      const candidate = scores[current] + distance(a, b);
      if (candidate < scores[next]) { scores[next] = candidate; previous[next] = current; }
    }
  }
  const path = [];
  let at = end;
  while (at !== -1) { path.unshift(nodes[at]); if (at === start) break; at = previous[at]; }
  return path;
}

function clearDrivingLine(w, v, target) {
  const yaw = headingTo(v.position, target);
  const length = distance(v.position, target);
  for (let step = 0; step <= length; step += 1.4) {
    const p = v.position.clone().lerp(target, length ? step / length : 0);
    if (blocked(w, p, v.width, v.length, yaw)) return false;
  }
  return !blocked(w, target, v.width, v.length, yaw);
}

function spawnPolice(w, index) {
  const actor = activeActor(w);
  const car = makeVehicle(w, `police-${index}`, 0, '#f1efe5', true);
  const candidates = [];
  for (let ring = 14; ring <= 75; ring += 10) {
    for (let i = 0; i < 12; i++) {
      const yaw = (i + index * 2) * TAU / 12;
      const near = vec(actor.position.x + Math.sin(yaw) * ring, 0, actor.position.z + Math.cos(yaw) * ring);
      const x = ROAD_AXES.reduce((best, a) => Math.abs(near.x - a) < Math.abs(near.x - best) ? a : best, ROAD_AXES[0]);
      const z = [...ROAD_AXES, 96].reduce((best, a) => Math.abs(near.z - a) < Math.abs(near.z - best) ? a : best, -72);
      if (Math.abs(near.x - x) < Math.abs(near.z - z)) near.x = x;
      else near.z = z;
      candidates.push(near);
    }
  }
  let placed = false;
  for (const position of candidates) {
    car.position.copy(position);
    car.heading = headingTo(position, actor.position);
    if (distance(position, actor.position) < 10 || blocked(w, position, car.width, car.length, car.heading)) continue;
    if ([...w.vehicles, ...w.police].some((v) => carsOverlap(car, v, 1))) continue;
    placed = true;
    break;
  }
  if (!placed) { // Deterministic exhaustive road scan if the nearby lanes are full.
    outer: for (const x of ROAD_AXES) for (let z = -98; z < 122; z += 7) {
      car.position.set(x, 0, z); car.heading = 0;
      if (!blocked(w, car.position, car.width, car.length, 0) && distance(car.position, actor.position) > 8 && ![...w.vehicles, ...w.police].some((v) => carsOverlap(car, v, 1))) break outer;
    }
  }
  car.mesh.rotation.y = car.heading;
  car.speed = 0;
  car.repathRemaining = 0;
  car.chasePath = [];
  w.police.push(car);
}

function syncPolice(w, stars) {
  const count = clamp(Math.ceil(finite(stars, 0)), 0, 5);
  while (w.police.length > count) {
    const car = w.police.pop();
    w.scene.remove(car.mesh);
    // Police labels have unique textures: release them on retirement.
    car.mesh.traverse((node) => {
      if (node.material?.map) {
        const mat = node.material, texture = mat.map;
        texture.dispose(); mat.dispose();
        w.textures = w.textures.filter((t) => t !== texture);
        w.labels = w.labels.filter((m) => m !== mat);
      }
    });
  }
  while (w.police.length < count) spawnPolice(w, w.police.length);
  if (!count && w.audio) w.audio.sirenGain.gain.value = 0;
}

function updatePolice(w, dt) {
  const actor = activeActor(w);
  for (const car of w.police) {
    const prediction = actor.position.clone();
    if (w.actor === 'vehicle') prediction.add(vec(Math.sin(actor.heading), 0, Math.cos(actor.heading)).multiplyScalar(actor.speed * 0.45));
    prediction.x = clamp(prediction.x, -99, 99);
    prediction.z = clamp(prediction.z, -99, 121);
    let target = prediction;
    car.repathRemaining -= dt;
    if (!clearDrivingLine(w, car, target)) {
      if (car.repathRemaining <= 0 || !car.chasePath.length) {
        car.chasePath = roadPath(w, car.position, prediction);
        car.repathRemaining = 1.3;
      }
      while (car.chasePath.length > 1 && distance(car.position, car.chasePath[0]) < 4) car.chasePath.shift();
      target = car.chasePath[0] || prediction;
    } else car.chasePath = [];
    const desired = headingTo(car.position, target);
    const error = angleDelta(desired, car.heading);
    const yaw = car.heading + clamp(error, -2.5 * dt, 2.5 * dt);
    const speed = Math.min(22, 7 + distance(car.position, actor.position) * 0.32) * (Math.abs(error) > 0.8 ? 0.32 : 1);
    car.speed = Math.min(speed, car.speed + 10 * dt);
    const before = car.position.clone();
    tryVehicleMove(w, car, dt, yaw, false, true);
    if (distance(before, car.position) < dt * 0.15) car.stuckTime += dt;
    else car.stuckTime = 0;
    if (car.stuckTime > 0.8) {
      // Rotate only when the entire rotated body fits; never phase through walls.
      const turn = car.heading + (error >= 0 ? 1 : -1) * dt * 1.8;
      if (!blocked(w, car.position, car.width, car.length, turn) && ![...w.vehicles, ...w.police].some((other) => other !== car && carsOverlap({ ...car, heading: turn }, other))) {
        car.heading = turn; car.mesh.rotation.y = turn;
      }
      car.repathRemaining = 0;
    }
    const phase = Math.sin(w.elapsed * 14 + Number(car.id.split('-')[1]));
    car.sirens.forEach((mesh, i) => { mesh.visible = i === 0 ? phase > -0.2 : phase < 0.2; });
  }
}

function sparks(w, position, color, count) {
  for (let i = 0; i < count && w.particles.length < 160; i++) {
    const mesh = new T.Mesh(geometry(w, 'BoxGeometry', [0.09, 0.09, 0.09]), material(w, color, { emissive: color, emissiveIntensity: 0.5 }));
    mesh.position.copy(position);
    if (mesh.position.y < 0.4) mesh.position.y = 0.8;
    const yaw = (i * 2.399 + w.elapsed * 7) % TAU;
    const velocity = vec(Math.sin(yaw) * (2 + i % 3), 2 + i % 4, Math.cos(yaw) * (2 + i % 3));
    w.scene.add(mesh);
    w.particles.push({ mesh, velocity, remaining: 0.45 + (i % 4) * 0.1, smoke: false });
  }
}

function updateEffects(w, dt) {
  for (const v of [...w.vehicles, ...w.police]) {
    for (const wheel of v.wheels) wheel.rotation.x += v.speed * dt / 0.39;
    if (v.health < 35) {
      v.smokeRemaining -= dt;
      if (v.smokeRemaining <= 0 && w.particles.length < 160) {
        v.smokeRemaining = 0.2;
        const mesh = new T.Mesh(geometry(w, 'IcosahedronGeometry', [0.25, 0]), material(w, '#687579', { transparent: true, opacity: 0.35 }));
        mesh.position.copy(v.position).add(vec(Math.sin(v.heading), 1.1, Math.cos(v.heading)));
        w.scene.add(mesh);
        w.particles.push({ mesh, velocity: vec(0.2, 1.3, 0.1), remaining: 1.5, smoke: true });
      }
    }
  }
  for (let i = w.particles.length - 1; i >= 0; i--) {
    const p = w.particles[i];
    p.remaining -= dt;
    p.mesh.position.addScaledVector(p.velocity, dt);
    if (p.smoke) p.mesh.scale.multiplyScalar(1 + dt * 0.7);
    else p.velocity.y -= 9 * dt;
    if (p.remaining <= 0) { w.scene.remove(p.mesh); w.particles.splice(i, 1); }
  }
  const marked = w.markedVehicle;
  marked.marker.visible = (w.state?.missionIndex ?? 0) === 0;
  marked.marker.children[0].rotation.y = w.elapsed;
  marked.marker.children[0].position.y = 4.4 + Math.sin(w.elapsed * 2.5) * 0.2;
  const mission = w.state?.missionIndex ?? 0;
  const objective = w.objectivePosition || [w.markedVehicle.position, w.locations.pier, w.locations.meeting, w.locations.safehouse][mission];
  w.objectiveMarker.visible = Boolean(objective) && (w.state?.missionIndex ?? 0) !== 0;
  if (objective) w.objectiveMarker.position.copy(objective);
  w.objectiveMarker.children[0].rotation.y = -w.elapsed;
}

function updateCamera(w, dt, input = {}) {
  w.cameraYaw -= (input.lookX || 0) * 0.0025;
  w.cameraPitch = clamp(w.cameraPitch + (input.lookY || 0) * 0.002, 0.08, 0.9);
  const actor = activeActor(w);
  if (w.actor === 'vehicle' && !input.lookX && Math.abs(actor.speed) > 1) {
    const facing = actor.heading + (actor.speed < 0 ? Math.PI : 0);
    w.cameraYaw += angleDelta(facing, w.cameraYaw) * (1 - Math.exp(-dt * 2.5));
  }
  const target = actor.position.clone().add(vec(0, w.actor === 'vehicle' ? 1.1 : 1.4, 0));
  const radius = w.actor === 'vehicle' ? 10.8 : input.aiming ? 4 : 7.4;
  const desired = target.clone().add(vec(-Math.sin(w.cameraYaw) * radius, 2 + Math.sin(w.cameraPitch) * radius, -Math.cos(w.cameraYaw) * radius));
  // Pull the camera in front of a wall instead of looking through a building.
  let first = 1;
  for (const b of w.buildings) {
    if (desired.y > b.height && target.y > b.height) continue;
    const hit = segmentBox(target, desired, b.minX - 0.2, b.maxX + 0.2, b.minZ - 0.2, b.maxZ + 0.2);
    if (hit !== null) first = Math.min(first, Math.max(0.12, hit - 0.06));
  }
  desired.copy(target).lerp(target.clone().add(vec(-Math.sin(w.cameraYaw) * radius, 2 + Math.sin(w.cameraPitch) * radius, -Math.cos(w.cameraYaw) * radius)), first);
  if (!w.cameraReady) { w.camera.position.copy(desired); w.cameraReady = true; }
  else w.camera.position.lerp(desired, 1 - Math.exp(-10 * dt));
  w.camera.lookAt(target);
}

export function updateWorld(w, dt, input = {}, state = w.state) {
  w.events = [];
  if (!state || state.paused || state.frozen || state.dead || state.screen === 'title') return w.events;
  w.state = state;
  const duration = Math.max(0, finite(dt, 0));
  // Also handle unusually large callers without skipping collision targets.
  const steps = Math.max(1, Math.ceil(duration / (1 / 60)));
  const step = duration / steps;
  w.frameDamage = 0;
  for (let i = 0; i < steps; i++) {
    const controls = i === 0 ? input : { ...input, interact: false, shoot: false, melee: false, reload: false, lookX: 0, lookY: 0 };
    w.elapsed += step;
    w.contactCooldown = Math.max(0, w.contactCooldown - step);
    if (controls.interact) interact(w);
    if (w.actor === 'vehicle' && w.activeVehicle) moveVehicle(w, w.activeVehicle, step, controls);
    else moveFoot(w, step, controls);
    updateTraffic(w, step);
    updatePedestrians(w, step);
    updateCombat(w, step, controls);
    syncPolice(w, Math.ceil(clamp(state.wanted, 0, 5)));
    updatePolice(w, step);
    updateEffects(w, step);
    updateCamera(w, step, controls);
  }
  // One aggregated damage event lets the binding check death after ALL sources.
  if (w.frameDamage > 0) w.events.push({ type: 'damage', amount: w.frameDamage, source: w.damageSource });
  state.actor = w.actor;
  state.vehicleId = w.vehicleId;
  updateAudio(w);
  return w.events;
}

function clearTransientEffects(w) {
  for (const entity of [...w.bullets, ...w.particles]) w.scene.remove(entity.mesh);
  w.bullets.length = 0;
  w.particles.length = 0;
  w.shootingCooldown = 0;
  w.meleeCooldown = 0;
  w.contactCooldown = 0;
  if (w.state) {
    w.state.ammo = MAGAZINE;
    w.state.reloadRemaining = 0;
    w.state.heat = 0;
    if (w.state.health <= 0 || w.state.dead) { w.state.wanted = 0; syncPolice(w, 0); }
  }
}

export function resetWorld(w) {
  clearTransientEffects(w);
  syncPolice(w, 0);
  w.events = [];
  w.elapsed = 0;
  w.frameDamage = 0;
  w.actor = 'foot';
  w.vehicleId = null;
  w.objectivePosition = null;
  w.player.position.copy(w.locations.spawn);
  w.player.heading = Math.PI;
  w.player.mesh.rotation.set(0, Math.PI, 0);
  w.player.mesh.visible = true;
  w.player.phase = 0;
  animatePerson(w.player, 0);
  for (const v of w.vehicles) {
    v.position.copy(v.initial.position);
    v.heading = v.initial.heading;
    v.mesh.rotation.set(0, v.heading, 0);
    for (const wheel of v.wheels) wheel.rotation.set(0, 0, Math.PI / 2);
    v.speed = 0;
    v.health = 100;
    v.ai = true;
    v.stolen = false;
    v.waypoint = v.initial.waypoint;
    v.stopRemaining = v.initial.stopRemaining;
    v.smokeRemaining = 0;
    v.stuckTime = 0;
  }
  for (const p of w.pedestrians) {
    p.position.copy(p.start);
    p.heading = p.initialHeading;
    p.direction = 1;
    p.alive = true;
    p.fallRemaining = 0;
    p.phase = 0;
    p.mesh.rotation.set(0, p.heading, 0);
    p.mesh.visible = true;
    animatePerson(p, 0);
  }
  if (w.state) {
    w.state.actor = 'foot'; w.state.vehicleId = null;
    w.state.wanted = 0; w.state.heat = 0;
  }
  w.markedVehicle.marker.visible = true;
  w.objectiveMarker.visible = false;
  w.cameraYaw = Math.PI;
  w.cameraPitch = 0.29;
  w.cameraReady = false;
  rememberSafe(w);
  updateCamera(w, 0);
  if (w.audio) { w.audio.engineGain.gain.value = 0; w.audio.sirenGain.gain.value = 0; }
}

export function getWorldSnapshot(w) {
  const actor = activeActor(w);
  return {
    actor: w.actor, vehicleId: w.vehicleId,
    position: { x: actor.position.x, y: actor.position.y, z: actor.position.z },
    heading: actor.heading, cameraYaw: w.cameraYaw,
    player: { x: w.player.position.x, y: w.player.position.y, z: w.player.position.z, heading: w.player.heading },
    vehicles: w.vehicles.map((v) => ({ id: v.id, x: v.position.x, z: v.position.z, heading: v.heading, speed: v.speed, health: v.health, stolen: v.stolen, ai: v.ai, waypoint: v.waypoint, stopRemaining: v.stopRemaining })),
  };
}

export function applyWorldSnapshot(w, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  clearTransientEffects(w);
  if (Array.isArray(snapshot.vehicles)) for (const data of snapshot.vehicles) {
    const car = w.vehicles.find((v) => v.id === data.id);
    if (!car) continue;
    const position = vec(finite(data.x, car.position.x), 0, finite(data.z, car.position.z));
    const yaw = finite(data.heading, car.heading);
    if (!blocked(w, position, car.width, car.length, yaw)) { car.position.copy(position); car.heading = yaw; }
    car.speed = clamp(finite(data.speed, 0), -car.topSpeed * 0.36, car.topSpeed);
    car.health = clamp(finite(data.health, 100), 0, 100);
    car.stolen = data.stolen === true;
    car.ai = data.ai !== false && !car.stolen;
    car.waypoint = Number.isInteger(data.waypoint) ? clamp(data.waypoint, 0, car.route.length - 1) : car.initial.waypoint;
    car.stopRemaining = Math.max(0, finite(data.stopRemaining, 0));
    car.mesh.rotation.y = car.heading;
  }
  if (snapshot.player) {
    const p = snapshot.player;
    const position = vec(finite(p.x, w.locations.spawn.x), 0, finite(p.z, w.locations.spawn.z));
    if (!blocked(w, position)) w.player.position.copy(position);
    w.player.heading = finite(p.heading, Math.PI);
  }
  const vehicle = snapshot.actor === 'vehicle' ? w.vehicles.find((v) => v.id === snapshot.vehicleId) : null;
  switchActor(w, vehicle, false);
  const actor = activeActor(w);
  if (snapshot.position) {
    const p = snapshot.position;
    const position = vec(finite(p.x, actor.position.x), 0, finite(p.z, actor.position.z));
    const yaw = finite(snapshot.heading, actor.heading);
    if (!blocked(w, position, actor.width || 0.84, actor.length || 0.84, yaw)) actor.position.copy(position);
    actor.heading = yaw;
  }
  actor.mesh.rotation.y = actor.heading;
  w.cameraYaw = finite(snapshot.cameraYaw, actor.heading);
  w.cameraReady = false;
  rememberSafe(w);
  updateCamera(w, 0);
  syncPolice(w, Math.ceil(clamp(w.state?.wanted || 0, 0, 5)));
  return true;
}

function stageForScreenshot(w, stage) {
  // Staging is visual only; normal save-slot policy belongs to main.js.
  resetWorld(w);
  const harbor = stage.area === 'harbor';
  w.player.position.copy(harbor ? vec(16, 0, 88) : vec(16, 0, 14));
  w.player.heading = harbor ? Math.PI : -0.2;
  if (stage.actor === 'vehicle') {
    const car = w.markedVehicle;
    car.position.set(24, 0, 91);
    car.heading = -Math.PI / 2;
    car.mesh.rotation.y = car.heading;
    car.stolen = true;
    car.speed = 15;
    switchActor(w, car, false);
  }
  w.cameraYaw = harbor ? -Math.PI / 2 - 0.42 : Math.PI + 0.35;
  w.cameraPitch = 0.34;
  w.cameraReady = false;
  w.markedVehicle.marker.visible = stage.mission === 0;
  syncPolice(w, stage.wanted);
  updateCamera(w, 0);
  rememberSafe(w);
}

function resize(w) {
  const width = Math.max(1, w.canvas.clientWidth || globalThis.innerWidth || 1280);
  const height = Math.max(1, w.canvas.clientHeight || globalThis.innerHeight || 720);
  w.renderer.setSize(width, height, false);
  w.camera.aspect = width / height;
  w.camera.updateProjectionMatrix();
}

export function renderWorld(w) {
  const canvas = w.canvas;
  const ratio = w.renderer.getPixelRatio();
  if (Math.abs(canvas.width - (canvas.clientWidth || canvas.width / ratio) * ratio) > 2 || Math.abs(canvas.height - (canvas.clientHeight || canvas.height / ratio) * ratio) > 2) resize(w);
  w.renderer.render(w.scene, w.camera);
}

function ensureAudio(w) {
  if (w.audio || !w.audioEnabled || w.screenshotMode) return w.audio;
  const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContext) return null;
  try {
    const context = new AudioContext();
    const master = context.createGain(); master.gain.value = 0.12; master.connect(context.destination);
    const engine = context.createOscillator(), engineGain = context.createGain();
    engine.type = 'triangle'; engine.frequency.value = 42; engineGain.gain.value = 0;
    engine.connect(engineGain); engineGain.connect(master); engine.start();
    const siren = context.createOscillator(), sirenGain = context.createGain();
    siren.type = 'sine'; sirenGain.gain.value = 0; siren.connect(sirenGain); sirenGain.connect(master); siren.start();
    w.audio = { context, master, engine, engineGain, siren, sirenGain };
  } catch { return null; }
  return w.audio;
}

function sound(w, kind) {
  if (!w.audioEnabled) return;
  const audio = ensureAudio(w);
  if (!audio) return;
  if (audio.context.state === 'suspended') audio.context.resume().catch(() => {});
  const oscillator = audio.context.createOscillator(), gain = audio.context.createGain();
  const now = audio.context.currentTime;
  const duration = kind === 'mission' ? 0.6 : kind === 'shot' ? 0.12 : 0.2;
  oscillator.type = kind === 'mission' ? 'sine' : kind === 'shot' ? 'sawtooth' : 'triangle';
  oscillator.frequency.setValueAtTime(kind === 'mission' ? 440 : kind === 'shot' ? 150 : 90, now);
  oscillator.frequency.exponentialRampToValueAtTime(kind === 'mission' ? 880 : 35, now + duration);
  gain.gain.setValueAtTime(kind === 'shot' ? 0.6 : 0.35, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  oscillator.connect(gain); gain.connect(audio.master);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  oscillator.start(); oscillator.stop(now + duration);
}

function updateAudio(w) {
  if (!w.audioEnabled) return;
  const audio = w.audio;
  if (!audio) return;
  audio.engine.frequency.value = 36 + Math.abs(w.activeVehicle?.speed || 0) * 4;
  audio.engineGain.gain.value = w.actor === 'vehicle' ? 0.22 : 0;
  audio.siren.frequency.value = 610 + Math.sin(w.elapsed * 5) * 190;
  audio.sirenGain.gain.value = w.police.length ? 0.09 : 0;
}

function setAudioEnabled(w, enabled) {
  w.audioEnabled = Boolean(enabled);
  if (w.audio) w.audio.master.gain.value = enabled ? 0.12 : 0;
  else if (enabled) ensureAudio(w);
}

export function disposeWorld(w) {
  if (!w) return;
  clearTransientEffects(w);
  syncPolice(w, 0);
  if (w.audio) {
    w.audio.engine.stop(); w.audio.siren.stop();
    w.audio.context.close().catch(() => {});
  }
  for (const g of w.geometries.values()) g.dispose();
  for (const m of w.materials.values()) m.dispose();
  for (const m of w.labels) m.dispose();
  for (const t of w.textures) t.dispose();
  w.scene.clear();
  w.renderer.dispose();
}
