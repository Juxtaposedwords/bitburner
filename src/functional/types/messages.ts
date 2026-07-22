import { ServerMetadata } from "functional/types/serverMetadata";

export type Action = 
  | { type: "METADATA_UPDATE"; payload: ServerMetadata }
  | { type: "METADATA_BATCH_UPDATE"; payload: ServerMetadata[] };