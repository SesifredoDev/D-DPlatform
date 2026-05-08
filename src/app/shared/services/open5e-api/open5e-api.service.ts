import { Injectable } from '@angular/core';

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

interface Open5eSearchResponse {
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

@Injectable({
  providedIn: 'root',
})
export class Open5eApiService {
  private readonly baseUrl = 'https://api.open5e.com';
  private readonly apiRoot = `${this.baseUrl}/v2`;
  private readonly searchCache = new Map<string, Open5eSearchResult[]>();
  private readonly detailCache = new Map<string, Open5eDetail>();

  async search(query: string, limit = 50): Promise<Open5eSearchResult[]> {
    const normalizedQuery = query.trim();

    if (!normalizedQuery) {
      return [];
    }

    const cacheKey = `${normalizedQuery.toLowerCase()}::${limit}`;
    const cached = this.searchCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const url = new URL(`${this.apiRoot}/search/`);
    url.searchParams.set('query', normalizedQuery);
    url.searchParams.set('limit', `${limit}`);

    const response = await this.fetchJson<Open5eSearchResponse>(url.toString());
    this.searchCache.set(cacheKey, response.results);
    return response.results;
  }

  async getDetail(result: Open5eSearchResult): Promise<Open5eDetail> {
    const url = this.getExternalUrl(result);
    const cached = this.detailCache.get(url);

    if (cached) {
      return cached;
    }

    const detail = await this.fetchJson<Open5eDetail>(url);
    this.detailCache.set(url, detail);
    return detail;
  }

  getExternalUrl(result: Open5eSearchResult): string {
    const route = result.route.startsWith('/') ? result.route.slice(1) : result.route;
    const normalizedRoute = route.endsWith('/') ? route : `${route}/`;
    return `${this.baseUrl}/${normalizedRoute}${encodeURIComponent(result.object_pk)}/`;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Open5e returned ${response.status} for ${url}`);
    }

    return response.json() as Promise<T>;
  }
}
