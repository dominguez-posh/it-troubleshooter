import { clipboard, contextBridge, ipcRenderer } from 'electron';
import { IPC, type RendererApi } from '../shared/types';

const inv = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;

/** Schmale, typisierte Brücke. Der Renderer bekommt nie Node, ipcRenderer oder Keys. */
const api: RendererApi = {
  getSettings: () => inv(IPC.getSettings),
  updateSettings: (patch) => inv(IPC.updateSettings, patch),
  setApiKey: (providerId, key) => inv(IPC.setApiKey, providerId, key),
  clearApiKey: (providerId) => inv(IPC.clearApiKey, providerId),
  listModels: (providerId) => inv(IPC.listModels, providerId),
  listSources: () => inv(IPC.listSources),

  getSession: () => inv(IPC.getSession),
  startSession: (problem) => inv(IPC.startSession, problem),
  startRemote: (sourceId) => inv(IPC.startRemote, sourceId),
  askFirst: () => inv(IPC.askFirst),
  addNote: (text) => inv(IPC.addNote, text),
  reactRecommendation: (response, comment, ack) => inv(IPC.react, response, comment, ack),
  setServerAccess: (access) => inv(IPC.serverAccess, access),
  retryLast: () => inv(IPC.retryLast),
  abortRequest: (manual) => inv(IPC.abortRequest, manual),
  copyText: (text) => {
    if (typeof text === 'string' && text.length <= 4000) clipboard.writeText(text);
  },
  costAction: (a) => inv(IPC.costAction, a),
  startCall: () => inv(IPC.startCall),
  callInput: (text, question) => inv(IPC.callInput, text, question),
  endCall: (toTriage) => inv(IPC.endCall, toTriage),
  reportStep: (outcome, comment) => inv(IPC.reportStep, outcome, comment),
  finishSession: (result) => inv(IPC.finishSession, result),
  pauseSession: () => inv(IPC.pauseSession),
  setTimerRunning: (running) => inv(IPC.setTimerRunning, running),
  resetSession: () => inv(IPC.resetSession),
  toggleOverlay: () => inv(IPC.toggleOverlay),
  openChat: () => inv(IPC.openChat),
  onSessionChanged: (cb) => {
    ipcRenderer.on(IPC.sessionChanged, (_e, v) => cb(v));
  },

  listIncidents: () => inv(IPC.listIncidents),
  getIncident: (id) => inv(IPC.getIncident, id),
  updateIncident: (id, patch) => inv(IPC.updateIncident, id, patch),
  setIncidentStatus: (id, status) => inv(IPC.setIncidentStatus, id, status),
  setIncidentDuration: (id, minutes) => inv(IPC.setIncidentDuration, id, minutes),
  deleteIncident: (id) => inv(IPC.deleteIncident, id),
  resumeIncident: (id, reason) => inv(IPC.resumeIncident, id, reason),
  finishIncident: (id, result) => inv(IPC.finishIncident, id, result),

  prepareTimeEntry: (incidentId, result) => inv(IPC.prepareTimeEntry, incidentId, result),
  saveTimeEntry: (draft) => inv(IPC.saveTimeEntry, draft),
  listTimeEntries: () => inv(IPC.listTimeEntries),
  setTimeEntriesStatus: (ids, status) => inv(IPC.setTimeEntriesStatus, ids, status),
  deleteTimeEntry: (id) => inv(IPC.deleteTimeEntry, id),
  exportTimeEntriesCsv: (ids) => inv(IPC.exportTimeEntriesCsv, ids),
};

contextBridge.exposeInMainWorld('itt', api);
