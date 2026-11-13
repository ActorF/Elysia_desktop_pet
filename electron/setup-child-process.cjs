'use strict';

const cancelled = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });

/** A kill request is not proof of exit. Retain ownership after a bounded wait. */
function createSetupProcessTracker({ stopTimeoutMs = 2000 } = {}) {
  if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs <= 0) throw new TypeError('A positive stop timeout is required.');
  const owned = new Map();
  function wait(child, { signal, timeoutMs, timeoutError, completionEvent = 'exit' }) {
    return new Promise((resolve, reject) => {
      let settled = false, exited = false, stopping = false, reason = null, stopTimer;
      let resolveExit;
      const exitConfirmation = new Promise(resolve => { resolveExit = resolve; });
      const owner = { pending: false, exited: false, stop }; owned.set(child, owner);
      const cleanup = () => {
        child.removeListener('error', onError); child.removeListener('exit', onExit); child.removeListener('close', onClose);
      };
      const finish = (error, code) => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(stopTimer); signal?.removeEventListener('abort', onAbort);
        if (exited) { owned.delete(child); cleanup(); }
        error ? reject(error) : resolve(code);
      };
      const overdue = () => {
        const error = reason || timeoutError();
        if (!exited) {
          owner.pending = true;
          error.preserveStage = true;
          error.setupProcessPending = true;
          Object.defineProperty(error, 'setupProcessExit', { value: exitConfirmation });
        }
        finish(error);
      };
      function stop(error) {
        if (exited) { if (!settled) { reason ||= error; overdue(); } return; }
        if (settled) { try { child.kill(); } catch {} return; }
        if (stopping) return;
        stopping = true; reason = error;
        // Arm before kill: a mocked or already-exiting process may emit inline.
        stopTimer = setTimeout(overdue, stopTimeoutMs);
        try { child.kill(); } catch {}
      }
      const onAbort = () => stop(cancelled());
      const confirmExit = () => {
        exited = true; owner.exited = true;
        resolveExit();
        if (settled) { owned.delete(child); cleanup(); return true; }
        return false;
      };
      const onExit = code => {
        if (confirmExit()) return;
        if (completionEvent === 'exit') finish(reason, code);
        // Pipe closure can lag exit. It must not keep setup busy indefinitely.
        else if (!stopTimer) stopTimer = setTimeout(overdue, stopTimeoutMs);
      };
      const onClose = code => { if (!confirmExit()) finish(reason, code); };
      const onError = error => {
        if (settled || stopping) return;
        // Spawn failures have no PID. Errors from killing a running child are
        // not evidence that its handles are closed or its staging tree is safe.
        if (!child.pid && !stopping) { confirmExit(); finish(error); }
        else stop(error);
      };
      const timer = setTimeout(() => stop(timeoutError()), timeoutMs);
      child.on('error', onError); child.on('exit', onExit); child.on('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
  return { wait, pending: () => [...owned.values()].some(owner => owner.pending && !owner.exited), owns: child => Boolean(owned.get(child) && !owned.get(child).exited),
    stopChild: (child, error) => owned.get(child)?.stop(error),
    stop: () => { for (const owner of [...owned.values()]) owner.stop(cancelled()); } };
}

module.exports = { createSetupProcessTracker };
