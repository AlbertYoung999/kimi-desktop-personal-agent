/** builtin widget registry, synced from the workbench renderer at startup. */

export interface WidgetDef {
  id: string;
  name: string;
  description: string;
}

let registry: WidgetDef[] = [];

export function setWidgetRegistry(defs: WidgetDef[]): void {
  registry = defs;
}

export function getWidgetRegistry(): WidgetDef[] {
  return registry;
}
