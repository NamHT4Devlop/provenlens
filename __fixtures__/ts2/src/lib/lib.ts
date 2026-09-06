export class Client { get(path: string): Promise<{ data: string }> { return null as any; } }
export class Logger { log(m: string) {} }
export class Thing { a() {} }
export function make(): Thing { return new Thing(); }
export class User { userMethod() {} }
export class Base<T> { baseMethod() {} describe() { return 1; } }
export class Item { render() {} }
export interface Props { items: Item[]; store: Thing }
export function load() { return 'exported'; }
