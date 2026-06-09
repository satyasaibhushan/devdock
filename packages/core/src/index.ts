// @devdock/core — transport-free service layer.
// Everything else (daemon HTTP/WS, MCP) is a thin caller of these.

export * from './types.js'
export * from './exec.js'
export { StateStore, type Grant } from './stateStore.js'
export {
  scanRepos,
  parseDevspaceConfig,
  sessionName,
  type ScanOptions,
} from './registry.js'
export { Supervisor, shellQuote, type Runner } from './supervisor.js'
export { Reconciler, deriveStatus, parsePods } from './reconciler.js'
export {
  LogTailer,
  LogHub,
  RingBuffer,
  type LogSubscriber,
} from './logTailer.js'
export {
  PtyBroker,
  WriteLock,
  attachArgs,
  type PtyLike,
  type PtySpawn,
  type TermSession,
} from './ptyBroker.js'
export {
  CrashWatch,
  looksLikeTraceback,
  detectPodCrashes,
  type CrashEvent,
  type CrashListener,
} from './crashWatch.js'

export const version = '0.0.0'
