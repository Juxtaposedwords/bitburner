import { ServerMetadata } from "functional/types/serverMetadata";

// 1. Define the strict Enum
export enum ActionType {
  METADATA_UPDATE = "METADATA_UPDATE",
  METADATA_PATCH = "METADATA_PATCH",
}

// 2. Use the Enum in your action types
export type MetadataUpdateAction = {
  type: ActionType.METADATA_UPDATE;
  payload: ServerMetadata;
};

export type MetadataPatchAction = {
  type: ActionType.METADATA_PATCH;
  payload: { hostname: string } & Partial<ServerMetadata>; 
};

// 3. Export the union
export type Action = MetadataUpdateAction | MetadataPatchAction;