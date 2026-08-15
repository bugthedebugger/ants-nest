import type { AntsNestApi } from "../shared/types";

declare global {
  interface Window { antsNest: AntsNestApi; }
}
export {};
