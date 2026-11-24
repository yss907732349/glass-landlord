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
addEventListener('mousemove', event => {
  const element = document.elementFromPoint(event.clientX, event.clientY);
  const interactive = !!element?.closest('.interactive,button,input,select,a');
  if (ignored === !interactive) return;
  ignored = !interactive;
  ipcRenderer.send('window-control', 'passthrough', ignored);
});
addEventListener('beforeunload', () => ipcRenderer.send('window-control', 'passthrough', false));
