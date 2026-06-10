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
export {
  Supervisor,
  shellQuote,
  type Runner,
  type StreamRunner,
  type LineSink,
} from './supervisor.js'
export { Reconciler, deriveStatus, parsePods, matchPods } from './reconciler.js'
export {
  LogTailer,
  FileTail,
  LogHub,
  RingBuffer,
  type LogSubscriber,
  type SpawnFn,
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
export {
  Service,
  type ServiceOptions,
  type ServiceDeps,
} from './service.js'
export {
  checkTools,
  missingToolWarnings,
  DEFAULT_TOOLS,
  type ToolCheck,
  type ToolStatus,
} from './preflight.js'

export const version = '0.0.0'
