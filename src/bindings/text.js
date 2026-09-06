/**
 * Small text helpers the plugins share: line numbers without re-splitting a
 * file per hit, and the attributes of an annotation without re-reading it.
 */

/**
 * A line-number function for one text, built once.
 *
 * Every plugin used to slice the file up to the hit and split it on newlines
 * for each statement it found -- O(statements x file size). One 880 KB mapper
 * holding ten thousand statements spent ten seconds in that alone.
 */
export function lineIndex(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Every string literal in a piece of Java annotation text, in order. */
const STRINGS = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;

/**
 * The string values an annotation gives to one of `names`, or -- when none
 * of them is written -- the values given with no name at all.
 *
 * `@KafkaListener(topics = {"a", "b"}, groupId = "g")` answers `["a", "b"]`
 * for `topics`; `@SqsListener("orders")` answers `["orders"]` for anything.
 * `str_args` alone cannot tell the two attributes apart, which is how a group
 * id became a topic and a listener factory became a queue.
 */
export function attributeStrings(raw, names) {
  const text = String(raw ?? '');
  for (const name of names) {
    const named = new RegExp(`(?:^|[,(\\s])${name}\\s*=\\s*(\\{[^}]*\\}|"(?:[^"\\\\]|\\\\.)*")`).exec(text);
    if (named) return [...named[1].matchAll(STRINGS)].map((m) => m[1]);
  }
  // Positional: the whole text is one value, or an array of them, and no
  // attribute name precedes it. Anything after an `=` belongs to some named
  // attribute and is not positional.
  const trimmed = text.trim();
  if (!trimmed || /^[A-Za-z_]\w*\s*=/.test(trimmed)) return [];
  return [...trimmed.matchAll(STRINGS)].map((m) => m[1]);
}

/** A bare identifier or enum attribute: `method = RequestMethod.POST` -> `POST`. */
export function attributeIdentifiers(raw, name) {
  const named = new RegExp(`(?:^|[,(\\s])${name}\\s*=\\s*(\\{[^}]*\\}|[\\w.]+)`).exec(String(raw ?? ''));
  if (!named) return [];
  return [...named[1].matchAll(/[A-Za-z_]\w*/g)].map((m) => m[0]);
}
