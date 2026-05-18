import { Injectable } from '@angular/core';
import type { Open5eDocumentReference, Open5eSearchResult, Open5eSearchResponse, Open5eDetail } from '../../models/open5e-api/open5e-api.service.model';
export type { Open5eDocumentReference, Open5eSearchResult, Open5eDetail } from '../../models/open5e-api/open5e-api.service.model';
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
