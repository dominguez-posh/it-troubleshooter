import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type RendererApi } from '../shared/types';

/** Schmale, typisierte Brücke. Der Renderer bekommt nie Node, ipcRenderer oder Keys. */
const api: RendererApi = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  setApiKey: (providerId, key) => ipcRenderer.invoke(IPC.setApiKey, providerId, key),
  clearApiKey: (providerId) => ipcRenderer.invoke(IPC.clearApiKey, providerId),
  listModels: (providerId) => ipcRenderer.invoke(IPC.listModels, providerId),
  listSources: () => ipcRenderer.invoke(IPC.listSources),
  startSession: (problem, sourceId) => ipcRenderer.invoke(IPC.startSession, problem, sourceId),
  reportStep: (outcome, comment) => ipcRenderer.invoke(IPC.reportStep, outcome, comment),
  markSolved: () => ipcRenderer.invoke(IPC.markSolved),
  resetSession: () => ipcRenderer.invoke(IPC.resetSession),
  toggleOverlay: () => ipcRenderer.invoke(IPC.toggleOverlay),
};

contextBridge.exposeInMainWorld('itt', api);
