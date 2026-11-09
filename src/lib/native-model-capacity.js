/** Diagnostic environment opt-in; persisted provider capacity is normalized separately. */
export function readNativeModelCapacity(environment) {
  const raw=environment.DIH_CODEX_NATIVE_MAX_CONCURRENT_TURNS;
  if(raw!==undefined && (typeof raw!=='string' || !/^[1-4]$/u.test(raw)))throw new TypeError('Native model capacity is invalid');
  const maxConcurrentTurns=raw===undefined?1:Number(raw);
  const allowConcurrentNativeHome=environment.DIH_CODEX_NATIVE_CONCURRENCY_VALIDATED==='true';
  if(maxConcurrentTurns>1 && !allowConcurrentNativeHome)throw new TypeError('Native model concurrency requires explicit deployment validation');
  return {maxConcurrentTurns,allowConcurrentNativeHome};
}
