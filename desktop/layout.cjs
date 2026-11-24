/** Electron screen coordinates and window bounds are all logical pixels (DIP). */
function usableArea(display) {
  const { bounds, workArea } = display;
  // During DPI transitions Electron may report a work area from an older
  // coordinate system, even within one display record. Never infer a scale:
  // keep the table inside the current bounds until valid metrics arrive.
  const rounding = 2;
  const valid = workArea && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(workArea[key]))
    && workArea.width > 0 && workArea.height > 0
    && workArea.x >= bounds.x - rounding && workArea.y >= bounds.y - rounding
    && workArea.x + workArea.width <= bounds.x + bounds.width + rounding
    && workArea.y + workArea.height <= bounds.y + bounds.height + rounding;
  return valid ? workArea : bounds;
}
function getDesktopLayout(screen) {
  // Electron can refresh its display cache while a window initializes or DPI
  // changes. Use the primary getter only for identity; all geometry must come
  // from the same enumeration, rather than mixing two coordinate snapshots.
  const primaryId = screen.getPrimaryDisplay().id;
  const displays = screen.getAllDisplays();
  const primary = displays.find(display => display.id === primaryId) || displays[0];
  const x = Math.min(...displays.map(display => display.bounds.x));
  const y = Math.min(...displays.map(display => display.bounds.y));
  const right = Math.max(...displays.map(display => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map(display => display.bounds.y + display.bounds.height));
  const local = rect => ({ x: rect.x - x, y: rect.y - y, width: rect.width, height: rect.height });
  return {
    bounds: { x, y, width: right - x, height: bottom - y },
    primary: local(usableArea(primary)),
    displays: displays.map(display => ({ id: display.id, scaleFactor: display.scaleFactor, bounds: local(display.bounds), workArea: local(usableArea(display)) })),
  };
}
module.exports = { getDesktopLayout };
