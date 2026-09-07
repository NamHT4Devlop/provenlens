// `thing` has no annotation and no value to infer from, so `thing.run(1)` is
// a call the resolver cannot place: two classes declare `run`.
export function go(thing) {
  return thing.run(1);
}
