// @devdock/core — transport-free service layer.
// Modules land here in Phase 1: registry, reconciler, supervisor,
// ptyBroker, logTailer, crashWatch, stateStore.

/** Reconciled lifecycle state of a repo's workload (see spec §6). */
export type RepoStatus = 'RUNNING_MANAGED' | 'RUNNING_EXTERNAL' | 'CRASHED' | 'STOPPED'

export const version = '0.0.0'
