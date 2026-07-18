export class TaskTracker {
  constructor() {
    this.accepting = true;
    this.tasks = new Set();
  }

  start(factory) {
    if (!this.accepting) return null;
    return this.track(Promise.resolve().then(factory));
  }

  track(task) {
    const promise = Promise.resolve(task);
    this.tasks.add(promise);
    promise.then(
      () => this.tasks.delete(promise),
      () => this.tasks.delete(promise),
    );
    return promise;
  }

  stopAccepting() {
    this.accepting = false;
  }

  async waitForIdle(timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (this.tasks.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;

      let timeout;
      const timedOut = new Promise((resolve) => {
        timeout = setTimeout(() => resolve(true), remaining);
      });
      const completed = Promise.allSettled([...this.tasks]).then(() => false);
      const didTimeOut = await Promise.race([completed, timedOut]);
      globalThis.clearTimeout(timeout);
      if (didTimeOut) return false;
    }

    return true;
  }
}

export class KeyedTaskQueue {
  constructor() {
    this.tails = new Map();
  }

  run(key, task) {
    const previous = this.tails.get(key) || Promise.resolve();
    const current = previous.then(task);
    const tail = current.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    this.tails.set(key, tail);
    return current;
  }
}

export class KeyedDrainCoordinator {
  constructor(drain) {
    this.drain = drain;
    this.states = new Map();
  }

  request(key) {
    const existing = this.states.get(key);
    if (existing) {
      existing.dirty = true;
      return existing.promise;
    }

    const state = { dirty: false, promise: null };
    state.promise = this.#run(key, state).finally(() => {
      if (this.states.get(key) === state) this.states.delete(key);
    });
    this.states.set(key, state);
    return state.promise;
  }

  async #run(key, state) {
    let processed = 0;

    do {
      state.dirty = false;
      const result = await this.drain(key);
      processed += result.processed;
      if (result.retryLater) break;
    } while (state.dirty);

    return processed;
  }
}
