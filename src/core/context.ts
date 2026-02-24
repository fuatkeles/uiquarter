import type { UIQuarterConfig } from "../types/index.js";

/** Runtime context passed through the pipeline */
export interface CoreContext {
  config: UIQuarterConfig;
  startTime: number;
}

export function createContext(config: UIQuarterConfig): CoreContext {
  return {
    config,
    startTime: Date.now(),
  };
}
