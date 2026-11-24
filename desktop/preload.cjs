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
let frame = 0, locked = false, activeLayoutGesture = false, activePointerId = null;
let nativeFrame = null, frameRevision = 0, desktopBounds = null, frameReady = false, applyGeneration = 0;
let observer, resizeObserver, hitPlane, hitPart, lastHitPlane = '', lastRegions = '';
function renderHitPlane(rect) {
  if (!document.body || !rect || rect.width <= 0 || rect.height <= 0) return;
  if (!hitPlane) {
    hitPlane = document.createElement('div'); hitPlane.setAttribute('aria-hidden', 'true'); hitPlane.dataset.nativeHitPlane = 'true';
    hitPlane.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:-2147483647;';
    hitPart = document.createElement('div');
    // Some Windows composition paths hit-test alpha; others own the whole HWND.
    // Keep a stable hit floor for both, independent of the UI's opacity.
    hitPart.style.cssText = 'position:absolute;pointer-events:none;background:rgba(0,0,0,.004);';
    hitPlane.append(hitPart); document.body.append(hitPlane);
  }
  const key = JSON.stringify(rect); if (key === lastHitPlane) return; lastHitPlane = key;
  hitPart.style.left = `${rect.x}px`; hitPart.style.top = `${rect.y}px`;
  hitPart.style.width = `${rect.width}px`; hitPart.style.height = `${rect.height}px`;
}
function reportRegions() {
  frame = 0;
  if (!frameReady || !nativeFrame) return;
  const table = document.querySelector('.table-shell'); if (!table) return;
  const box = table.getBoundingClientRect(); if (box.width <= 0 || box.height <= 0) return;
  const rect = { x: box.x, y: box.y, width: box.width, height: box.height };
  if (activeLayoutGesture) renderHitPlane({ x: 0, y: 0, width: innerWidth, height: innerHeight });
  else renderHitPlane({ x: rect.x - 24, y: rect.y - 24, width: rect.width + 48, height: rect.height + 48 });
  const key = `${frameRevision}:${JSON.stringify(rect)}`;
  if (key === lastRegions) return; lastRegions = key;
  ipcRenderer.send('interaction-regions', { revision: frameRevision, regions: [{ ...rect, x: nativeFrame.x + rect.x, y: nativeFrame.y + rect.y }] });
}
function scheduleRegions() { if (!frame) frame = requestAnimationFrame(reportRegions); }
function applyNativeFrame(value) {
  if (!value || ![value.x, value.y, value.width, value.height, value.revision].every(Number.isFinite) || value.revision < frameRevision) return;
  nativeFrame = { x: value.x, y: value.y, width: value.width, height: value.height }; frameRevision = value.revision;
  if (!desktopBounds) return;
  const style = document.documentElement.style;
  for (const [name, next] of Object.entries({ '--desktop-frame-x': `${desktopBounds.x - nativeFrame.x}px`, '--desktop-frame-y': `${desktopBounds.y - nativeFrame.y}px`, '--desktop-width': `${desktopBounds.width}px`, '--desktop-height': `${desktopBounds.height}px` })) if (style.getPropertyValue(name) !== next) style.setProperty(name, next);
  frameReady = false; lastRegions = ''; const generation = ++applyGeneration;
  if (activeLayoutGesture) renderHitPlane({ x: 0, y: 0, width: innerWidth, height: innerHeight });
  window.dispatchEvent(new CustomEvent('glass-native-frame', { detail: { ...nativeFrame, revision: frameRevision } }));
  requestAnimationFrame(() => requestAnimationFrame(() => { if (generation === applyGeneration) { frameReady = true; reportRegions(); } }));
}
function lockInteraction(event) {
  if (event.button !== 0 || !event.isPrimary || activePointerId !== null) return;
  // Disabled controls may suppress their matching pointerup in Chromium.
  if (event.target?.closest?.(':disabled,[aria-disabled="true"]')) return;
  activePointerId = event.pointerId;
  const handle = event.target?.closest?.('.move-handle,.resize-handle');
  const gesture = !!handle && !handle.disabled && handle.getAttribute('aria-disabled') !== 'true';
  if (!locked || gesture !== activeLayoutGesture) {
    locked = true; activeLayoutGesture = gesture;
    // Ordinary card/skill/menu clicks never touch the native window or hit floor.
    if (gesture) renderHitPlane({ x: 0, y: 0, width: innerWidth, height: innerHeight });
    ipcRenderer.send('interaction-lock', { locked: true, layoutGesture: gesture });
  }
}
function releaseInteraction(reason = 'pointerup') {
  const wasGesture = activeLayoutGesture;
  locked = false; activeLayoutGesture = false; activePointerId = null;
  if (wasGesture) reportRegions();
  ipcRenderer.send('interaction-lock', { locked: false, layoutGesture: false, reason });
}
addEventListener('pointerdown', lockInteraction, true);
addEventListener('pointerup', event => { if (event.pointerId === activePointerId && !(event.buttons & 1)) releaseInteraction(); }, true);
addEventListener('pointercancel', event => { if (event.pointerId === activePointerId) releaseInteraction('cancel'); }, true);
addEventListener('blur', () => releaseInteraction('blur'));
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseInteraction('hidden'); });
addEventListener('wheel', event => { if (event.ctrlKey || event.metaKey) event.preventDefault(); }, { capture: true, passive: false });
addEventListener('resize', scheduleRegions);
addEventListener('DOMContentLoaded', () => {
  observer = new MutationObserver(scheduleRegions); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  resizeObserver = new ResizeObserver(scheduleRegions); resizeObserver.observe(document.documentElement);
  ipcRenderer.invoke('service-info').then(info => {
    desktopBounds = info.layout?.bounds;
    applyNativeFrame(nativeFrame && frameRevision > info.frameRevision ? { ...nativeFrame, revision: frameRevision } : { ...info.frame, revision: info.frameRevision });
  });
});
addEventListener('beforeunload', () => { observer?.disconnect(); resizeObserver?.disconnect(); cancelAnimationFrame(frame); releaseInteraction('hidden'); });
ipcRenderer.on('reset-layout', () => window.dispatchEvent(new Event('glass-reset-layout')));
ipcRenderer.on('display-layout', (_event, layout) => { desktopBounds = layout.bounds; if (nativeFrame) applyNativeFrame({ ...nativeFrame, revision: frameRevision }); window.dispatchEvent(new CustomEvent('glass-display-layout', { detail: layout })); });
ipcRenderer.on('native-frame', (_event, value) => applyNativeFrame(value));
ipcRenderer.on('window-state', (_event, value) => window.dispatchEvent(new CustomEvent('glass-window-state', { detail: value })));
