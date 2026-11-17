import {
  ArcDefinition,
  EntityRecord,
  EntityType,
  ImportanceTier,
  RelationCategory,
  RelationRecord,
  ResolvedLink,
  ResolvedNode,
} from '../types/graph';

export interface FilterOptions {
  selectedArcs: string[]; // Non-empty list of active arc IDs
  maxImportanceTier: ImportanceTier; // 'core' | 'supporting' | 'minor' (all)
  enabledEntityTypes: Set<EntityType>;
  enabledCategories: Set<RelationCategory>;
  collapsedGroupIds: Set<string>;
  egoSubgraphCenterId?: string | null; // Optional 1.5-hop filter for mini mode
}

const IMPORTANCE_RANK: Record<ImportanceTier, number> = {
  core: 1,
  supporting: 2,
  minor: 3,
};

export interface ResolvedGraph {
  nodes: ResolvedNode[];
  links: ResolvedLink[];
  nodeMap: Map<string, ResolvedNode>;
}

/**
 * Resolves the active subgraph for the selected Series/Arc Layer(s):
 * 1. Strict Arc Boundary: only entities participating in `selectedArcs` appear,
 *    and only relations active in `selectedArcs` whose BOTH endpoints are in the active set appear.
 * 2. Profile Evolution: applies the latest active arc's override (name, title, avatar, org).
 * 3. Relationship Evolution: if edge B `supersedesId` edge A and both are in selectedArcs
 *    (e.g. "All Zemuria" mode), renders the latest edge B as primary with `priorLabel` metadata!
 * 4. Multi-Edge Routing: assigns distinct curvature & curveRotation for parallel links.
 */
export function resolveGraph(
  arcs: ArcDefinition[],
  entities: EntityRecord[],
  relations: RelationRecord[],
  filters: FilterOptions
): ResolvedGraph {
  const arcOrder = new Map(arcs.map((a) => [a.id, a.order]));
  const activeArcSet = new Set(filters.selectedArcs);

  // Sort active arcs chronologically so latest arc wins overrides
  const orderedActiveArcs = [...filters.selectedArcs].sort(
    (a, b) => (arcOrder.get(a) ?? 0) - (arcOrder.get(b) ?? 0)
  );

  const evolvedEntityIds = new Set<string>();
  const relationById = new Map(relations.map((r) => [r.id, r]));
  for (const r of relations) {
    if (r.supersedesId) {
      evolvedEntityIds.add(r.source);
      evolvedEntityIds.add(r.target);
    }
  }

  // 1. Filter and resolve entities within arc boundary & type filters
  const preliminaryNodes: ResolvedNode[] = [];
  for (const entity of entities) {
    if (!filters.enabledEntityTypes.has(entity.entityType)) continue;
    const inActiveArc = entity.arcs.some((a) => activeArcSet.has(a));
    if (!inActiveArc) continue;

    let name = entity.canonicalName;
    let title = entity.defaultTitle;
    let avatarUrl = entity.defaultAvatarUrl;
    let primaryGroupId = entity.defaultGroupId;
    let importance: ImportanceTier =
      entity.importance ?? (entity.entityType === 'character' ? 'core' : 'core');
    let bio = entity.bio;

    if (entity.arcOverrides) {
      for (const arcId of orderedActiveArcs) {
        const ov = entity.arcOverrides[arcId];
        if (!ov) continue;
        if (ov.displayName) name = ov.displayName;
        if (ov.title) title = ov.title;
        if (ov.avatarUrl) avatarUrl = ov.avatarUrl;
        if (ov.primaryGroupId) primaryGroupId = ov.primaryGroupId;
        if (ov.importance) importance = ov.importance;
        if (ov.bio) bio = ov.bio;
      }
    }

    if (
      (IMPORTANCE_RANK[importance] ?? 2) > (IMPORTANCE_RANK[filters.maxImportanceTier] ?? 2) &&
      entity.id !== filters.egoSubgraphCenterId
    ) {
      continue;
    }

    // Hide character if its primary organization is collapsed by user
    if (
      entity.entityType === 'character' &&
      primaryGroupId &&
      filters.collapsedGroupIds.has(primaryGroupId)
    ) {
      continue;
    }

    const hasOverrideKeys = Boolean(
      entity.arcOverrides && Object.keys(entity.arcOverrides).length > 0
    );

    preliminaryNodes.push({
      id: entity.id,
      name,
      canonicalName: entity.canonicalName,
      nameEn: entity.nameEn,
      entityType: entity.entityType,
      subtype: entity.subtype,
      title,
      avatarUrl,
      importance,
      wpPostId: entity.wpPostId,
      wikiUrl: entity.wikiUrl,
      nationId: entity.nationId,
      primaryGroupId,
      bio,
      arcs: entity.arcs,
      hasEvolution: hasOverrideKeys || evolvedEntityIds.has(entity.id),
      isBridgeNode: entity.arcs.length > 1,
      degree: 0,
      raw: entity,
    });
  }

  const nodeMap = new Map(preliminaryNodes.map((n) => [n.id, n]));

  // 2. Filter relations strictly bounded to active nodes & active arcs
  const candidateRelations = relations.filter((rel) => {
    if (rel.status && rel.status !== 'published') return false;
    if (!filters.enabledCategories.has(rel.category)) return false;
    if (!nodeMap.has(rel.source) || !nodeMap.has(rel.target)) return false;
    return rel.arcs.some((a) => activeArcSet.has(a));
  });

  // 3. Handle superseded relations when viewing multiple arcs simultaneously (including transitive chains)
  const candidateMap = new Map(candidateRelations.map((r) => [r.id, r]));
  const supersededIdsInView = new Set<string>();
  for (const rel of candidateRelations) {
    let currId: string | undefined = rel.supersedesId;
    const visited = new Set<string>([rel.id]);
    while (currId && !visited.has(currId)) {
      visited.add(currId);
      if (candidateMap.has(currId)) {
        supersededIdsInView.add(currId);
      }
      currId = relationById.get(currId)?.supersedesId;
    }
  }

  const keptRelations = candidateRelations.filter((rel) => !supersededIdsInView.has(rel.id));

  // 4. Group parallel edges per unordered node pair to assign clean non-overlapping curves
  const pairGroups = new Map<string, RelationRecord[]>();
  for (const rel of keptRelations) {
    const pairKey =
      rel.source < rel.target
        ? `${rel.source}::${rel.target}`
        : `${rel.target}::${rel.source}`;
    const arr = pairGroups.get(pairKey) ?? [];
    arr.push(rel);
    pairGroups.set(pairKey, arr);
  }

  const resolvedLinks: ResolvedLink[] = [];
  for (const [, group] of pairGroups) {
    const total = group.length;
    group.forEach((rel, idx) => {
      const isCanonicalDir = rel.source <= rel.target;
      let curvature = 0.14;
      let curveRotation = 0;

      if (total === 1) {
        curvature = 0.12;
        curveRotation = 0;
      } else {
        // Fan out symmetric curves in both 2D (signed curvature) and 3D (rotation around axis)
        const centered = idx - (total - 1) / 2;
        const mag = 0.18 + Math.abs(centered) * 0.16;
        const sign = centered >= 0 ? 1 : -1;
        curvature = mag * sign * (isCanonicalDir ? 1 : -1);
        curveRotation = (idx * Math.PI * 2) / total;
      }

      let prior: RelationRecord | undefined;
      if (rel.supersedesId) {
        let stepId: string | undefined = rel.supersedesId;
        const seen = new Set<string>([rel.id]);
        while (stepId && !seen.has(stepId)) {
          seen.add(stepId);
          const activeAnc = candidateMap.get(stepId);
          if (activeAnc) {
            prior = activeAnc;
            break;
          }
          stepId = relationById.get(stepId)?.supersedesId;
        }
        if (!prior) {
          prior = relationById.get(rel.supersedesId);
        }
      }

      resolvedLinks.push({
        id: rel.id,
        source: rel.source,
        target: rel.target,
        sourceId: rel.source,
        targetId: rel.target,
        category: rel.category,
        label: rel.label,
        direction: rel.direction,
        weight: rel.weight,
        arcs: rel.arcs,
        supersedesId: rel.supersedesId,
        priorLabel: prior?.label,
        priorArcs: prior?.arcs,
        note: rel.note,
        parallelIndex: idx,
        parallelTotal: total,
        curvature,
        curveRotation,
      });

      const sNode = nodeMap.get(rel.source);
      const tNode = nodeMap.get(rel.target);
      if (sNode) sNode.degree += 1;
      if (tNode) tNode.degree += 1;
    });
  }

  // Optional mini-mode subgraph scoping (center + 1-hop neighbors + interconnections)
  if (filters.egoSubgraphCenterId && nodeMap.has(filters.egoSubgraphCenterId)) {
    const centerId = filters.egoSubgraphCenterId;
    const egoIds = new Set<string>([centerId]);
    for (const link of resolvedLinks) {
      if (link.sourceId === centerId) egoIds.add(link.targetId);
      if (link.targetId === centerId) egoIds.add(link.sourceId);
    }
    const subNodes = preliminaryNodes.filter((n) => egoIds.has(n.id));
    const subLinks = resolvedLinks.filter(
      (l) => egoIds.has(l.sourceId) && egoIds.has(l.targetId)
    );
    return {
      nodes: subNodes,
      links: subLinks,
      nodeMap: new Map(subNodes.map((n) => [n.id, n])),
    };
  }

  return {
    nodes: preliminaryNodes,
    links: resolvedLinks,
    nodeMap,
  };
}

/**
 * Unweighted BFS shortest path between two active nodes (treats graph as undirected social/political web).
 * Returns ordered node IDs and connecting link IDs.
 */
export function findShortestPath(
  graph: ResolvedGraph,
  startId: string,
  endId: string
): { nodeIds: string[]; linkIds: string[] } | null {
  if (!graph.nodeMap.has(startId) || !graph.nodeMap.has(endId)) return null;
  if (startId === endId) return { nodeIds: [startId], linkIds: [] };

  const adj = new Map<string, Array<{ neighbor: string; linkId: string }>>();
  for (const link of graph.links) {
    const u = link.sourceId;
    const v = link.targetId;
    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);
    adj.get(u)!.push({ neighbor: v, linkId: link.id });
    adj.get(v)!.push({ neighbor: u, linkId: link.id });
  }

  const visited = new Set<string>([startId]);
  const parent = new Map<string, { prevNode: string; linkId: string }>();
  const queue: string[] = [startId];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr === endId) {
      const nodeIds: string[] = [endId];
      const linkIds: string[] = [];
      let step = endId;
      while (step !== startId) {
        const p = parent.get(step)!;
        linkIds.push(p.linkId);
        nodeIds.push(p.prevNode);
        step = p.prevNode;
      }
      nodeIds.reverse();
      linkIds.reverse();
      return { nodeIds, linkIds };
    }

    for (const edge of adj.get(curr) ?? []) {
      if (!visited.has(edge.neighbor)) {
        visited.add(edge.neighbor);
        parent.set(edge.neighbor, { prevNode: curr, linkId: edge.linkId });
        queue.push(edge.neighbor);
      }
    }
  }

  return null;
}
