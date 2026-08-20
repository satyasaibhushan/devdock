// @devdock/core — transport-free service layer.
// Everything else (daemon HTTP/WS, MCP) is a thin caller of these.

export * from './types.js'
export {
  lifecycleActions,
  lifecyclePlan,
  type LifecycleAction,
  type LifecycleStep,
} from './lifecycle.js'
export * from './exec.js'
export { StateStore, type Grant, type ReplicaRecord } from './stateStore.js'
export {
  nextReplicaId,
  generateReplicaConfig,
  ingressPathOf,
  aliasIngressManifest,
} from './replicas.js'
export {
  scanRepos,
  parseDevspaceConfig,
  sessionName,
  type ScanOptions,
} from './registry.js'
export {
  Supervisor,
  shellQuote,
  devspaceArgs,
  type Runner,
  type StreamRunner,
  type LineSink,
} from './supervisor.js'
export {
  Reconciler,
  deriveStatus,
  parsePods,
  matchPods,
  parseDeployments,
  matchDeployments,
  newClusterCache,
  type ClusterCache,
} from './reconciler.js'
export {
  LogTailer,
  LogHub,
  RingBuffer,
  type LogSubscriber,
  type SpawnFn,
} from './logTailer.js'
export {
  PtyBroker,
  WriteLock,
  attachArgs,
  isWheelReport,
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
  type NamespaceInfo,
  type LogSource,
  type LogQueryOptions,
  type LogQueryResult,
  type WorkloadRunResult,
  type WaitOptions,
  type WaitResult,
} from './service.js'
export {
  encodeCursor,
  decodeCursor,
  readFileSlice,
  type Cursor,
  type FileSlice,
} from './logQuery.js'
export {
  checkTools,
  missingToolWarnings,
  pathShadowWarnings,
  DEFAULT_TOOLS,
  type ToolCheck,
  type ToolStatus,
} from './preflight.js'
export {
  TermRegistry,
  renderPtyText,
  RUN_MAX_TIMEOUT_MS,
  type TermInfo,
  type TermKind,
  type TermAttachTarget,
  type TermAttachment,
  type RunOutcome,
} from './termRegistry.js'
export {
  AuthManager,
  OFF_NETWORK_HINT,
  jwtExpiryMs,
  type AuthState,
  type AuthPhase,
  type AuthLoginRunner,
  type AuthRunner,
  type AuthManagerOptions,
} from './auth.js'
export {
  AwsCreds,
  type AwsCredential,
  type AwsCredsOptions,
  type WarmResult,
} from './awsCreds.js'

export const version = '0.0.0'
