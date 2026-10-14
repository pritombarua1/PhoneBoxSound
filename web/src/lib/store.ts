import { useSyncExternalStore } from "react";

/**
 * Minimal external store. Components subscribe to a *slice* (selector), so a volume-meter update
 * or a stats tick never re-renders parts of the UI that don't use it.
 */
export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === "function" ? patch(state) : patch;
      let changed = false;
      for (const k in p) if (!Object.is(state[k], p[k])) { changed = true; break; }
      if (!changed) return;
      state = { ...state, ...p };
      subs.forEach((fn) => fn());
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

/** Select a slice. The selector must return a stable reference (a field of the state, or a primitive). */
export function useStore<T, R>(store: Store<T>, selector: (s: T) => R): R {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
