import { Client, Logger, Thing, make, Base, User, Item, Props, load } from '@lib/lib';
import { ApiClient } from '../types/api';
import { ns } from '../ns/index';
import CC = require('../lib/cc');
import AppD from '../lib/appdef';
import { Core } from '@org/core';
import { Thing as Thing2 } from 'lib/lib';
import Anon from '../lib/anon';

export async function d1(client: Client) { const { data } = await client.get('/x'); return data; }
export function bare() { const t = make(); t.a(); }
export class Comp extends Base<User> {
  private readonly logger = new Logger();
  handleClick = () => { this.load(); };
  load() { this.logger.log('load'); }
  build() { return { inner() { return 1; } }; }
  run() { return this.inner(); }
  sup() { return super.describe(); }
}
export abstract class Shape {
  abstract area(): number;
  describe() { return this.area(); }
}
export function useComp(c: Comp) { c.userMethod(); }
export function loop(items: Item[]) { for (const item of items) item.render(); }
export function props({ items, store }: Props) { store.a(); items.forEach((it) => it.render()); }
export function shadow() { const load = () => 3; return load(); }
export function callsLoad() { return load(); }
export function viaNs() { ns.fa(); }
export function viaRequire() { new CC().cm(); }
export function viaDefault() { new AppD().run(); }
export function viaExports() { new Core().boot(); }
export function viaBaseUrl() { new Thing2().a(); }
export function viaDts(client: ApiClient) { client.fetch(); }
export function viaAnon() { return Anon(); }
export const single = (x: Thing) => x.a();
