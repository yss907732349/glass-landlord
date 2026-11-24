/** Electron screen coordinates and window bounds are all logical pixels (DIP). */
function getDesktopLayout(screen) {
  const displays = screen.getAllDisplays();
  const x = Math.min(...displays.map(display => display.bounds.x));
  const y = Math.min(...displays.map(display => display.bounds.y));
  const right = Math.max(...displays.map(display => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map(display => display.bounds.y + display.bounds.height));
  const local = rect => ({ x: rect.x - x, y: rect.y - y, width: rect.width, height: rect.height });
  return {
    bounds: { x, y, width: right - x, height: bottom - y },
    primary: local(screen.getPrimaryDisplay().workArea),
    displays: displays.map(display => ({ id: display.id, scaleFactor: display.scaleFactor, bounds: local(display.bounds), workArea: local(display.workArea) })),
  };
}
module.exports = { getDesktopLayout };
