import { createContext } from "react-router";

export interface CloudflareAppContext {
  env: Env;
  ctx: ExecutionContext;
}

export const cloudflareContext = createContext<CloudflareAppContext>();
