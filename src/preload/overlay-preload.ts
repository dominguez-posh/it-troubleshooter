import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type OverlayPayload } from '../shared/types';

contextBridge.exposeInMainWorld('overlayApi', {
  onShow: (cb: (p: OverlayPayload) => void) => {
    ipcRenderer.on(IPC.overlayShow, (_e, p: OverlayPayload) => cb(p));
  },
});
