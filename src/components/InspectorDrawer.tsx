import React, { useEffect, useMemo, useState } from 'react';
import {
  X,
  ExternalLink,
  GitCommitHorizontal,
  BookOpen,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import {
  ArcDefinition,
  EntityRecord,
  getEntityTypeMeta,
  getRelationCategoryMeta,
  isSafeHttpUrl,
  RelationRecord,
  ResolvedLink,
  ResolvedNode,
} from '../types/graph';

interface InspectorDrawerProps {
  arcs: ArcDefinition[];
  selectedNode: ResolvedNode | null;
  selectedLink: ResolvedLink | null;
  activeLinks: ResolvedLink[];
  nodeMap: Map<string, ResolvedNode>;
  allEntities: EntityRecord[];
  allRelations: RelationRecord[];
  onClose: () => void;
  onSelectNode: (nodeId: string) => void;
  onSwitchArc: (arcId: string) => void;
  onEvolveRelation: (relationId: string) => void;
}

export const InspectorDrawer: React.FC<InspectorDrawerProps> = ({
  arcs,
  selectedNode,
  selectedLink,
  activeLinks,
  nodeMap,
  allEntities,
  allRelations,
  onClose,
  onSelectNode,
  onSwitchArc,
  onEvolveRelation,
}) => {
  const [avatarFailed, setAvatarFailed] = useState(false);

  useEffect(() => {
    setAvatarFailed(false);
  }, [selectedNode?.id, selectedNode?.avatarUrl]);

  const entityLookup = useMemo(
    () => new Map(allEntities.map((e) => [e.id, e])),
    [allEntities]
  );
  const arcLookup = useMemo(() => new Map(arcs.map((a) => [a.id, a])), [arcs]);

  if (!selectedNode && !selectedLink) return null;

  // Link Inspector
  if (selectedLink && !selectedNode) {
    const s = nodeMap.get(selectedLink.sourceId);
    const t = nodeMap.get(selectedLink.targetId);
    const catMeta = getRelationCategoryMeta(selectedLink.category);
    return (
      <aside className="inspector-drawer">
        <div className="drawer-header">
          <span
            className="entity-type-pill"
            style={{ color: catMeta.color, background: `${catMeta.color}22` }}
          >
            关系弧详情 · {catMeta.label}
          </span>
          <button type="button" className="clear-icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="edge-hero-card">
          <button type="button" className="edge-endpoint" onClick={() => s && onSelectNode(s.id)}>
            {s?.name ?? selectedLink.sourceId}
          </button>
          <span className="edge-arrow-badge" style={{ color: catMeta.color }}>
            {selectedLink.direction === 'bidirectional' ? '⟷' : '⟶'} {selectedLink.label}
          </span>
          <button type="button" className="edge-endpoint" onClick={() => t && onSelectNode(t.id)}>
            {t?.name ?? selectedLink.targetId}
          </button>
        </div>

        <div className="drawer-section">
          <div className="section-heading">生效作品层</div>
          <div className="arc-badge-row">
            {selectedLink.arcs.map((aid) => {
              const a = arcLookup.get(aid);
              return (
                <span key={aid} className="mini-arc-tag" style={{ borderColor: a?.accent }}>
                  {a?.name ?? aid}
                </span>
              );
            })}
          </div>
        </div>

        {selectedLink.priorLabel && (
          <div className="drawer-section evolution-callout">
            <div className="section-heading">✦ 跨作品演变历史</div>
            <p className="drawer-prose">
              前作（{selectedLink.priorArcs?.map((id) => arcLookup.get(id)?.shortName ?? id).join(' / ')}）关系为
              <strong>「{selectedLink.priorLabel}」</strong>，在本作演变为
              <strong>「{selectedLink.label}」</strong>。
            </p>
          </div>
        )}

        {selectedLink.note && (
          <div className="drawer-section">
            <div className="section-heading">补充考据</div>
            <p className="drawer-prose">{selectedLink.note}</p>
          </div>
        )}

        <div className="drawer-footer-actions">
          <button
            type="button"
            className="hud-btn accent-btn full-width"
            onClick={() => onEvolveRelation(selectedLink.id)}
          >
            <Sparkles size={14} /> 在新作品层演变此关系
          </button>
        </div>
      </aside>
    );
  }

  // Node Inspector
  const node = selectedNode!;
  const typeMeta = getEntityTypeMeta(node.entityType);
  const connectedLinks = activeLinks.filter(
    (l) => l.sourceId === node.id || l.targetId === node.id
  );

  // All cross-arc relations involving this entity (even outside currently selected arc!)
  const crossArcEvolutionItems = allRelations.filter(
    (r) =>
      (r.source === node.id || r.target === node.id) &&
      (Boolean(r.supersedesId) || allRelations.some((child) => child.supersedesId === r.id))
  );

  const primaryOrg = node.primaryGroupId ? entityLookup.get(node.primaryGroupId) : undefined;
  const safeWikiUrl = isSafeHttpUrl(node.wikiUrl) ? node.wikiUrl.trim() : null;

  return (
    <aside className="inspector-drawer">
      <div className="drawer-header">
        <span
          className="entity-type-pill"
          style={{ color: typeMeta.color, background: typeMeta.badgeBg }}
        >
          {typeMeta.label}
        </span>
        <button type="button" className="clear-icon-btn" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <div className="node-hero-header">
        <div className="hero-avatar-box" style={{ borderColor: typeMeta.color }}>
          {node.avatarUrl && !avatarFailed ? (
            <img
              src={node.avatarUrl}
              alt={node.name}
              crossOrigin="anonymous"
              onError={() => setAvatarFailed(true)}
            />
          ) : (
            <span className="hero-monogram">{node.name.slice(0, 2)}</span>
          )}
        </div>
        <div className="hero-titles">
          <h2>{node.name}</h2>
          {node.nameEn && <div className="hero-en">{node.nameEn}</div>}
          {node.title && <div className="hero-role">{node.title}</div>}
          {primaryOrg && (
            <div className="hero-org-chip">
              当前归属：
              <button
                type="button"
                className="inline-jump-link"
                onClick={() => {
                  if (nodeMap.has(primaryOrg.id)) onSelectNode(primaryOrg.id);
                }}
              >
                {primaryOrg.canonicalName}
              </button>
            </div>
          )}
        </div>
      </div>

      <p className="drawer-prose">{node.bio}</p>

      {/* Cross-Arc Identity & Relationship Evolution Card */}
      {(node.raw.arcOverrides || crossArcEvolutionItems.length > 0) && (
        <div className="drawer-section evolution-callout">
          <div className="section-heading">
            <GitCommitHorizontal size={14} /> 跨作品身份与关系演变（点击切换对应作品层）
          </div>
          <div className="evolution-timeline">
            {arcs
              .filter((a) => node.arcs.includes(a.id))
              .map((arc) => {
                const ov = node.raw.arcOverrides?.[arc.id];
                const orgName = ov?.primaryGroupId
                  ? entityLookup.get(ov.primaryGroupId)?.canonicalName
                  : primaryOrg?.canonicalName;
                return (
                  <div
                    key={arc.id}
                    className="evo-step-card"
                    onClick={() => onSwitchArc(arc.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="evo-step-top">
                      <span className="evo-arc-pill" style={{ color: arc.accent }}>
                        {arc.name}
                      </span>
                      <span className="evo-jump-hint">点击切层 →</span>
                    </div>
                    <div className="evo-step-name">
                      {ov?.displayName ?? node.canonicalName}
                      {orgName ? ` · ${orgName}` : ''}
                    </div>
                    <div className="evo-step-sub">{ov?.title ?? node.raw.defaultTitle}</div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Script Quotes across Kiseki Arcs */}
      {node.raw.scriptMoments && node.raw.scriptMoments.length > 0 && (
        <div className="drawer-section">
          <div className="section-heading">
            <BookOpen size={14} /> 剧本与角色经典台词摘录
          </div>
          {node.raw.scriptMoments.map((m, idx) => (
            <blockquote key={idx} className="script-quote-card">
              <div className="quote-meta">
                {m.chapter} · {m.speaker}
              </div>
              <div className="quote-text">「{m.quote}」</div>
            </blockquote>
          ))}
        </div>
      )}

      {/* Active Layer Connections */}
      <div className="drawer-section">
        <div className="section-heading">当前层关联网络（{connectedLinks.length} 条）</div>
        <div className="relation-list">
          {connectedLinks.map((link) => {
            const isOutgoing = link.sourceId === node.id;
            const otherId = isOutgoing ? link.targetId : link.sourceId;
            const other = nodeMap.get(otherId);
            if (!other) return null;
            const catMeta = getRelationCategoryMeta(link.category);
            return (
              <div key={link.id} className="relation-row">
                <button
                  type="button"
                  className="relation-target-btn"
                  onClick={() => onSelectNode(other.id)}
                >
                  <span className="type-dot" style={{ background: catMeta.color }} />
                  <span className="rel-other-name">{other.name}</span>
                  <ArrowRight size={12} className="rel-arrow-ico" />
                  <span className="rel-badge-txt" style={{ color: catMeta.color }}>
                    {link.priorLabel ? `✦ ${link.label}` : link.label}
                  </span>
                </button>
                <button
                  type="button"
                  className="mini-evolve-btn"
                  title="在新作品层演变此关系"
                  onClick={() => onEvolveRelation(link.id)}
                >
                  演变
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {safeWikiUrl && (
        <div className="drawer-footer-actions">
          <a
            href={safeWikiUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hud-btn full-width wiki-link-btn"
          >
            <span>打开 trails-game.com 百科词条</span>
            <ExternalLink size={14} />
          </a>
        </div>
      )}
    </aside>
  );
};
