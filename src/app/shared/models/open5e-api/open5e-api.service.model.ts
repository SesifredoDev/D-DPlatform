export interface Open5eDocumentReference {
  key: string;
  name: string;
  display_name?: string;
  publisher?: {
    key: string;
    name: string;
  };
  gamesystem?: {
    key: string;
    name: string;
  };
  permalink?: string;
}

export interface Open5eSearchResult {
  document?: Open5eDocumentReference;
  object_pk: string;
  object_name: string;
  object: Record<string, unknown>;
  object_model: string;
  schema_version: string;
  route: string;
  text: string;
  highlighted: string;
  match_type: string;
  matched_term: string;
  match_score: number;
}

export interface Open5eSearchResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: Open5eSearchResult[];
  search_metadata?: {
    exact_matches?: boolean;
  };
}

export type Open5eDetail = Record<string, unknown> & {
  key?: string;
  name?: string;
  desc?: string | string[];
  document?: Open5eDocumentReference;
};
