import { ServerMetadata } from "/functional/types/serverMetadata.js";

export type Action = 
  | { type: "METADATA_UPDATE"; payload: ServerMetadata }
  | { type: "METADATA_BATCH_UPDATE"; payload: ServerMetadata[] };