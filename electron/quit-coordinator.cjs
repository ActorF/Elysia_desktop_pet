'use strict';

/** Stop accepting work once, then allow Electron to quit after owned work drains. */
function createQuitCoordinator({ prepare, drain, finish, onError = () => {} }) {
  let started = false, complete = false, pending = null;
  function report(error) { try { onError(error); } catch {} }
  function beforeQuit(event) {
    if (complete) return;
    event.preventDefault();
    if (started) return pending;
    started = true;
    try { prepare(); } catch (error) { report(error); }
    pending = Promise.resolve().then(drain).catch(report).then(() => {
      complete = true;
      finish();
    });
    return pending;
  }
  return { beforeQuit };
}

module.exports = { createQuitCoordinator };
