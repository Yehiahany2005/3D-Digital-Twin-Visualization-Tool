// Browser check for DXF floor plans in Scene mode (Playwright + Chromium).
//
//   npm run dev                       (in another terminal)
//   node scripts/check-floor-plan.mjs [url] [screenshot folder]
//
// PLAYWRIGHT_MODULE / CHROMIUM_PATH point at a Playwright install and a Chromium if they aren't
// the defaults. Imports docs/samples/sample-hall.dxf, then checks scale, layers, walls, picking
// with things placed on top, Digital Twin View, save + reload, export + reopen, and the messages
// for DWG and broken files.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] || 'http://localhost:5173/';
const shots = process.argv[3] || 'floor-plan-shots';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
await mkdir(shots, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });

const step = (text) => console.log(`✓ ${text}`);
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const status = () => page.locator('[data-asset-status]').textContent();

// The plan's runtime and a few facts about it, read inside the page.
const planFacts = () => page.evaluate(() => {
  const { editor } = window.__twin.sceneEditor;
  const runtime = [...editor.runtimes.values()].find((candidate) => candidate.kind === 'plan');
  if (!runtime) return null;
  const plan = runtime.component;
  const walls = plan.layerObjects.get('WALLS')[0];
  walls.updateMatrixWorld(true);
  const box = walls.geometry.boundingBox.clone().applyMatrix4(walls.matrixWorld);
  const wallMesh = plan.walls.children[0];
  return {
    id: runtime.id,
    item: editor.item(runtime.id),
    size: [box.max.x - box.min.x, box.max.z - box.min.z],
    lineObjects: plan.drawing.children.filter((object) => object.isLineSegments).length,
    dimensionsShown: plan.layerObjects.get('DIMENSIONS').every((object) => object.visible),
    wallHeight: wallMesh ? wallMesh.geometry.boundingBox.max.y : 0,
    wallPieces: plan.wallSegments?.length || 0,
    colliders: plan.colliders.length,
    digital: plan.digital,
    lineColor: plan.lineMaterial.color.getHex(),
  };
});

// Screen position of a world point.
const screenOf = (x, y, z) => page.evaluate(([px, py, pz]) => {
  const camera = window.__twin.sceneEditor.cameraManager.camera;
  const canvas = window.__twin.rendererManager.renderer.domElement;
  const rect = canvas.getBoundingClientRect();
  const v = camera.position.clone().set(px, py, pz).project(camera);
  return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
}, [x, y, z]);
const selectedId = () => page.evaluate(() => window.__twin.sceneEditor.editor.selectedId);
const clickAt = async ({ x, y }) => {
  await page.mouse.click(x, y);
  await page.waitForTimeout(150);
};

async function openNewScene() {
  await page.click('[data-mode-tab="scene"]');
  // The tab first opens the last scene (a built-in one on a fresh browser); wait until it has.
  await page.waitForFunction(() => window.__twin?.sceneTab?.source && !window.__twin.sceneTab.busy, null, { timeout: 60000 });
  await page.evaluate(() => window.__twin.sceneTab.withEditor(() => window.__twin.sceneEditor.newScene()));
  await page.waitForFunction(() => window.__twin.sceneTab.source === 'editor' && window.__twin.sceneEditor.active);
}

await page.goto(url);
await page.waitForFunction(() => window.__twin);
await openNewScene();

// ---- Errors -----------------------------------------------------------------------------------
await writeFile(path.join(shots, 'hall.dwg'), 'AC1032 not really a drawing');
await page.setInputFiles('[data-scene-plan-input]', path.join(shots, 'hall.dwg'));
await page.waitForTimeout(300);
assert.match(await status(), /DWG.*Save As.*DXF/s);
await writeFile(path.join(shots, 'broken.dxf'), 'this is\nnot a drawing at all\n');
await page.setInputFiles('[data-scene-plan-input]', path.join(shots, 'broken.dxf'));
await page.waitForFunction(() => /Couldn't read broken\.dxf/.test(document.querySelector('[data-asset-status]').textContent));
step(`errors: ${await status()}`);

// ---- Import -------------------------------------------------------------------------------------
await page.setInputFiles('[data-scene-plan-input]', 'docs/samples/sample-hall.dxf');
await page.waitForFunction(() => [...window.__twin.sceneEditor.editor.runtimes.values()].some((runtime) => runtime.kind === 'plan'));
await page.waitForTimeout(800);
let facts = await planFacts();
assert.ok(Math.abs(facts.size[0] - 40) < 1e-3 && Math.abs(facts.size[1] - 25) < 1e-3, `40 × 25 m hall measures ${facts.size}`);
assert.equal(facts.item.locked, true);
assert.deepEqual(facts.item.plan.hiddenLayers, ['DIMENSIONS']);
assert.equal(facts.dimensionsShown, false);
assert.equal(facts.lineObjects, 6, 'one LineSegments per layer with lines (LABELS only has text)');
step(`imported: walls measure ${facts.size.map((v) => v.toFixed(3)).join(' × ')} m, locked, dimensions hidden; ${await status()}`);
await shot('1-imported');

// ---- Layers: show dimensions, then undo ------------------------------------------------------------
const layerBox = (name) => page.locator('.plan-layer', { hasText: name }).locator('input');
await layerBox('DIMENSIONS').check();
facts = await planFacts();
assert.equal(facts.dimensionsShown, true);
await page.click('[data-scene-undo]');
facts = await planFacts();
assert.equal(facts.dimensionsShown, false);
step('layer switch and undo');

// ---- Walls ---------------------------------------------------------------------------------------
// The toolbar button opens the same file picker.
assert.equal(await page.locator('[data-scene-plan]').isVisible(), true);
assert.equal(await page.locator('.plan-walls').isVisible(), false, 'wall settings only once a layer is raised');
await page.locator('.plan-layer', { hasText: 'WALLS' }).locator('.plan-wall-toggle').click();
assert.equal(await page.locator('.plan-walls').isVisible(), true);
// A floor plan offers no Position, Attach or When playing groups.
const groups = await page.locator('.prop-group > summary span').allInnerTexts();
assert.ok(!['Attach', 'When playing', 'Position'].some((name) => groups.includes(name)), `plan groups: ${groups}`);
facts = await planFacts();
assert.equal(facts.wallHeight, 3);
assert.ok(facts.wallPieces > 0 && facts.colliders === facts.wallPieces);
// Playing: the raised walls are solid, the flat drawing isn't.
const physics = await page.evaluate(async () => {
  const mode = window.__twin.sceneEditor;
  await mode.startPlaying();
  const entry = mode.simulation.bodies.find((body) => body.runtime.kind === 'plan');
  const result = { type: entry?.type, colliders: entry?.body.numColliders() };
  mode.stopPlaying();
  return result;
});
assert.equal(physics.type, 'static');
assert.equal(physics.colliders, facts.wallPieces);
step(`walls raised: ${facts.wallPieces} pieces, 3 m high, solid when playing`);
await page.locator('.prop-group', { hasText: 'Drawn in' }).screenshot({ path: path.join(shots, '0-floor-plan-panel.png') });

// ---- Something placed on the plan still selects normally -------------------------------------------
const added = await page.evaluate(() => {
  const { editor } = window.__twin.sceneEditor;
  // Right on a plan line (the conveyor outline) in the middle of the hall.
  return editor.addItem({ source: { kind: 'catalog', id: 'belt_conveyor' }, name: 'Conveyor', position: [0, 0, -1], select: false }).id;
});
await page.waitForTimeout(800);
await page.evaluate(() => window.__twin.sceneEditor.view('top'));
await page.waitForTimeout(800);
await page.keyboard.press('Escape');
await clickAt(await screenOf(0, 0.8, -1));
assert.equal(await selectedId(), added, 'clicking the conveyor selects the conveyor, not the plan');
// Click next to a column outline (a plan line, nothing else there): the plan.
await clickAt(await screenOf(-15 + 0.2, 0, 7.5));
assert.equal(await selectedId(), facts.id, 'clicking a plan line with nothing on it selects the plan');
// Empty floor inside the hall: nothing.
await clickAt(await screenOf(-10, 0, -8));
assert.equal(await selectedId(), null, 'clicking empty floor selects nothing');
step('picking: conveyor over the plan, plan line, empty floor');

await page.evaluate(() => window.__twin.sceneEditor.view('front'));
await page.waitForTimeout(800);
await shot('2-walls-cad');
await page.click('[data-view-toggle]');
await page.waitForTimeout(900);
facts = await planFacts();
assert.equal(facts.digital, true);
await shot('3-walls-digital-twin');
await page.click('[data-view-toggle]');
await page.waitForTimeout(900);
step('Digital Twin View switches the plan\'s look');

// ---- Save and reload ------------------------------------------------------------------------------
await page.evaluate(() => window.__twin.sceneEditor.saveNow());
await page.reload();
await page.waitForFunction(() => window.__twin);
await page.waitForFunction(() => [...(window.__twin.sceneEditor.editor?.runtimes.values() || [])].some((runtime) => runtime.kind === 'plan'), null, { timeout: 30000 });
await page.waitForTimeout(500);
facts = await planFacts();
assert.equal(facts.wallHeight, 3);
assert.deepEqual(facts.item.plan.walls.layers, ['WALLS']);
assert.equal(facts.dimensionsShown, false);
step('saved and reloaded with walls and layers as they were');

// ---- Export and reopen -----------------------------------------------------------------------------
const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-scene-export]')]);
const bundlePath = path.join(shots, 'plan-scene.dtscene');
await download.saveAs(bundlePath);
const bundle = await readFile(bundlePath);
assert.ok(bundle.includes(Buffer.from('sample-hall.dxf')), 'the DXF travels in the bundle');
await page.setInputFiles('[data-scene-file-input]', bundlePath);
await page.waitForFunction(() => /\(2\)|Opened/.test(document.querySelector('[data-asset-status]').textContent) || window.__twin.sceneEditor.editor.document.name.includes('('));
await page.waitForFunction(() => [...window.__twin.sceneEditor.editor.runtimes.values()].some((runtime) => runtime.kind === 'plan'));
await page.waitForTimeout(500);
facts = await planFacts();
assert.ok(Math.abs(facts.size[0] - 40) < 1e-3);
assert.equal(facts.wallHeight, 3);
step(`exported (${(bundle.length / 1024).toFixed(1)} KB) and reopened as "${await page.evaluate(() => window.__twin.sceneEditor.editor.document.name)}"`);
await page.evaluate(() => window.__twin.sceneEditor.view('top'));
await page.waitForTimeout(800);
await shot('4-reopened');

assert.deepEqual(problems, [], `page errors: ${problems.join('\n')}`);
step('no errors in the page');
await browser.close();
