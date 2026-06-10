import type { ZodRawShape } from "zod";
import type { Config } from "./config/configSchema.ts";
import type { DomainName } from "./constants.ts";

export type { DomainName };

export interface ToolModule {
  name: string;
  description: string;
  inputShape: ZodRawShape;
  domain: DomainName;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface ResourceModule {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: () => Promise<unknown>;
}

export interface DomainIndexStatus {
  available: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface DomainPlugin {
  name: DomainName;
  tools: ToolModule[];
  resources?: ResourceModule[];
  /** Snapshot of the domain's local index health for index://status. */
  getIndexStatus?: () => Promise<DomainIndexStatus>;
}

export type DomainLoader = (config: Config) => Promise<DomainPlugin>;
