/**
 * Undo steps that address list items by id, not by position.
 *
 * Analysis results, new clips of a round and other server merges change the document without
 * an undo step (`silently`), and they insert and re-sort shots and clips. Immer's patches
 * address array items by index, so an undo recorded before such a merge would land on another
 * shot or clip. Instead each edit is diffed into operations whose paths name list items by id
 * (`{ id }`), where the list holds objects with ids; inserts remember the item before them and
 * re-ordering is replayed among the items it moved. An item a merge removed meanwhile is
 * skipped; items a merge added stay where they are.
 *
 * Lists of plain values or of objects without ids (keyframes, track points) are replaced as a
 * whole, as are values whose shape changed.
 */
import { produce } from 'immer';

export type Seg = string | number | { id: string };

export type Op =
  /** `container[key] = value` (the container found at `path`). */
  | { op: 'set'; path: Seg[]; key: string | number; value: unknown }
  | { op: 'del'; path: Seg[]; key: string | number }
  /** Remove the item with this id from the list at `path`. */
  | { op: 'remove'; path: Seg[]; id: string }
  /** Insert the item after the one with id `after` (null = first); `index` when that one is gone. */
  | { op: 'insert'; path: Seg[]; value: { id: string }; after: string | null; index: number }
  /** Put these items (where present) into the order given, in the slots they occupy. */
  | { op: 'order'; path: Seg[]; ids: string[] };

export interface Change {
  forward: Op[];
  inverse: Op[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lists diffed by item id: every item is an object with a string id, unique in the list. */
function idList(a: unknown[], b: unknown[]): boolean {
  if (!a.length && !b.length) return false;
  for (const list of [a, b]) {
    const seen = new Set<string>();
    for (const x of list) {
      if (!isObj(x) || typeof x.id !== 'string' || seen.has(x.id)) return false;
      seen.add(x.id);
    }
  }
  return true;
}

/** The operations that turn `a` into `b` (and back). Unchanged subtrees (===) are skipped. */
export function diff<T extends object>(a: T, b: T): Change {
  const forward: Op[] = [];
  const inverse: Op[] = [];
  diffObject(a as Obj, b as Obj, [], forward, inverse);
  // The inverse runs back to front: what was done last is undone first.
  return { forward, inverse: inverse.reverse() };
}

function diffValue(a: unknown, b: unknown, path: Seg[], key: string | number, fwd: Op[], inv: Op[]) {
  if (a === b) return;
  if (isObj(a) && isObj(b)) return diffObject(a, b, [...path, key], fwd, inv);
  if (Array.isArray(a) && Array.isArray(b) && idList(a, b)) return diffList(a as Obj[], b as Obj[], [...path, key], fwd, inv);
  fwd.push(b === undefined ? { op: 'del', path, key } : { op: 'set', path, key, value: b });
  inv.push(a === undefined ? { op: 'del', path, key } : { op: 'set', path, key, value: a });
}

function diffObject(a: Obj, b: Obj, path: Seg[], fwd: Op[], inv: Op[]) {
  for (const k of Object.keys(a)) diffValue(a[k], b[k], path, k, fwd, inv);
  for (const k of Object.keys(b)) if (!(k in a)) diffValue(undefined, b[k], path, k, fwd, inv);
}

function diffList(a: Obj[], b: Obj[], path: Seg[], fwd: Op[], inv: Op[]) {
  const id = (x: Obj) => x.id as string;
  const inA = new Map(a.map((x) => [id(x), x]));
  const inB = new Map(b.map((x) => [id(x), x]));
  // Removed items, the last first (their re-inserts on undo then run first to last).
  for (let i = a.length - 1; i >= 0; i--) {
    if (inB.has(id(a[i]))) continue;
    fwd.push({ op: 'remove', path, id: id(a[i]) });
    inv.push({ op: 'insert', path, value: a[i] as { id: string }, after: i ? id(a[i - 1]) : null, index: i });
  }
  // Items in both lists that changed places.
  const oldOrder = a.map(id).filter((x) => inB.has(x));
  const newOrder = b.map(id).filter((x) => inA.has(x));
  if (oldOrder.some((x, i) => x !== newOrder[i])) {
    fwd.push({ op: 'order', path, ids: newOrder });
    inv.push({ op: 'order', path, ids: oldOrder });
  }
  // Added items, first to last (each lands after the one before it).
  b.forEach((x, j) => {
    if (inA.has(id(x))) return;
    fwd.push({ op: 'insert', path, value: x as { id: string }, after: j ? id(b[j - 1]) : null, index: j });
    inv.push({ op: 'remove', path, id: id(x) });
  });
  // Items in both: by id.
  for (const x of b) {
    const old = inA.get(id(x));
    if (old && old !== x) diffObject(old, x, [...path, { id: id(x) }], fwd, inv);
  }
}

function resolve(root: unknown, path: Seg[]): unknown {
  let cur = root;
  for (const s of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (typeof s === 'object') cur = Array.isArray(cur) ? cur.find((x) => isObj(x) && x.id === s.id) : undefined;
    else cur = (cur as Obj)[s as string];
  }
  return cur;
}

/** Applies operations to the document; ones whose target is gone are skipped. */
export function applyOps<T extends object>(doc: T, ops: Op[]): T {
  if (!ops.length) return doc;
  return produce(doc, (d) => {
    for (const o of ops) {
      const c = resolve(d, o.path);
      if (c == null || typeof c !== 'object') continue;
      if (o.op === 'set') (c as Obj)[o.key as string] = o.value;
      else if (o.op === 'del') {
        if (Array.isArray(c)) c.splice(o.key as number, 1);
        else delete (c as Obj)[o.key as string];
      } else if (!Array.isArray(c)) continue;
      else if (o.op === 'remove') {
        const i = c.findIndex((x) => x?.id === o.id);
        if (i >= 0) c.splice(i, 1);
      } else if (o.op === 'insert') {
        // A merge may have brought the same item back meanwhile.
        if (c.some((x) => x?.id === o.value.id)) continue;
        const after = o.after == null ? -1 : c.findIndex((x) => x?.id === o.after);
        const at = o.after == null ? 0 : after >= 0 ? after + 1 : Math.min(o.index, c.length);
        c.splice(at, 0, o.value);
      } else {
        const want = o.ids.filter((x) => c.some((y) => y?.id === x));
        const slots = c.map((x, i) => (want.includes(x?.id) ? i : -1)).filter((i) => i >= 0);
        const byId = new Map(c.map((x) => [x?.id, x]));
        slots.forEach((slot, k) => (c[slot] = byId.get(want[k])));
      }
    }
  });
}
