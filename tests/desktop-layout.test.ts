import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

type Rect = { x: number; y: number; width: number; height: number };
type Display = { id: number; scaleFactor: number; bounds: Rect; workArea: Rect };
type Screen = { getAllDisplays: () => Display[]; getPrimaryDisplay: () => Display };
type Layout = { bounds: Rect; primary: Rect; displays: Display[] };
const { getDesktopLayout } = createRequire(import.meta.url)('../desktop/layout.cjs') as {
  getDesktopLayout: (screen: Screen) => Layout;
};

function display(id: number, bounds: Rect, workArea = bounds, scaleFactor = 1): Display {
  return { id, bounds, workArea, scaleFactor };
}
function screen(displays: Display[], primary = displays[0]): Screen {
  return { getAllDisplays: () => displays, getPrimaryDisplay: () => primary };
}

test('desktop overlay spans both adjacent displays and keeps primary work area', () => {
  const primary = display(1, { x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1040 });
  const right = display(2, { x: 1920, y: 0, width: 1920, height: 1080 });
  const layout = getDesktopLayout(screen([primary, right]));
  assert.deepEqual(layout.bounds, { x: 0, y: 0, width: 3840, height: 1080 });
  assert.deepEqual(layout.primary, { x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(layout.displays[1].bounds, { x: 1920, y: 0, width: 1920, height: 1080 });
});

test('left and upper displays produce a negative native origin and positive local coordinates', () => {
  const primary = display(1, { x: 0, y: 0, width: 1920, height: 1080 });
  const left = display(2, { x: -1600, y: 0, width: 1600, height: 900 });
  const upper = display(3, { x: 0, y: -1200, width: 1920, height: 1200 });
  // Display enumeration order does not identify the primary monitor.
  const layout = getDesktopLayout(screen([left, upper, primary], primary));
  assert.deepEqual(layout.bounds, { x: -1600, y: -1200, width: 3520, height: 2280 });
  assert.deepEqual(layout.primary, { x: 1600, y: 1200, width: 1920, height: 1080 });
  assert.deepEqual(layout.displays[0].bounds, { x: 0, y: 1200, width: 1600, height: 900 });
  assert.deepEqual(layout.displays[1].bounds, { x: 1600, y: 0, width: 1920, height: 1200 });
});

test('mixed DPI display geometry stays in logical pixels without multiplying scale factors', () => {
  const primary = display(1, { x: 0, y: 0, width: 1920, height: 1080 });
  const highDpi = display(2, { x: 1920, y: -200, width: 2560, height: 1440 }, undefined, 1.5);
  const layout = getDesktopLayout(screen([primary, highDpi]));
  assert.deepEqual(layout.bounds, { x: 0, y: -200, width: 4480, height: 1440 });
  assert.deepEqual(layout.primary, { x: 0, y: 200, width: 1920, height: 1080 });
  assert.deepEqual(layout.displays[1], {
    id: 2,
    scaleFactor: 1.5,
    bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
    workArea: { x: 1920, y: 0, width: 2560, height: 1440 },
  });
});

test('taskbar offsets affect usable areas without cutting the native desktop union', () => {
  const primary = display(1,
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 48, y: 0, width: 1872, height: 1080 });
  const left = display(2,
    { x: -1280, y: -100, width: 1280, height: 1024 },
    { x: -1280, y: -60, width: 1280, height: 984 });
  const layout = getDesktopLayout(screen([primary, left]));
  assert.deepEqual(layout.bounds, { x: -1280, y: -100, width: 3200, height: 1180 });
  assert.deepEqual(layout.primary, { x: 1328, y: 100, width: 1872, height: 1080 });
  assert.deepEqual(layout.displays[1].workArea, { x: 0, y: 40, width: 1280, height: 984 });
  assert.deepEqual(primary.workArea, { x: 48, y: 0, width: 1872, height: 1080 }, 'layout must not mutate Electron display geometry');
});

test('removing a monitor recomputes the union and rebases the surviving primary', () => {
  const primary = display(1, { x: 0, y: 0, width: 1920, height: 1080 });
  const left = display(2, { x: -1600, y: -200, width: 1600, height: 1200 });
  let active = [primary, left];
  const desktop: Screen = { getAllDisplays: () => active, getPrimaryDisplay: () => primary };
  const before = getDesktopLayout(desktop);
  assert.deepEqual(before.bounds, { x: -1600, y: -200, width: 3520, height: 1280 });
  assert.deepEqual(before.primary, { x: 1600, y: 200, width: 1920, height: 1080 });
  active = [primary];
  const after = getDesktopLayout(desktop);
  assert.deepEqual(after.bounds, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(after.primary, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(after.displays.map(item => item.id), [1]);
  assert.equal(before.displays.length, 2, 'earlier snapshots remain independent of later display changes');
});
