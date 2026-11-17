import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArcDefinition,
  ENTITY_TYPE_META,
  EntityRecord,
  EntityType,
  GraphDataset,
  ImportanceTier,
  isSafeNavUrl,
  RELATION_CATEGORY_META,
  RelationCategory,
  RelationRecord,
  ResolvedLink,
  ViewerMountConfig,
} from './types/graph';
import { findShortestPath, resolveGraph } from './engine/resolveGraph';
import { Graph3DView } from './components/Graph3DView';
import { Graph2DView } from './components/Graph2DView';
import { TopArcBar } from './components/TopArcBar';
import { LeftControlDock } from './components/LeftControlDock';
import { InspectorDrawer } from './components/InspectorDrawer';
import { QuickEditModal } from './components/QuickEditModal';

interface AppProps {
  config?: ViewerMountConfig;
}

const TIER_RANK: Record<ImportanceTier, number> = {
  core: 1,
  supporting: 2,
  minor: 3,
};

function isValidTier(val: string | null | undefined): val is ImportanceTier {
  return val === 'core' || val === 'supporting' || val === 'minor';
}

function isValidViewMode(val: string | null | undefined): val is '3d' | '2d' {
  return val === '3d' || val === '2d';
}

function expandTierForEntity(
  current: ImportanceTier,
  entityTier?: ImportanceTier
): ImportanceTier {
  if (!entityTier || !(entityTier in TIER_RANK)) return current;
  return TIER_RANK[entityTier] > TIER_RANK[current] ? entityTier : current;
}

function getEntityEffectiveImportance(
  ent: EntityRecord,
  activeArcIds: string[],
  arcsList: ArcDefinition[]
): ImportanceTier {
  const arcOrder = new Map(arcsList.map((a) => [a.id, a.order]));
  const ordered = [...activeArcIds].sort(
    (a, b) => (arcOrder.get(a) ?? 0) - (arcOrder.get(b) ?? 0)
  );
  let imp: ImportanceTier = ent.importance ?? 'core';
  if (ent.arcOverrides) {
    for (const arcId of ordered) {
      const ov = ent.arcOverrides[arcId];
      if (ov?.importance && isValidTier(ov.importance)) {
        imp = ov.importance;
      }
    }
  }
  return imp;
}

function computeInitialGraphState(
  data: GraphDataset,
  mode: 'full' | 'mini',
  urlParams: URLSearchParams,
  config?: ViewerMountConfig
): {
  selectedArcs: string[];
  maxImportanceTier: ImportanceTier;
  selectedNodeId: string | null;
} {
  const urlArc = mode === 'full' ? urlParams.get('kr_arc') : null;
  const urlTier = mode === 'full' ? urlParams.get('kr_tier') : null;
  const urlFocus = mode === 'full' ? urlParams.get('kr_focus') : null;

  const baseTier: ImportanceTier = isValidTier(urlTier)
    ? urlTier
    : isValidTier(config?.defaultTier)
      ? config.defaultTier
      : mode === 'mini'
        ? 'minor'
        : 'supporting';

  const rawArcSpec = urlArc || config?.defaultArc || (mode === 'mini' ? 'auto' : 'kuro');
  const validArcIds = new Set(data.arcs.map((a) => a.id));
  const fallbackArc = data.arcs[data.arcs.length - 1]?.id || 'kuro';

  let nextArcs: string[];
  if (rawArcSpec === 'all') {
    nextArcs = data.arcs.map((a) => a.id);
  } else if (rawArcSpec === 'auto') {
    nextArcs = [fallbackArc];
  } else {
    const parsed = rawArcSpec
      .split(',')
      .map((s) => s.trim())
      .filter((id) => validArcIds.has(id));
    nextArcs = parsed.length > 0 ? parsed : [fallbackArc];
  }

  let matchedFocus: EntityRecord | undefined;
  if (mode === 'mini') {
    if (config?.focusWpPostId) {
      matchedFocus = data.entities.find((e) => e.wpPostId === config.focusWpPostId);
    } else if (config?.focusNodeId) {
      matchedFocus = data.entities.find((e) => e.id === config.focusNodeId);
    } else {
      matchedFocus =
        data.entities.find((e) => e.id === 'van-arkride') ?? data.entities[0];
    }
  } else {
    // Full mode: prioritize ?kr_focus= over config.focusWpPostId and config.focusNodeId
    if (urlFocus) {
      matchedFocus = data.entities.find((e) => e.id === urlFocus);
    }
    if (!matchedFocus && config?.focusWpPostId) {
      matchedFocus = data.entities.find((e) => e.wpPostId === config.focusWpPostId);
    }
    if (!matchedFocus && config?.focusNodeId) {
      matchedFocus = data.entities.find((e) => e.id === config.focusNodeId);
    }
  }

  let nextTier = baseTier;
  let nextSelectedNodeId: string | null = null;

  if (matchedFocus) {
    nextSelectedNodeId = matchedFocus.id;
    const latestEntityArc =
      matchedFocus.arcs[matchedFocus.arcs.length - 1] || fallbackArc;

    if (rawArcSpec === 'auto') {
      nextArcs = [latestEntityArc];
    } else if (!matchedFocus.arcs.some((a) => nextArcs.includes(a))) {
      // Auto-switch/expand selectedArcs so deep-linked entity is guaranteed visible
      if (!urlArc && rawArcSpec !== 'all') {
        nextArcs = [latestEntityArc];
      } else {
        nextArcs = Array.from(new Set([...nextArcs, latestEntityArc]));
      }
    }

    const effImp = getEntityEffectiveImportance(matchedFocus, nextArcs, data.arcs);
    nextTier = expandTierForEntity(baseTier, effImp);
  } else if (mode === 'full') {
    const isMobileViewport = typeof window !== 'undefined' && window.innerWidth <= 768;
    if (
      !isMobileViewport &&
      !urlFocus &&
      nextArcs.includes('kuro') &&
      data.entities.some((e) => e.id === 'van-arkride')
    ) {
      nextSelectedNodeId = 'van-arkride';
    } else {
      nextSelectedNodeId = null;
    }
  }

  return {
    selectedArcs: nextArcs,
    maxImportanceTier: nextTier,
    selectedNodeId: nextSelectedNodeId,
  };
}

function isNonNoneCssValue(val: string | undefined | null): boolean {
  const v = (val ?? '').trim();
  return v !== '' && v !== 'none';
}

function clearAncestorFixedTraps(rootEl: HTMLElement | null): () => void {
  if (!rootEl || typeof window === 'undefined') return () => {};
  const modified: Array<{ el: HTMLElement; prevStyleAttr: string | null }> = [];
  let parent = rootEl.parentElement;
  while (parent && parent !== document.documentElement) {
    const cs = window.getComputedStyle(parent);
    const overrides: Array<[string, string]> = [];
    if (isNonNoneCssValue(cs.getPropertyValue('transform'))) {
      overrides.push(['transform', 'none']);
    }
    if (isNonNoneCssValue(cs.getPropertyValue('translate'))) {
      overrides.push(['translate', 'none']);
    }
    if (isNonNoneCssValue(cs.getPropertyValue('rotate'))) {
      overrides.push(['rotate', 'none']);
    }
    if (isNonNoneCssValue(cs.getPropertyValue('scale'))) {
      overrides.push(['scale', 'none']);
    }
    if (isNonNoneCssValue(cs.getPropertyValue('filter'))) {
      overrides.push(['filter', 'none']);
    }
    if (isNonNoneCssValue(cs.getPropertyValue('perspective'))) {
      overrides.push(['perspective', 'none']);
    }
    if (
      isNonNoneCssValue(cs.getPropertyValue('backdrop-filter')) ||
      isNonNoneCssValue(cs.getPropertyValue('-webkit-backdrop-filter'))
    ) {
      overrides.push(['backdrop-filter', 'none'], ['-webkit-backdrop-filter', 'none']);
    }
    if (isNonNoneCssValue(cs.getPropertyValue('contain'))) {
      overrides.push(['contain', 'none']);
    }
    const containerType = cs.getPropertyValue('container-type').trim();
    if (containerType !== '' && containerType !== 'normal') {
      overrides.push(['container-type', 'normal']);
    }
    const willChange = cs.getPropertyValue('will-change').trim();
    if (willChange !== '' && willChange !== 'auto') {
      overrides.push(['will-change', 'auto']);
    }
    if (isNonNoneCssValue(cs.getPropertyValue('clip-path'))) {
      overrides.push(['clip-path', 'none']);
    }
    if (cs.position !== 'static' && cs.zIndex !== 'auto') {
      overrides.push(['z-index', '2147483000']);
    }
    if (cs.getPropertyValue('isolation').trim() === 'isolate') {
      overrides.push(['isolation', 'auto']);
    }

    if (overrides.length > 0) {
      modified.push({
        el: parent,
        prevStyleAttr: parent.getAttribute('style'),
      });
      for (const [prop, val] of overrides) {
        parent.style.setProperty(prop, val, 'important');
      }
    }
    parent = parent.parentElement;
  }

  return () => {
    for (const { el, prevStyleAttr } of modified) {
      if (prevStyleAttr === null) {
        el.removeAttribute('style');
      } else {
        el.setAttribute('style', prevStyleAttr);
      }
    }
  };
}

export const App: React.FC<AppProps> = ({ config }) => {
  const mode = config?.mode ?? 'full';

  const urlParams = useMemo(() => {
    if (typeof window === 'undefined' || mode === 'mini') return new URLSearchParams();
    return new URLSearchParams(window.location.search);
  }, [mode]);

  const initialHydrated = useMemo(() => {
    if (!config?.initialData) return null;
    return computeInitialGraphState(config.initialData, mode, urlParams, config);
  }, [config, mode, urlParams]);

  const [arcs, setArcs] = useState<ArcDefinition[]>(() => config?.initialData?.arcs ?? []);
  const [entities, setEntities] = useState<EntityRecord[]>(
    () => config?.initialData?.entities ?? []
  );
  const [relations, setRelations] = useState<RelationRecord[]>(
    () => config?.initialData?.relations ?? []
  );
  const [loading, setLoading] = useState<boolean>(() => !config?.initialData);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedArcs, setSelectedArcs] = useState<string[]>(
    () => initialHydrated?.selectedArcs ?? ['kuro']
  );
  const [maxImportanceTier, setMaxImportanceTier] = useState<ImportanceTier>(
    () =>
      initialHydrated?.maxImportanceTier ??
      (isValidTier(urlParams.get('kr_tier'))
        ? (urlParams.get('kr_tier') as ImportanceTier)
        : config?.defaultTier || (mode === 'mini' ? 'minor' : 'supporting'))
  );
  const [viewMode, setViewMode] = useState<'3d' | '2d'>(() => {
    const uView = urlParams.get('kr_view');
    if (isValidViewMode(uView)) return uView;
    if (isValidViewMode(config?.defaultView)) return config.defaultView;
    return mode === 'mini' ? '2d' : '3d';
  });
  const [egoFocusMode, setEgoFocusMode] = useState(mode === 'mini');
  const [alwaysShowLabels, setAlwaysShowLabels] = useState(mode === 'mini');

  const [enabledEntityTypes, setEnabledEntityTypes] = useState<Set<EntityType>>(
    () => new Set(Object.keys(ENTITY_TYPE_META) as EntityType[])
  );
  const [enabledCategories, setEnabledCategories] = useState<Set<RelationCategory>>(
    () => new Set(Object.keys(RELATION_CATEGORY_META) as RelationCategory[])
  );
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(() => new Set());

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    () => initialHydrated?.selectedNodeId ?? null
  );
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<ResolvedLink | null>(null);
  const [pathRange, setPathRange] = useState<{ startId: string; endId: string } | null>(null);

  const [quickEditOpen, setQuickEditOpen] = useState(false);
  const [evolveRelationId, setEvolveRelationId] = useState<string | null>(null);
  const [isWebFullscreen, setIsWebFullscreen] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isWebFullscreen || typeof document === 'undefined') return;

    const prevScrollX = window.scrollX;
    const prevScrollY = window.scrollY;
    document.documentElement.classList.add('kr-web-fullscreen-active');
    document.body.classList.add('kr-web-fullscreen-active');
    const restoreAncestors = clearAncestorFixedTraps(shellRef.current);

    return () => {
      restoreAncestors();
      const otherActive = document.querySelectorAll('.xipha-app-shell.is-web-fullscreen');
      const stillFullscreen = Array.from(otherActive).some((el) => el !== shellRef.current);
      if (!stillFullscreen) {
        document.documentElement.classList.remove('kr-web-fullscreen-active');
        document.body.classList.remove('kr-web-fullscreen-active');
      }
      if (window.scrollX !== prevScrollX || window.scrollY !== prevScrollY) {
        window.scrollTo(prevScrollX, prevScrollY);
      }
    };
  }, [isWebFullscreen]);

  useEffect(() => {
    if (!isWebFullscreen || typeof window === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !quickEditOpen) {
        e.preventDefault();
        setIsWebFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isWebFullscreen, quickEditOpen]);

  const applyDataset = useCallback(
    (data: GraphDataset) => {
      const nextArcsList = data.arcs ?? [];
      const nextEntitiesList = data.entities ?? [];
      const nextRelationsList = data.relations ?? [];

      setArcs(nextArcsList);
      setEntities(nextEntitiesList);
      setRelations(nextRelationsList);

      const hydrated = computeInitialGraphState(data, mode, urlParams, config);
      setSelectedArcs(hydrated.selectedArcs);
      setMaxImportanceTier(hydrated.maxImportanceTier);
      setSelectedNodeId(hydrated.selectedNodeId);
    },
    [mode, urlParams, config]
  );

  // Load static JSON dataset when dataUrl is provided (or fallback to ./data/zemuria.latest.json, then lazy demoSeed)
  useEffect(() => {
    if (config?.initialData) {
      setLoading(false);
      return;
    }
    const targetUrl = config?.dataUrl || './data/zemuria.latest.json';
    let cancelled = false;
    setLoading(true);

    fetch(targetUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<GraphDataset>;
      })
      .then((data) => {
        if (cancelled) return;
        applyDataset(data);
        setLoadError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        // Lazy-load demoSeed ONLY when standalone (!config?.dataUrl && !config?.initialData)
        if (!config?.dataUrl && !config?.initialData) {
          import('./data/demoSeed')
            .then((mod) => {
              if (cancelled) return;
              applyDataset({
                schemaVersion: 1,
                version: 1,
                updatedAt: '',
                arcs: mod.DEMO_ARCS,
                entities: mod.DEMO_ENTITIES,
                relations: mod.DEMO_RELATIONS,
              });
              setLoadError(null);
              setLoading(false);
            })
            .catch((seedErr) => {
              if (cancelled) return;
              setLoadError(String(seedErr?.message || seedErr));
              setLoading(false);
            });
          return;
        }
        setLoadError(String(err?.message || err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [config?.dataUrl, config?.initialData, applyDataset]);

  // Sync deep-link URL query parameters in full mode once dataset is loaded
  useEffect(() => {
    if (mode !== 'full' || loading || arcs.length === 0 || typeof window === 'undefined') {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const isAll = selectedArcs.length === arcs.length && arcs.length > 1;
    params.set('kr_arc', isAll ? 'all' : selectedArcs.join(','));
    params.set('kr_tier', maxImportanceTier);
    params.set('kr_view', viewMode);
    if (selectedNodeId) {
      params.set('kr_focus', selectedNodeId);
    } else {
      params.delete('kr_focus');
    }
    const qs = params.toString();
    const nextUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    const currUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl !== currUrl) {
      window.history.replaceState(null, '', nextUrl);
    }
  }, [mode, loading, arcs, selectedArcs, maxImportanceTier, viewMode, selectedNodeId]);

  const miniCenterId = useMemo(() => {
    if (mode !== 'mini' || loading) return null;
    if (config?.focusWpPostId) {
      const hit = entities.find((e) => e.wpPostId === config.focusWpPostId);
      return hit ? hit.id : null;
    }
    if (config?.focusNodeId) {
      const hit = entities.find((e) => e.id === config.focusNodeId);
      return hit ? hit.id : null;
    }
    return selectedNodeId || 'van-arkride';
  }, [mode, loading, config?.focusWpPostId, config?.focusNodeId, entities, selectedNodeId]);

  const isMiniEmpty = mode === 'mini' && !loading && !loadError && !miniCenterId;

  const resolved = useMemo(() => {
    if (loading || isMiniEmpty) {
      return { nodes: [], links: [], nodeMap: new Map() };
    }
    return resolveGraph(arcs, entities, relations, {
      selectedArcs,
      maxImportanceTier,
      enabledEntityTypes,
      enabledCategories,
      collapsedGroupIds,
      egoSubgraphCenterId: miniCenterId,
    });
  }, [
    loading,
    isMiniEmpty,
    arcs,
    entities,
    relations,
    selectedArcs,
    maxImportanceTier,
    enabledEntityTypes,
    enabledCategories,
    collapsedGroupIds,
    miniCenterId,
  ]);

  const shortestPath = useMemo(() => {
    if (!pathRange) return null;
    return findShortestPath(resolved, pathRange.startId, pathRange.endId);
  }, [resolved, pathRange]);

  const effectiveSelectedNodeId =
    mode === 'mini' ? (selectedNodeId ?? miniCenterId) : selectedNodeId;

  const { highlightedNodeIds, highlightedLinkIds } = useMemo(() => {
    const nSet = new Set<string>();
    const lSet = new Set<string>();

    if (shortestPath && shortestPath.nodeIds.length > 0) {
      shortestPath.nodeIds.forEach((id) => nSet.add(id));
      shortestPath.linkIds.forEach((id) => lSet.add(id));
      return { highlightedNodeIds: nSet, highlightedLinkIds: lSet };
    }

    if (selectedLink && !hoveredNodeId) {
      nSet.add(selectedLink.sourceId);
      nSet.add(selectedLink.targetId);
      lSet.add(selectedLink.id);
      return { highlightedNodeIds: nSet, highlightedLinkIds: lSet };
    }

    const focusId = hoveredNodeId ?? effectiveSelectedNodeId;
    if (focusId && resolved.nodeMap.has(focusId)) {
      nSet.add(focusId);
      for (const link of resolved.links) {
        if (link.sourceId === focusId) {
          nSet.add(link.targetId);
          lSet.add(link.id);
        } else if (link.targetId === focusId) {
          nSet.add(link.sourceId);
          lSet.add(link.id);
        }
      }
      return { highlightedNodeIds: nSet, highlightedLinkIds: lSet };
    }

    return { highlightedNodeIds: nSet, highlightedLinkIds: lSet };
  }, [shortestPath, hoveredNodeId, effectiveSelectedNodeId, selectedLink, resolved]);

  const activeSelectedNode = effectiveSelectedNodeId
    ? (resolved.nodeMap.get(effectiveSelectedNodeId) ?? null)
    : null;

  const handleSelectSingleArc = (arcId: string) => {
    setSelectedArcs([arcId]);
    setPathRange(null);
    setSelectedLink(null);
  };

  const handleToggleArcMulti = (arcId: string) => {
    setSelectedArcs((prev) => {
      if (prev.includes(arcId)) {
        return prev.length > 1 ? prev.filter((a) => a !== arcId) : prev;
      }
      return [...prev, arcId];
    });
    setPathRange(null);
  };

  const handleSelectAllArcs = () => {
    setSelectedArcs(arcs.map((a) => a.id));
    setPathRange(null);
  };

  const handleToggleEntityType = (t: EntityType) => {
    setEnabledEntityTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t) && next.size > 1) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const handleToggleCategory = (c: RelationCategory) => {
    setEnabledCategories((prev) => {
      const next = new Set(prev);
      if (next.has(c) && next.size > 1) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const handleToggleCollapseGroup = (groupId: string) => {
    setCollapsedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const handleSelectAndFocusNode = (
    nodeId: string,
    requiredArcId?: string,
    requiredTier?: ImportanceTier
  ) => {
    const ent = entities.find((e) => e.id === nodeId);
    let nextArcs = selectedArcs;

    if (requiredArcId && !selectedArcs.includes(requiredArcId)) {
      nextArcs = [requiredArcId];
      setSelectedArcs(nextArcs);
    } else if (ent && !ent.arcs.some((a) => selectedArcs.includes(a))) {
      const fallback = ent.arcs[ent.arcs.length - 1];
      if (fallback) {
        nextArcs = [fallback];
        setSelectedArcs(nextArcs);
      }
    }

    const effImp = ent
      ? getEntityEffectiveImportance(ent, nextArcs, arcs)
      : requiredTier;
    const neededTier = expandTierForEntity(
      expandTierForEntity(maxImportanceTier, requiredTier),
      effImp
    );
    if (neededTier !== maxImportanceTier) {
      setMaxImportanceTier(neededTier);
    }

    if (ent) {
      if (!enabledEntityTypes.has(ent.entityType)) {
        setEnabledEntityTypes((prev) => new Set([...prev, ent.entityType]));
      }
      if (ent.defaultGroupId && collapsedGroupIds.has(ent.defaultGroupId)) {
        setCollapsedGroupIds((prev) => {
          const next = new Set(prev);
          next.delete(ent.defaultGroupId!);
          return next;
        });
      }
    }

    setPathRange(null);
    setSelectedLink(null);
    setSelectedNodeId(nodeId);
  };

  const handleAddOrEvolveRelation = (
    newRel: RelationRecord,
    ensureEntityArcs: Array<{ entityId: string; arcId: string }>
  ) => {
    setEntities((prev) =>
      prev.map((ent) => {
        const needed = ensureEntityArcs
          .filter((item) => item.entityId === ent.id)
          .map((item) => item.arcId);
        if (needed.length === 0) return ent;
        const mergedArcs = Array.from(new Set([...ent.arcs, ...needed]));
        return { ...ent, arcs: mergedArcs };
      })
    );
    setRelations((prev) => [...prev, newRel]);
    if (!newRel.arcs.some((a) => selectedArcs.includes(a))) {
      setSelectedArcs(newRel.arcs);
    }
    setSelectedNodeId(newRel.source);
  };

  const shellStyle: React.CSSProperties =
    !isWebFullscreen && config?.height
      ? { height: config.height, borderRadius: '12px', border: '1px solid rgba(56, 189, 248, 0.22)' }
      : {};

  return (
    <div
      ref={shellRef}
      className={`xipha-app-shell mode-${mode}${isWebFullscreen ? ' is-web-fullscreen' : ''}`}
      style={shellStyle}
    >
      <TopArcBar
        arcs={arcs}
        selectedArcs={selectedArcs}
        viewMode={viewMode}
        mode={mode}
        egoFocusMode={egoFocusMode}
        alwaysShowLabels={alwaysShowLabels}
        isWebFullscreen={isWebFullscreen}
        hasSelectedNode={Boolean(activeSelectedNode)}
        nodeCount={resolved.nodes.length}
        linkCount={resolved.links.length}
        adminStudioUrl={config?.adminStudioUrl}
        fullGraphPageUrl={config?.fullGraphPageUrl}
        enableDemoSandbox={config?.enableDemoSandbox ?? !config?.dataUrl}
        onSelectSingleArc={handleSelectSingleArc}
        onToggleArcMulti={handleToggleArcMulti}
        onSelectAllArcs={handleSelectAllArcs}
        onChangeViewMode={(m) => {
          setViewMode(m);
          if (m === '3d') setEgoFocusMode(false);
        }}
        onToggleEgoFocus={() => setEgoFocusMode((v) => !v)}
        onToggleAlwaysShowLabels={() => setAlwaysShowLabels((v) => !v)}
        onToggleWebFullscreen={() => setIsWebFullscreen((v) => !v)}
        onOpenQuickEdit={() => {
          setEvolveRelationId(null);
          setQuickEditOpen(true);
        }}
      />

      <main className="xipha-stage">
        {loading && (
          <div className="kr-loading-overlay">正在载入塞姆利亚导力关系图谱数据…</div>
        )}
        {loadError && !loading && (
          <div className="kr-loading-overlay error">数据加载失败：{loadError}</div>
        )}
        {isMiniEmpty && (
          <div className="kr-loading-overlay kr-empty-state">
            本词条暂未收录导力关系图谱数据
          </div>
        )}

        {!loading && !loadError && !isMiniEmpty && (
          viewMode === '3d' ? (
            <Graph3DView
              nodes={resolved.nodes}
              links={resolved.links}
              selectedNodeId={activeSelectedNode?.id ?? null}
              hoveredNodeId={hoveredNodeId}
              highlightedNodeIds={highlightedNodeIds}
              highlightedLinkIds={highlightedLinkIds}
              alwaysShowLabels={alwaysShowLabels}
              onSelectNode={(id) => {
                setPathRange(null);
                setSelectedLink(null);
                setSelectedNodeId(mode === 'mini' ? (id ?? miniCenterId) : id);
              }}
              onHoverNode={setHoveredNodeId}
              onSelectLink={(link) => {
                setPathRange(null);
                if (mode !== 'mini') {
                  setSelectedNodeId(null);
                }
                setSelectedLink(link);
              }}
            />
          ) : (
            <Graph2DView
              nodes={resolved.nodes}
              links={resolved.links}
              selectedNodeId={activeSelectedNode?.id ?? null}
              hoveredNodeId={hoveredNodeId}
              highlightedNodeIds={highlightedNodeIds}
              highlightedLinkIds={highlightedLinkIds}
              egoFocusMode={egoFocusMode}
              alwaysShowLabels={alwaysShowLabels}
              collapsedGroupIds={collapsedGroupIds}
              onSelectNode={(id) => {
                setPathRange(null);
                setSelectedLink(null);
                if (mode === 'mini') {
                  setSelectedNodeId(id ?? miniCenterId);
                } else {
                  setSelectedNodeId(id);
                  if (!id) setEgoFocusMode(false);
                }
              }}
              onHoverNode={setHoveredNodeId}
              onSelectLink={(link) => {
                setPathRange(null);
                if (mode !== 'mini') {
                  setSelectedNodeId(null);
                }
                setSelectedLink(link);
              }}
              onToggleCollapseGroup={handleToggleCollapseGroup}
            />
          )
        )}

        {mode === 'full' && !loading && (
          <LeftControlDock
            arcs={arcs}
            allEntities={entities}
            activeNodes={resolved.nodes}
            selectedArcs={selectedArcs}
            maxImportanceTier={maxImportanceTier}
            enabledEntityTypes={enabledEntityTypes}
            enabledCategories={enabledCategories}
            pathRange={pathRange}
            pathFoundCount={shortestPath ? shortestPath.nodeIds.length : null}
            onChangeMaxImportance={setMaxImportanceTier}
            onToggleEntityType={handleToggleEntityType}
            onToggleCategory={handleToggleCategory}
            onSelectAndFocusNode={handleSelectAndFocusNode}
            onSetPathRange={setPathRange}
          />
        )}

        {mode === 'full' && !loading && (
          <InspectorDrawer
            arcs={arcs}
            selectedNode={activeSelectedNode}
            selectedLink={selectedLink}
            activeLinks={resolved.links}
            nodeMap={resolved.nodeMap}
            allEntities={entities}
            allRelations={relations}
            onClose={() => {
              setSelectedNodeId(null);
              setSelectedLink(null);
              setEgoFocusMode(false);
            }}
            onSelectNode={(id) => {
              setSelectedLink(null);
              setSelectedNodeId(id);
            }}
            onSwitchArc={(arcId) => {
              setSelectedArcs([arcId]);
            }}
            onEvolveRelation={(relId) => {
              if (isSafeNavUrl(config?.adminStudioUrl)) {
                const sep = config.adminStudioUrl.includes('?') ? '&' : '?';
                window.location.href = `${config.adminStudioUrl}${sep}evolve=${encodeURIComponent(relId)}`;
              } else {
                setEvolveRelationId(relId);
                setQuickEditOpen(true);
              }
            }}
          />
        )}

        {mode === 'full' && (
          <div className="bottom-hint-pill">
            <span>✦ 金色星标代表跨作演变角色 · 左上角可按「核心主线 / 重要配角 / 全量登场」切换角色密度</span>
            {viewMode === '2d' && <span>· 双击组织可折叠成员</span>}
          </div>
        )}
      </main>

      <QuickEditModal
        isOpen={quickEditOpen}
        initialEvolveRelationId={evolveRelationId}
        arcs={arcs}
        entities={entities}
        relations={relations}
        defaultArcs={selectedArcs}
        onClose={() => setQuickEditOpen(false)}
        onAddRelation={handleAddOrEvolveRelation}
      />
    </div>
  );
};
