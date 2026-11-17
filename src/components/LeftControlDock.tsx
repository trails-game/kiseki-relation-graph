import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Route,
  Filter,
  X,
  ChevronDown,
  ChevronUp,
  PanelLeftClose,
  SlidersHorizontal,
} from 'lucide-react';
import {
  ArcDefinition,
  ENTITY_TYPE_META,
  EntityRecord,
  EntityType,
  getEntityTypeMeta,
  ImportanceTier,
  RELATION_CATEGORY_META,
  RelationCategory,
  ResolvedNode,
} from '../types/graph';

interface LeftControlDockProps {
  arcs: ArcDefinition[];
  allEntities: EntityRecord[];
  activeNodes: ResolvedNode[];
  selectedArcs: string[];
  maxImportanceTier: ImportanceTier;
  enabledEntityTypes: Set<EntityType>;
  enabledCategories: Set<RelationCategory>;
  pathRange: { startId: string; endId: string } | null;
  pathFoundCount: number | null;
  onChangeMaxImportance: (tier: ImportanceTier) => void;
  onToggleEntityType: (t: EntityType) => void;
  onToggleCategory: (c: RelationCategory) => void;
  onSelectAndFocusNode: (nodeId: string, requiredArcId?: string, requiredTier?: ImportanceTier) => void;
  onSetPathRange: (range: { startId: string; endId: string } | null) => void;
}

export const LeftControlDock: React.FC<LeftControlDockProps> = ({
  arcs,
  allEntities,
  activeNodes,
  selectedArcs,
  maxImportanceTier,
  enabledEntityTypes,
  enabledCategories,
  pathRange,
  pathFoundCount,
  onChangeMaxImportance,
  onToggleEntityType,
  onToggleCategory,
  onSelectAndFocusNode,
  onSetPathRange,
}) => {
  const [dockOpen, setDockOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.innerWidth > 768;
  });
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [pathStart, setPathStart] = useState('van-arkride');
  const [pathEnd, setPathEnd] = useState('gerard-dantes');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingFocusSearchRef = useRef(false);

  const totalEntityTypes = Object.keys(ENTITY_TYPE_META).length;
  const totalCategories = Object.keys(RELATION_CATEGORY_META).length;
  const activeFilterCount =
    (maxImportanceTier !== 'supporting' ? 1 : 0) +
    (enabledEntityTypes.size < totalEntityTypes ? 1 : 0) +
    (enabledCategories.size < totalCategories ? 1 : 0) +
    (pathRange ? 1 : 0);
  const hasActiveFilters = activeFilterCount > 0;

  const collapseIfMobile = () => {
    if (typeof window !== 'undefined' && window.innerWidth <= 768) {
      setDockOpen(false);
    }
  };

  const arcNameMap = useMemo(() => new Map(arcs.map((a) => [a.id, a.shortName])), [arcs]);
  const activeIdSet = useMemo(() => new Set(activeNodes.map((n) => n.id)), [activeNodes]);

  // Keep pathStart & pathEnd synchronized with activeNodes so the <select> value always matches state
  useEffect(() => {
    if (activeNodes.length === 0) return;
    const ids = new Set(activeNodes.map((n) => n.id));
    let nextStart = pathStart;
    if (!ids.has(nextStart)) {
      nextStart = ids.has('van-arkride')
        ? 'van-arkride'
        : ids.has('feri-al-fayed')
          ? 'feri-al-fayed'
          : activeNodes[0].id;
      setPathStart(nextStart);
    }
    if (!ids.has(pathEnd)) {
      const nextEnd = ids.has('gerard-dantes')
        ? 'gerard-dantes'
        : activeNodes.find((n) => n.id !== nextStart)?.id ?? activeNodes[0].id;
      setPathEnd(nextEnd);
    }
  }, [activeNodes, pathStart, pathEnd]);

  useEffect(() => {
    if (dockOpen && pendingFocusSearchRef.current) {
      pendingFocusSearchRef.current = false;
      inputRef.current?.focus();
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [dockOpen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const tag = activeEl?.tagName;
      const isEditable =
        tag === 'INPUT' ||
        tag === 'SELECT' ||
        tag === 'TEXTAREA' ||
        (activeEl instanceof HTMLElement && activeEl.isContentEditable);
      if (e.key === '/' && !isEditable) {
        e.preventDefault();
        if (!dockOpen) {
          pendingFocusSearchRef.current = true;
          setDockOpen(true);
          requestAnimationFrame(() => {
            inputRef.current?.focus();
          });
        } else {
          inputRef.current?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dockOpen]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const scored: Array<{ entity: EntityRecord; rank: number }> = [];
    for (const e of allEntities) {
      const canon = e.canonicalName.toLowerCase();
      const nameEn = (e.nameEn ?? '').toLowerCase();
      const overrideNames = Object.values(e.arcOverrides ?? {})
        .map((o) => (o.displayName ?? '').toLowerCase())
        .filter(Boolean);
      const aliases = (e.aliases ?? []).map((a) => a.toLowerCase());
      const titles = [
        (e.defaultTitle ?? '').toLowerCase(),
        ...Object.values(e.arcOverrides ?? {}).map((o) => (o.title ?? '').toLowerCase()),
      ].filter(Boolean);

      let rank = 99;
      if (canon === q || nameEn === q || overrideNames.some((n) => n === q)) {
        rank = 1;
      } else if (
        canon.startsWith(q) ||
        nameEn.startsWith(q) ||
        overrideNames.some((n) => n.startsWith(q))
      ) {
        rank = 2;
      } else if (aliases.some((a) => a === q || a.startsWith(q) || a.includes(q))) {
        rank = 3;
      } else if (
        canon.includes(q) ||
        nameEn.includes(q) ||
        overrideNames.some((n) => n.includes(q))
      ) {
        rank = 4;
      } else if (titles.some((t) => t.includes(q))) {
        rank = 5;
      }

      if (rank < 99) {
        scored.push({ entity: e, rank });
      }
    }

    scored.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const aInLayer = activeIdSet.has(a.entity.id) ? 0 : 1;
      const bInLayer = activeIdSet.has(b.entity.id) ? 0 : 1;
      if (aInLayer !== bInLayer) return aInLayer - bInLayer;
      return a.entity.canonicalName.length - b.entity.canonicalName.length;
    });

    return scored.slice(0, 8).map((s) => s.entity);
  }, [query, allEntities, activeIdSet]);

  const typeCounts = useMemo(() => {
    const counts: Record<EntityType, number> = {
      nation: 0,
      organization: 0,
      family: 0,
      school: 0,
      character: 0,
    };
    const activeSet = new Set(selectedArcs);
    for (const e of allEntities) {
      if (e.arcs.some((a) => activeSet.has(a)) && e.entityType in counts) {
        counts[e.entityType] += 1;
      }
    }
    return counts;
  }, [allEntities, selectedArcs]);

  if (!dockOpen) {
    return (
      <button
        type="button"
        className={`left-dock-launcher${hasActiveFilters ? ' has-active-filters' : ''}`}
        data-active-filters={hasActiveFilters ? 'true' : 'false'}
        aria-expanded={false}
        aria-label={
          hasActiveFilters
            ? `展开搜索与筛选面板（已启用 ${activeFilterCount} 项筛选）`
            : '展开搜索与筛选面板'
        }
        title="展开搜索与筛选面板（快捷键 /）"
        onClick={() => setDockOpen(true)}
      >
        <SlidersHorizontal size={14} className="launcher-icon" />
        <Search size={13} className="launcher-icon-sub" />
        <span className="launcher-label">搜索 / 筛选</span>
        {hasActiveFilters && (
          <span className="launcher-filter-badge">
            <span className="launcher-filter-dot" />
            <span>{activeFilterCount}</span>
          </span>
        )}
      </button>
    );
  }

  return (
    <aside className="left-control-dock">
      {/* Omnibox Search + Full Panel Minimize Toggle */}
      <div className="dock-top-row">
        <div className="search-box-wrap">
          <Search size={15} className="search-icon" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索角色 / 组织 / 称号 (/)"
            className="search-input"
          />
          {query && (
            <button
              type="button"
              className="clear-icon-btn search-clear-btn"
              onClick={() => setQuery('')}
              aria-label="清空搜索词"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <button
          type="button"
          className="dock-minimize-btn"
          onClick={() => setDockOpen(false)}
          title="收起筛选面板"
          aria-label="收起筛选面板"
          aria-expanded={true}
        >
          <PanelLeftClose size={15} />
          <span className="dock-minimize-label">收起</span>
        </button>
      </div>

      {searchResults.length > 0 && (
        <div className="search-dropdown">
          {searchResults.map((item) => {
            const inActiveArc = item.arcs.some((a) => selectedArcs.includes(a));
            const inCurrentLayer = activeIdSet.has(item.id);
            const targetArc = inActiveArc ? undefined : item.arcs[item.arcs.length - 1];
            const effectiveArc = targetArc ?? selectedArcs[selectedArcs.length - 1];
            const effectiveTier =
              (effectiveArc ? item.arcOverrides?.[effectiveArc]?.importance : undefined) ??
              item.importance;
            const meta = getEntityTypeMeta(item.entityType);
            return (
              <button
                key={item.id}
                type="button"
                className="search-result-row"
                onClick={() => {
                  onSelectAndFocusNode(item.id, targetArc, effectiveTier);
                  setQuery('');
                  collapseIfMobile();
                }}
              >
                <span className="type-dot" style={{ background: meta.color }} />
                <div className="search-row-main">
                  <span className="search-row-name">{item.canonicalName}</span>
                  <span className="search-row-sub">{item.defaultTitle || meta.label}</span>
                </div>
                {!inCurrentLayer && targetArc && (
                  <span className="cross-layer-jump-tag">
                    跳至{arcNameMap.get(targetArc) ?? targetArc}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="dock-header-toggle" onClick={() => setCollapsed((v) => !v)}>
        <span className="dock-section-title">
          <Filter size={13} /> 筛选与关系寻径
        </span>
        {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
      </div>

      {!collapsed && (
        <div className="dock-body">
          {/* 3-Tier Character Prominence / Importance Filter */}
          <div className="filter-group">
            <div className="filter-label">角色密度过滤（应对数百节点规模）</div>
            <div className="tier-segmented">
              {(
                [
                  { id: 'core', label: '★ 核心主线' },
                  { id: 'supporting', label: '★★ 重要配角' },
                  { id: 'minor', label: '★★★ 全量登场' },
                ] as Array<{ id: ImportanceTier; label: string }>
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={maxImportanceTier === item.id ? 'active' : ''}
                  onClick={() => onChangeMaxImportance(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* 5-Tier Entity Ontology Chips */}
          <div className="filter-group">
            <div className="filter-label">实体层级（国家 / 组织 / 家族 / 流派 / 人物）</div>
            <div className="chip-grid">
              {(Object.keys(ENTITY_TYPE_META) as EntityType[]).map((t) => {
                const meta = ENTITY_TYPE_META[t];
                const active = enabledEntityTypes.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    className={`filter-chip ${active ? 'active' : 'muted'}`}
                    onClick={() => onToggleEntityType(t)}
                  >
                    <span className="chip-swatch" style={{ background: meta.color }} />
                    <span>{meta.label}</span>
                    <span className="chip-count">{typeCounts[t]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 7 Relation Categories */}
          <div className="filter-group">
            <div className="filter-label">关系性质图例（点击开关）</div>
            <div className="chip-grid">
              {(Object.keys(RELATION_CATEGORY_META) as RelationCategory[]).map((cat) => {
                const meta = RELATION_CATEGORY_META[cat];
                const active = enabledCategories.has(cat);
                return (
                  <button
                    key={cat}
                    type="button"
                    className={`filter-chip ${active ? 'active' : 'muted'}`}
                    onClick={() => onToggleCategory(cat)}
                  >
                    <span
                      className={`chip-line ${meta.dashed ? 'dashed' : ''}`}
                      style={{ borderColor: meta.color }}
                    />
                    <span>{meta.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* A <-> B Shortest Path Finder */}
          <div className="filter-group pathfinder-box">
            <div className="filter-label">
              <Route size={13} /> A ↔ B 最短关系链路寻径
            </div>
            <div className="path-select-row">
              <select
                value={pathStart}
                onChange={(e) => setPathStart(e.target.value)}
                className="hud-select"
              >
                {activeNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    起点：{n.name}
                  </option>
                ))}
              </select>
              <select
                value={pathEnd}
                onChange={(e) => setPathEnd(e.target.value)}
                className="hud-select"
              >
                {activeNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    终点：{n.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="path-btn-row">
              <button
                type="button"
                className="hud-btn primary-mini"
                disabled={activeNodes.length === 0}
                onClick={() => {
                  onSetPathRange({ startId: pathStart, endId: pathEnd });
                  collapseIfMobile();
                }}
              >
                追踪关系链
              </button>
              {pathRange && (
                <button
                  type="button"
                  className="hud-btn"
                  onClick={() => onSetPathRange(null)}
                >
                  清除高亮
                </button>
              )}
            </div>
            {pathRange && (
              <div className="path-status-note">
                {pathFoundCount && pathFoundCount > 0
                  ? `已锁定最短链路：共跨越 ${pathFoundCount - 1} 层关系（${pathFoundCount} 个节点）`
                  : '当前筛选层内暂无连通路径'}
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
};
