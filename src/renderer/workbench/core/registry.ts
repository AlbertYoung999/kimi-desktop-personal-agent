import type { WbApi } from '../../api';
import type { WidgetDefinition } from '../../../shared/workbench-types';
import type { Bus } from './bus';

export interface WidgetContext {
  instanceId: string;
  /** user overlay config (persisted via setConfig) */
  config: Record<string, unknown>;
  setConfig(patch: Record<string, unknown>): void;
  bus: Bus;
  api: WbApi;
  requestMinimize(): void;
  requestClose(): void;
}

export interface BuiltinWidget {
  def: WidgetDefinition;
  mount(body: HTMLElement, ctx: WidgetContext): void;
}

const registry = new Map<string, BuiltinWidget>();

export function registerWidget(w: BuiltinWidget): void {
  registry.set(w.def.id, w);
}

export function getWidget(id: string): BuiltinWidget | undefined {
  return registry.get(id);
}

export function allWidgets(): BuiltinWidget[] {
  return [...registry.values()];
}
