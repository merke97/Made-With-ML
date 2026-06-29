import { useSyncExternalStore } from "react";
import type { ExplorerState, Store } from "../timeline/store";

/** Subscribe React chrome to the store's UI state. */
export function useExplorerState(store: Store): ExplorerState {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.state,
  );
}
