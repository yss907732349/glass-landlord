const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('service-info'),
  pin: value => ipcRenderer.send('window-control', 'pin', !!value),
  passthrough: value => ipcRenderer.send('window-control', 'passthrough', !!value),
  hide: () => ipcRenderer.send('window-control', 'hide'),
  minimize: () => ipcRenderer.send('window-control', 'minimize'),
  close: () => ipcRenderer.send('window-control', 'close'),
});
let frame = 0, releaseTimer = 0, locked = false, activeLayoutGesture = false, lastRegions = '', observer, resizeObserver, hitPlane, lastHitPlane = '';
let nativeFrame = null, frameRevision = 0, desktopBounds = null, frameReady = false, applyGeneration = 0;
const captures = new Set();
function applyNativeFrame(value) {
  if (!value || ![value.x, value.y, value.width, value.height, value.revision].every(Number.isFinite) || value.revision < frameRevision) return;
  nativeFrame = { x: value.x, y: value.y, width: value.width, height: value.height }; frameRevision = value.revision;
  if (!desktopBounds) return;
  const style = document.documentElement.style;
  for (const [name, next] of Object.entries({ '--desktop-frame-x': `${desktopBounds.x - nativeFrame.x}px`, '--desktop-frame-y': `${desktopBounds.y - nativeFrame.y}px`, '--desktop-width': `${desktopBounds.width}px`, '--desktop-height': `${desktopBounds.height}px` })) if (style.getPropertyValue(name) !== next) style.setProperty(name, next);
  frameReady = false; lastRegions = ''; const generation = ++applyGeneration;
  window.dispatchEvent(new CustomEvent('glass-native-frame', { detail: { ...nativeFrame, revision: frameRevision } }));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (generation !== applyGeneration) return;
    frameReady = true; if (locked) renderHitPlane([{ x: 0, y: 0, width: innerWidth, height: innerHeight }]); reportRegions();
  }));
}
function renderHitPlane(rects) {
  if (!document.body) return;
  if (!hitPlane) {
    hitPlane = document.createElement('div'); hitPlane.setAttribute('aria-hidden', 'true'); hitPlane.dataset.nativeHitPlane = 'true';
    hitPlane.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:-2147483647;'; document.body.append(hitPlane);
  }
  const key = JSON.stringify(rects);
  if (key === lastHitPlane) return;
  lastHitPlane = key;
  hitPlane.replaceChildren(...rects.map(rect => {
    const part = document.createElement('div');
    // Windows passes through pixels with alpha zero even inside a shaped HWND.
    // One alpha step supplies a native hit surface without adding a visible table.
    part.style.cssText = `position:absolute;pointer-events:none;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;background:rgba(0,0,0,.004);`;
    return part;
  }));
}
function reportRegions() {
  frame = 0;
  if (!frameReady || !nativeFrame) return;
  const rects = [];
  for (const element of document.querySelectorAll('.table-shell,.modal,.skill-tooltip,.peek-inline,.status-toast,.table-effects .fx-announcement,.chat-menu,.wild-options,.chat-bubble,[data-native-overlay]')) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) rects.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  }
  const key = `${frameRevision}:${JSON.stringify(rects)}`;
  if (!locked) renderHitPlane(rects.map(rect => ({ x: Math.max(0, rect.x - 24), y: Math.max(0, rect.y - 24), width: Math.min(innerWidth, rect.x + rect.width + 24) - Math.max(0, rect.x - 24), height: Math.min(innerHeight, rect.y + rect.height + 24) - Math.max(0, rect.y - 24) })).filter(rect => rect.width > 0 && rect.height > 0));
  if (key !== lastRegions) { lastRegions = key; ipcRenderer.send('interaction-regions', { revision: frameRevision, regions: rects.map(rect => ({ ...rect, x: nativeFrame.x + rect.x, y: nativeFrame.y + rect.y })) }); }
}
function scheduleRegions() { if (!frame) frame = requestAnimationFrame(reportRegions); }
function lockInteraction(event) {
  clearTimeout(releaseTimer);
  const gesture = activeLayoutGesture || !!event?.target?.closest?.('.move-handle,.resize-handle');
  if (!locked || gesture !== activeLayoutGesture) {
    locked = true; activeLayoutGesture = gesture; renderHitPlane([{ x: 0, y: 0, width: innerWidth, height: innerHeight }]);
    ipcRenderer.send('interaction-lock', { locked: true, layoutGesture: activeLayoutGesture });
  }
  scheduleRegions();
}
function releaseInteraction(immediate = false) {
  clearTimeout(releaseTimer);
  const release = () => { captures.clear(); locked = false; activeLayoutGesture = false; reportRegions(); ipcRenderer.send('interaction-lock', { locked: false, layoutGesture: false }); };
  if (immediate) release(); else releaseTimer = setTimeout(release, 180);
}
addEventListener('pointerdown', lockInteraction, true);
addEventListener('gotpointercapture', event => { captures.add(event.pointerId); lockInteraction(event); }, true);
addEventListener('pointermove', event => { if (event.buttons) lockInteraction(event); scheduleRegions(); }, true);
addEventListener('pointerup', event => { if (!event.buttons) releaseInteraction(); }, true);
addEventListener('lostpointercapture', event => {
  captures.delete(event.pointerId);
  // Moving the native viewport can drop DOM capture while the button is still held.
  // Layout gestures end on pointerup/cancel/blur rather than that native side effect.
  if (!captures.size && !(locked && activeLayoutGesture)) releaseInteraction();
}, true);
addEventListener('pointercancel', () => releaseInteraction(true), true);
addEventListener('blur', () => releaseInteraction(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseInteraction(true); });
for (const type of ['pointerover', 'pointerout', 'focusin', 'focusout', 'resize', 'scroll', 'animationstart', 'animationend', 'transitionend']) addEventListener(type, scheduleRegions, true);
addEventListener('DOMContentLoaded', () => {
  observer = new MutationObserver(scheduleRegions); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  resizeObserver = new ResizeObserver(scheduleRegions); resizeObserver.observe(document.documentElement);
  ipcRenderer.invoke('service-info').then(info => {
    desktopBounds = info.layout?.bounds;
    applyNativeFrame(nativeFrame && frameRevision > info.frameRevision ? { ...nativeFrame, revision: frameRevision } : { ...info.frame, revision: info.frameRevision });
  });
});
addEventListener('beforeunload', () => { observer?.disconnect(); resizeObserver?.disconnect(); cancelAnimationFrame(frame); clearTimeout(releaseTimer); ipcRenderer.send('interaction-lock', { locked: false, layoutGesture: false }); });
ipcRenderer.on('reset-layout', () => window.dispatchEvent(new Event('glass-reset-layout')));
ipcRenderer.on('display-layout', (_event, layout) => { desktopBounds = layout.bounds; if (nativeFrame) applyNativeFrame({ ...nativeFrame, revision: frameRevision }); window.dispatchEvent(new CustomEvent('glass-display-layout', { detail: layout })); });
ipcRenderer.on('native-frame', (_event, value) => applyNativeFrame(value));
