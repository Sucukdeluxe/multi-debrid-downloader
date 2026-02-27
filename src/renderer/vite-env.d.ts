/// <reference types="vite/client" />

import type { ElectronApi } from "../shared/preload-api";

declare global {
  interface Window {
    rd: ElectronApi;
  }
}

export {};
