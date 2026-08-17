/** Tiny pub/sub event bus for inter-widget communication. */
export type Handler = (payload: unknown) => void;

export class Bus {
  private handlers = new Map<string, Set<Handler>>();

  on(event: string, fn: Handler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
    return () => this.handlers.get(event)?.delete(fn);
  }

  emit(event: string, payload?: unknown): void {
    this.handlers.get(event)?.forEach((fn) => fn(payload));
  }
}

export const bus = new Bus();
