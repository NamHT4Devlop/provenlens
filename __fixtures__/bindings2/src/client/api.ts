import { api } from './axios';

export class OrdersService {
  constructor(private readonly http: { get(url: string): Promise<unknown> }) {}
  list() { return this.http.get('/api/orders/1'); }
}

export function loadItems() {
  return api.get('/items', { params: { page: 1 } });
}
