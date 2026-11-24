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
let ignored = false;
function updatePassthrough(event) {
  const element = document.elementFromPoint(event.clientX, event.clientY);
  const interactive = event.buttons !== 0 || !!element?.closest('.interactive,button,input,select,a');
  if (ignored === !interactive) return;
  ignored = !interactive;
  ipcRenderer.send('window-control', 'passthrough', ignored);
}
addEventListener('mousemove', updatePassthrough);
addEventListener('mouseup', updatePassthrough);
addEventListener('beforeunload', () => ipcRenderer.send('window-control', 'passthrough', false));
ipcRenderer.on('reset-layout', () => window.dispatchEvent(new Event('glass-reset-layout')));
ipcRenderer.on('display-layout', (_event, layout) => window.dispatchEvent(new CustomEvent('glass-display-layout', { detail: layout })));
