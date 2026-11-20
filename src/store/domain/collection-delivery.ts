// The stored `delivery` edge / snapshot property. Corpora no longer rank
// their documents (a corpus is a folder of files, listed by path), so
// nothing reads a tier any more — but the graph schema and the bundle
// contract still carry the field, and already-written edges and snapshots
// must stay decodable. New rows always write the default.

export const COLLECTION_DELIVERY_VALUES = ["core", "reference"] as const;
export type CollectionDelivery = (typeof COLLECTION_DELIVERY_VALUES)[number];
export const DEFAULT_COLLECTION_DELIVERY: CollectionDelivery = "core";

export function corpusDelivery(value: unknown): CollectionDelivery {
  return value === "reference" ? "reference" : DEFAULT_COLLECTION_DELIVERY;
}
