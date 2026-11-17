import React, { useEffect, useState } from 'react';
import { X, PlusCircle, GitBranchPlus } from 'lucide-react';
import {
  ArcDefinition,
  EntityRecord,
  RELATION_CATEGORY_META,
  RelationCategory,
  RelationRecord,
} from '../types/graph';

interface QuickEditModalProps {
  isOpen: boolean;
  initialEvolveRelationId: string | null;
  arcs: ArcDefinition[];
  entities: EntityRecord[];
  relations: RelationRecord[];
  defaultArcs: string[];
  onClose: () => void;
  onAddRelation: (
    newRel: RelationRecord,
    ensureEntityArcs: Array<{ entityId: string; arcId: string }>
  ) => void;
}

export const QuickEditModal: React.FC<QuickEditModalProps> = ({
  isOpen,
  initialEvolveRelationId,
  arcs,
  entities,
  relations,
  defaultArcs,
  onClose,
  onAddRelation,
}) => {
  const [tab, setTab] = useState<'quick-add' | 'evolve'>('quick-add');
  const [sourceId, setSourceId] = useState('van-arkride');
  const [targetId, setTargetId] = useState('shizuna-rem');
  const [category, setCategory] = useState<RelationCategory>('ally');
  const [label, setLabel] = useState('黑神一刀流切磋与雇佣共斗');
  const [direction, setDirection] = useState<'directed' | 'bidirectional'>('bidirectional');
  const [pickedArcs, setPickedArcs] = useState<string[]>(defaultArcs.length ? defaultArcs : ['kuro']);

  // Evolve tab state
  const [baseRelId, setBaseRelId] = useState<string>(relations[0]?.id ?? '');
  const [evolveArc, setEvolveArc] = useState<string>('kuro');
  const [evolveTargetId, setEvolveTargetId] = useState<string>('cid');
  const [evolveCategory, setEvolveCategory] = useState<RelationCategory>('membership');
  const [evolveLabel, setEvolveLabel] = useState<string>('统合分析室室长（卸任归国）');

  useEffect(() => {
    if (initialEvolveRelationId) {
      setTab('evolve');
      setBaseRelId(initialEvolveRelationId);
      const found = relations.find((r) => r.id === initialEvolveRelationId);
      if (found) {
        setEvolveTargetId(found.target);
        setEvolveCategory(found.category);
        setEvolveLabel(`${found.label}（新作演变）`);
      }
    } else {
      setTab('quick-add');
    }
  }, [initialEvolveRelationId, relations, isOpen]);

  if (!isOpen) return null;

  const entityMap = new Map(entities.map((e) => [e.id, e]));

  const togglePickedArc = (arcId: string) => {
    setPickedArcs((prev) =>
      prev.includes(arcId)
        ? prev.length > 1
          ? prev.filter((a) => a !== arcId)
          : prev
        : [...prev, arcId]
    );
  };

  const handleQuickSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceId || !targetId || sourceId === targetId || !label.trim()) return;
    const newRel: RelationRecord = {
      id: `rel-custom-${Date.now()}`,
      source: sourceId,
      target: targetId,
      category,
      label: label.trim(),
      direction,
      weight: 4,
      arcs: pickedArcs,
      note: '通过后端「3秒快捷录入」实时新增',
    };
    const ensure: Array<{ entityId: string; arcId: string }> = [];
    for (const a of pickedArcs) {
      ensure.push({ entityId: sourceId, arcId: a });
      ensure.push({ entityId: targetId, arcId: a });
    }
    onAddRelation(newRel, ensure);
    onClose();
  };

  const handleEvolveSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const base = relations.find((r) => r.id === baseRelId);
    if (!base || !evolveLabel.trim()) return;
    const newRel: RelationRecord = {
      id: `rel-evolved-${Date.now()}`,
      source: base.source,
      target: evolveTargetId,
      category: evolveCategory,
      label: evolveLabel.trim(),
      direction: base.direction,
      weight: 4,
      arcs: [evolveArc],
      supersedesId: base.id,
      note: `由前作关系「${base.label}」演变而来`,
    };
    onAddRelation(newRel, [
      { entityId: base.source, arcId: evolveArc },
      { entityId: evolveTargetId, arcId: evolveArc },
    ]);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="quick-edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>WordPress 插件后台 · 关系快捷维护预览</h3>
            <p>无需编辑 Excel 或重跑脚本：在后台工作台或角色文章页即可秒级录入并自动生成静态缓存。</p>
          </div>
          <button type="button" className="clear-icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-tabs">
          <button
            type="button"
            className={tab === 'quick-add' ? 'active' : ''}
            onClick={() => setTab('quick-add')}
          >
            <PlusCircle size={15} /> 3秒快捷新增并行关系
          </button>
          <button
            type="button"
            className={tab === 'evolve' ? 'active' : ''}
            onClick={() => setTab('evolve')}
          >
            <GitBranchPlus size={15} /> 跨作品关系演变 (Supersede)
          </button>
        </div>

        {tab === 'quick-add' ? (
          <form onSubmit={handleQuickSubmit} className="modal-form">
            <div className="form-grid-3">
              <label>
                <span>源实体 (Source)</span>
                <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="hud-select">
                  {entities.map((ent) => (
                    <option key={ent.id} value={ent.id}>
                      {ent.canonicalName}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>关系大类</span>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as RelationCategory)}
                  className="hud-select"
                >
                  {(Object.keys(RELATION_CATEGORY_META) as RelationCategory[]).map((c) => (
                    <option key={c} value={c}>
                      {RELATION_CATEGORY_META[c].label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>目标实体 (Target)</span>
                <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="hud-select">
                  {entities.map((ent) => (
                    <option key={ent.id} value={ent.id}>
                      {ent.canonicalName}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="form-grid-2">
              <label>
                <span>关系描述词（支持同一对节点多重并行边）</span>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="hud-input"
                  placeholder="例如：青梅竹马 / 宿命劲敌 / 委托雇主"
                />
              </label>

              <label>
                <span>方向性</span>
                <select
                  value={direction}
                  onChange={(e) => setDirection(e.target.value as 'directed' | 'bidirectional')}
                  className="hud-select"
                >
                  <option value="bidirectional">双向对等 (A ⟷ B)</option>
                  <option value="directed">单向指向 (A ⟶ B)</option>
                </select>
              </label>
            </div>

            <div className="arc-check-group">
              <span>所属作品层（若跨作选定旧角色，将自动复用同一实体ID并加入该作品层）：</span>
              <div className="arc-badge-row">
                {arcs.map((arc) => {
                  const checked = pickedArcs.includes(arc.id);
                  return (
                    <button
                      key={arc.id}
                      type="button"
                      className={`arc-pill ${checked ? 'active' : ''}`}
                      onClick={() => togglePickedArc(arc.id)}
                    >
                      {checked ? '✓ ' : ''}
                      {arc.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="modal-submit-row">
              <button type="button" className="hud-btn" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="hud-btn accent-btn">
                立即写入并实时刷新图谱
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleEvolveSubmit} className="modal-form">
            <label>
              <span>选择前作既有关系作为演变起点</span>
              <select
                value={baseRelId}
                onChange={(e) => {
                  const id = e.target.value;
                  setBaseRelId(id);
                  const r = relations.find((item) => item.id === id);
                  if (r) {
                    setEvolveTargetId(r.target);
                    setEvolveCategory(r.category);
                    setEvolveLabel(`${r.label}（后续演变）`);
                  }
                }}
                className="hud-select"
              >
                {relations.map((r) => {
                  const sName = entityMap.get(r.source)?.canonicalName ?? r.source;
                  const tName = entityMap.get(r.target)?.canonicalName ?? r.target;
                  return (
                    <option key={r.id} value={r.id}>
                      [{r.arcs.join(',')}] {sName} ⟶ {tName} ：{r.label}
                    </option>
                  );
                })}
              </select>
            </label>

            <div className="form-grid-3">
              <label>
                <span>演变生效的新作品层</span>
                <select
                  value={evolveArc}
                  onChange={(e) => setEvolveArc(e.target.value)}
                  className="hud-select"
                >
                  {arcs.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>新目标实体（可保持原目标或改投新组织）</span>
                <select
                  value={evolveTargetId}
                  onChange={(e) => setEvolveTargetId(e.target.value)}
                  className="hud-select"
                >
                  {entities.map((ent) => (
                    <option key={ent.id} value={ent.id}>
                      {ent.canonicalName}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>新关系大类</span>
                <select
                  value={evolveCategory}
                  onChange={(e) => setEvolveCategory(e.target.value as RelationCategory)}
                  className="hud-select"
                >
                  {(Object.keys(RELATION_CATEGORY_META) as RelationCategory[]).map((c) => (
                    <option key={c} value={c}>
                      {RELATION_CATEGORY_META[c].label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label>
              <span>演变后的新关系描述词</span>
              <input
                type="text"
                value={evolveLabel}
                onChange={(e) => setEvolveLabel(e.target.value)}
                className="hud-input"
              />
            </label>

            <div className="modal-submit-row">
              <button type="button" className="hud-btn" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="hud-btn accent-btn">
                生成跨作演变弧 (✦ Supersede)
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
