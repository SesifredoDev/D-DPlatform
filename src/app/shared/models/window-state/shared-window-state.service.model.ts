export interface SharedStateEnvelope<T = unknown> {
  key: string;
  value: T | null;
  sourceId: string;
  updatedAt: number;
  sequence: number;
}

export type SharedStateMessage<T = unknown> =
  | ({ type: 'state' } & SharedStateEnvelope<T>)
  | { type: 'state-request'; sourceId: string; requestedAt: number };
