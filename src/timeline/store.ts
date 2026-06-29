import type { ArchiveData } from "../data/generate";
import type { ProgrammeInstance } from "../data/types";
import { Camera } from "./camera";

// Minimal observable store for UI state that both React (chrome) and the
// PixiJS renderer need to read. Camera lives here too; interaction mutates it
// in place and the renderer reads it every frame.

export interface ExplorerState {
  query: string;
  showNews: boolean;
  dimRestricted: boolean;
  selected: ProgrammeInstance | null;
}

export class Store {
  camera = new Camera();
  state: ExplorerState = {
    query: "",
    showNews: false,
    dimRestricted: false,
    selected: null,
  };

  /** Ids matching the current query (for bar highlight). */
  matchedIds: Set<string> = new Set();
  /** Matching programmes sorted by start (for aggregate-zoom hit markers). */
  matchedSorted: ProgrammeInstance[] = [];

  private listeners = new Set<() => void>();
  private data: ArchiveData;

  constructor(data: ArchiveData) {
    this.data = data;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  setQuery(query: string) {
    this.state = { ...this.state, query };
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      this.matchedIds = new Set();
      this.matchedSorted = [];
    } else {
      const matched = this.data.programmes.filter((p) => p.search.includes(q));
      this.matchedIds = new Set(matched.map((p) => p.id));
      this.matchedSorted = matched; // already sorted by start
    }
    this.emit();
  }

  patch(partial: Partial<ExplorerState>) {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  select(p: ProgrammeInstance | null) {
    this.state = { ...this.state, selected: p };
    this.emit();
  }
}
