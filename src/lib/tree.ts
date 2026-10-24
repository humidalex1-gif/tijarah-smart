/**
 * Adjacency-list tree helpers.
 *
 * This codebase stores three trees — `ProductCategory`, `ExpenseCategory`, and
 * (from Stage 2B) `WarehouseLocation` — as a nullable `parentId` and nothing
 * else. There is no path column, no depth column, and no recursive CTE
 * reachable through Prisma's SQLite adapter. So a subtree is resolved by
 * loading the company's nodes flat and walking them here.
 *
 * Pure functions over plain `{ id, parentId }` records on purpose: they are
 * unit-testable without a database, and every caller already has a reason to
 * do its own tenant-scoped `findMany`.
 */

export interface TreeNode {
  id: string;
  parentId: string | null;
}

/**
 * Every id at or below `rootId`, including `rootId` itself.
 *
 * Returns `[rootId]` when the root has no children, and `[]` when `rootId` is
 * not among `nodes` — an id from another company, or a stale one, resolves to
 * nothing rather than to everything, which is the safe direction for a
 * caller that feeds the result into a `where` clause.
 *
 * A corrupt parent chain cannot hang the walk: `seen` makes a cycle
 * terminate. Nothing in the app can currently create one (no reparent
 * operation exists), but a walk that loops forever on bad data is a worse
 * failure than one that stops early, and Stage 2B adds the reparent that
 * makes cycles reachable.
 */
export function collectSubtreeIds(nodes: readonly TreeNode[], rootId: string): string[] {
  if (!nodes.some((n) => n.id === rootId)) return [];

  const childrenOf = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = childrenOf.get(node.parentId);
    if (siblings) siblings.push(node.id);
    else childrenOf.set(node.parentId, [node.id]);
  }

  const collected: string[] = [];
  const seen = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    collected.push(id);
    const children = childrenOf.get(id);
    if (children) queue.push(...children);
  }
  return collected;
}

/**
 * True when making `newParentId` the parent of `nodeId` would create a cycle —
 * i.e. `newParentId` is `nodeId` itself, or sits somewhere below it.
 *
 * Stage 2B's location reparent needs this. Categories have no reparent
 * operation today, which is the only reason the existing trees have never
 * needed a guard.
 */
export function wouldCreateCycle(
  nodes: readonly TreeNode[],
  nodeId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return false;
  return collectSubtreeIds(nodes, nodeId).includes(newParentId);
}
