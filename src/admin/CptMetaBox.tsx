import React, { useEffect, useMemo, useState } from 'react';
import {
  EntityRecord,
  GraphDataset,
  isSafeHttpUrl,
  RELATION_CATEGORY_META,
  RelationCategory,
  RelationRecord,
} from '../types/graph';
import { WpAdminBootConfig } from './AdminStudio';

export const CptMetaBox: React.FC<{ boot: WpAdminBootConfig }> = ({ boot }) => {
  const ctx = boot.postContext!;
  const [dataset, setDataset] = useState<GraphDataset | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const [targetInput, setTargetInput] = useState('');
  const [category, setCategory] = useState<RelationCategory>('ally');
  const [label, setLabel] = useState('');
  const [arcId, setArcId] = useState('kuro');

  const isAutoDraft =
    !ctx.permalink ||
    ctx.postTitle.trim() === '' ||
    ctx.postTitle === '自动草稿' ||
    ctx.postTitle === 'Auto Draft';

  const apiFetch = async <T,>(path: string, options?: RequestInit): Promise<T> => {
    const res = await fetch(`${boot.restUrl.replace(/\/$/, '')}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-WP-Nonce': boot.nonce,
      },
    });
    const json = await res.json();
    if (!res.ok) {
      if (res.status === 409) {
        apiFetch<{ dataset: GraphDataset }>('/admin/state')
          .then((fresh) => setDataset(fresh.dataset))
          .catch(() => {});
      }
      throw new Error(json?.message || `HTTP ${res.status}`);
    }
    return json as T;
  };

  useEffect(() => {
    apiFetch<{ dataset: GraphDataset }>('/admin/state')
      .then((res) => setDataset(res.dataset))
      .catch((e) => setMsg(`加载失败: ${e.message}`));
  }, []);

  const entityMap = useMemo(
    () => new Map((dataset?.entities ?? []).map((e) => [e.id, e])),
    [dataset]
  );

  const linkedEntity = useMemo(() => {
    if (!dataset) return undefined;
    return (
      dataset.entities.find((e) => e.wpPostId === ctx.postId) ||
      (ctx.postTitle.trim()
        ? dataset.entities.find((e) => e.canonicalName === ctx.postTitle.trim())
        : undefined)
    );
  }, [dataset, ctx]);

  if (!dataset) {
    return <div className="kr-metabox-wrap">正在读取静态关系图谱…</div>;
  }

  const handleBindOrCreateNode = async () => {
    if (isAutoDraft) {
      setMsg('请先填写词条标题并保存/发布文章后再绑定关系图谱');
      return;
    }
    setBusy(true);
    try {
      const entityType =
        ctx.postType === 'region'
          ? 'nation'
          : ctx.postType === 'org'
            ? 'organization'
            : 'character';
      const safePermalink = isSafeHttpUrl(ctx.permalink) ? ctx.permalink.trim() : undefined;
      const safeAvatar = isSafeHttpUrl(ctx.avatarUrl) ? ctx.avatarUrl.trim() : undefined;

      const ent: EntityRecord = linkedEntity
        ? {
            ...linkedEntity,
            wpPostId: ctx.postId,
            ...(safePermalink ? { wikiUrl: safePermalink } : {}),
            ...(safeAvatar ? { defaultAvatarUrl: safeAvatar } : {}),
          }
        : {
            id: `wp-${ctx.postId}`,
            canonicalName: ctx.postTitle.trim() || `词条-${ctx.postId}`,
            entityType,
            importance: 'supporting',
            wpPostId: ctx.postId,
            ...(safePermalink ? { wikiUrl: safePermalink } : {}),
            ...(safeAvatar ? { defaultAvatarUrl: safeAvatar } : {}),
            arcs: ['kuro'],
            bio: '',
          };
      const res = await apiFetch<{ dataset: GraphDataset }>('/admin/patch', {
        method: 'POST',
        body: JSON.stringify({
          action: 'upsert_entity',
          entity: ent,
          baseVersion: dataset.version,
          summary: `从文章页同步词条 #${ctx.postId}`,
        }),
      });
      setDataset(res.dataset);
      setMsg('✓ 已同步本词条链接与特色头像至关系图谱');
    } catch (e) {
      setMsg(`保存失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleAddEdge = async () => {
    if (!linkedEntity || !targetInput.trim() || !label.trim()) return;
    const bracket = targetInput.trim().match(/\[([^\]]+)\]$/);
    const tid = bracket ? bracket[1] : targetInput.trim();
    const targetEnt =
      entityMap.get(tid) ||
      dataset.entities.find((e) => e.canonicalName === targetInput.trim());
    if (!targetEnt || targetEnt.id === linkedEntity.id) {
      setMsg('请选择有效的目标实体');
      return;
    }
    setBusy(true);
    try {
      const rel: RelationRecord = {
        id: `rel-mb-${Date.now()}`,
        source: linkedEntity.id,
        target: targetEnt.id,
        category,
        label: label.trim(),
        direction: 'bidirectional',
        weight: 4,
        arcs: [arcId],
        status: 'published',
      };
      const res = await apiFetch<{ dataset: GraphDataset }>('/admin/patch', {
        method: 'POST',
        body: JSON.stringify({
          action: 'upsert_relation',
          relation: rel,
          baseVersion: dataset.version,
          summary: `从文章页新增关系 ${linkedEntity.canonicalName} <-> ${targetEnt.canonicalName}`,
          ensureEntityArcs: [
            { entityId: linkedEntity.id, arcId },
            { entityId: targetEnt.id, arcId },
          ],
        }),
      });
      setDataset(res.dataset);
      setLabel('');
      setTargetInput('');
      setMsg(`✓ 已新增与「${targetEnt.canonicalName}」的关系`);
    } catch (e) {
      setMsg(`失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteEdge = async (relId: string, relLabel: string) => {
    setBusy(true);
    try {
      const res = await apiFetch<{ dataset: GraphDataset }>('/admin/patch', {
        method: 'POST',
        body: JSON.stringify({
          action: 'delete_relation',
          relationId: relId,
          baseVersion: dataset.version,
          summary: `从文章页删除关系 ${relLabel}`,
        }),
      });
      setDataset(res.dataset);
      setMsg(`✓ 已移除关系「${relLabel}」`);
    } catch (e) {
      setMsg(`删除失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const edges = linkedEntity
    ? dataset.relations.filter(
        (r) => r.source === linkedEntity.id || r.target === linkedEntity.id
      )
    : [];

  return (
    <div className="kr-metabox-wrap">
      {msg && <div className="kr-mb-notice">{msg}</div>}

      {!linkedEntity ? (
        <div className="kr-mb-empty">
          <p>本百科词条尚未关联到《塞姆利亚导力关系图谱》中的节点。</p>
          {isAutoDraft && (
            <p className="kr-muted">
              当前文章为未保存草稿，请先填写标题并保存/发布文章后再绑定关系图谱。
            </p>
          )}
          <button
            type="button"
            className="kr-btn primary"
            disabled={busy || isAutoDraft}
            onClick={handleBindOrCreateNode}
          >
            + 一键将本词条加入关系图谱
          </button>
        </div>
      ) : (
        <>
          <div className="kr-mb-head">
            <span>
              已绑定节点：<strong>{linkedEntity.canonicalName}</strong> (
              <code>{linkedEntity.id}</code>) · 共 {edges.length} 条关系
            </span>
            <button
              type="button"
              className="kr-btn secondary small"
              disabled={busy || isAutoDraft}
              onClick={handleBindOrCreateNode}
            >
              同步本文链接与特色头像
            </button>
          </div>

          <div className="kr-mb-quickrow">
            <input
              list="kr-mb-datalist"
              value={targetInput}
              onChange={(e) => setTargetInput(e.target.value)}
              placeholder="关联目标角色/组织…"
              className="kr-input compact"
            />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as RelationCategory)}
              className="kr-select compact"
            >
              {(Object.keys(RELATION_CATEGORY_META) as RelationCategory[]).map((c) => (
                <option key={c} value={c}>
                  {RELATION_CATEGORY_META[c].label}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="关系描述词…"
              className="kr-input compact"
            />
            <select
              value={arcId}
              onChange={(e) => setArcId(e.target.value)}
              className="kr-select compact"
            >
              {dataset.arcs.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.shortName}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="kr-btn primary small"
              disabled={busy}
              onClick={handleAddEdge}
            >
              + 添加
            </button>
            <datalist id="kr-mb-datalist">
              {dataset.entities.map((ent) => (
                <option key={ent.id} value={`${ent.canonicalName} [${ent.id}]`} />
              ))}
            </datalist>
          </div>

          <div className="kr-mb-edges">
            {edges.map((r) => {
              const otherId = r.source === linkedEntity.id ? r.target : r.source;
              const other = entityMap.get(otherId);
              return (
                <span key={r.id} className="kr-mb-pill">
                  <strong>{other?.canonicalName ?? otherId}</strong>：{r.label}{' '}
                  <em>[{r.arcs.join(',')}]</em>
                  <button
                    type="button"
                    className="kr-mb-pill-del"
                    disabled={busy}
                    title="删除此关系"
                    onClick={() => handleDeleteEdge(r.id, r.label)}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};
