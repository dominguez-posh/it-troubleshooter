import { clipboard, contextBridge, ipcRenderer } from 'electron';
import { IPC, type ChatApi } from '../shared/types';

const inv = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;

/** Schmale API des Begleit-Chatfensters. */
const api: ChatApi = {
  getState: () => inv(IPC.chatState),
  report: (outcome, comment) => inv(IPC.chatReport, outcome, comment),
  addNote: (text) => inv(IPC.chatAddNote, text),
  reactRecommendation: (response, comment, ack) => inv(IPC.chatReact, response, comment, ack),
  setServerAccess: (access) => inv(IPC.chatServerAccess, access),
  retryLast: () => inv(IPC.chatRetry),
  abortRequest: (manual) => inv(IPC.chatAbort, manual),
  copyText: (text) => {
    if (typeof text === 'string' && text.length <= 4000) clipboard.writeText(text);
  },
  startCall: () => inv(IPC.chatStartCall),
  callInput: (text, question) => inv(IPC.chatCallInput, text, question),
  endCall: (toTriage) => inv(IPC.chatEndCall, toTriage),
  setReevaluate: (value) => inv(IPC.chatSetReevaluate, value),
  moveWindow: (req) => inv(IPC.chatMove, req),
  setHistoryExpanded: (expanded) => inv(IPC.chatHistory, expanded),
  close: () => inv(IPC.chatClose),
  onSessionChanged: (cb) => {
    ipcRenderer.on(IPC.sessionChanged, (_e, v) => cb(v));
  },
  onFocusInput: (cb) => {
    ipcRenderer.on(IPC.chatFocusInput, () => cb());
  },
};

contextBridge.exposeInMainWorld('chatApi', api);
