import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import {
  ArcDefinition,
  ArcProfileOverride,
  ENTITY_TYPE_META,
  EntityRecord,
  EntityType,
  getEntityTypeMeta,
  getRelationCategoryMeta,
  GraphDataset,
  ImportanceTier,
  isSafeHttpUrl,
  isSafeNavUrl,
  RELATION_CATEGORY_META,
  RelationCategory,
  RelationRecord,
  ResolvedLink,
} from '../types/graph';
import { resolveGraph } from '../engine/resolveGraph';
import { Graph2DView } from '../components/Graph2DView';

export interface WpAdminBootConfig {
  restUrl: string;
  nonce: string;
  currentUser: string;
  userRoles: string[];
  frontendPreviewUrl: string;
  postContext?: {
    postId: number;
    postTitle: string;
    postType: string;
    permalink: string;
    avatarUrl: string;
  };
}

interface ManifestInfo {
  currentVersion: number;
  updatedAt: string;
  updatedBy: string;
  file: string;
  fileUrl: string;
}

interface BackupEntry {
  file: string;
  version: number;
  timestamp: string;
  user: string;
  sizeKb: number;
}

interface WpSearchItem {
  id: number;
  postType: string;
  title: string;
  link: string;
  avatarUrl: string;
  excerpt: string;
}

declare global {
  interface Window {
    wp?: {
      media?: (opts: Record<string, unknown>) => {
        on: (ev: string, cb: () => void) => void;
        open: () => void;
        state: () => {
          get: (k: string) => {
            first: () => { toJSON: () => { url?: string; sizes?: { thumbnail?: { url?: string } } } };
          };
        };
      };
    };
  }
}

const EMPTY_SET = new Set<string>();
const ALL_ENTITY_TYPES_SET = new Set<EntityType>(Object.keys(ENTITY_TYPE_META) as EntityType[]);
const ALL_CATEGORIES_SET = new Set<RelationCategory>(
  Object.keys(RELATION_CATEGORY_META) as RelationCategory[]
);
const NOOP = () => {};
const REL_PAGE_SIZE = 40;
const ENT_PAGE_SIZE = 50;

type RelationStatus = 'published' | 'pending_review' | 'draft';

function sanitizeEntityForSave(
  raw: EntityRecord,
  aliasesDraft: string,
  fallbackArc: string
): EntityRecord {
  const parsedAliases = aliasesDraft
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const cleanedOverrides: Record<string, ArcProfileOverride> = {};
  if (raw.arcOverrides) {
    for (const [arcKey, ov] of Object.entries(raw.arcOverrides)) {
      if (!ov) continue;
      const nextOv: ArcProfileOverride = {};
      if (ov.displayName?.trim()) nextOv.displayName = ov.displayName.trim();
      if (ov.title?.trim()) nextOv.title = ov.title.trim();
      if (ov.primaryGroupId?.trim()) nextOv.primaryGroupId = ov.primaryGroupId.trim();
      if (isSafeHttpUrl(ov.avatarUrl)) nextOv.avatarUrl = ov.avatarUrl.trim();
      if (ov.importance === 'core' || ov.importance === 'supporting' || ov.importance === 'minor') {
        nextOv.importance = ov.importance;
      }
      if (ov.bio?.trim()) nextOv.bio = ov.bio.trim();
      if (Object.keys(nextOv).length > 0) {
        cleanedOverrides[arcKey] = nextOv;
      }
    }
  }

  const safeArcs = raw.arcs.filter(Boolean);
  const entity: EntityRecord = {
    id: raw.id.trim(),
    canonicalName: raw.canonicalName.trim(),
    entityType: raw.entityType in ENTITY_TYPE_META ? raw.entityType : 'character',
    importance:
      raw.importance === 'core' || raw.importance === 'supporting' || raw.importance === 'minor'
        ? raw.importance
        : 'supporting',
    arcs: safeArcs.length > 0 ? Array.from(new Set(safeArcs)) : [fallbackArc],
    bio: raw.bio ?? '',
  };

  if (raw.nameEn?.trim()) entity.nameEn = raw.nameEn.trim();
  if (raw.subtype?.trim()) entity.subtype = raw.subtype.trim();
  if (raw.nationId?.trim()) entity.nationId = raw.nationId.trim();
  if (raw.defaultGroupId?.trim()) entity.defaultGroupId = raw.defaultGroupId.trim();
  if (raw.defaultTitle?.trim()) entity.defaultTitle = raw.defaultTitle.trim();
  if (raw.wpPostId && Number.isFinite(raw.wpPostId)) entity.wpPostId = Number(raw.wpPostId);
  if (isSafeHttpUrl(raw.defaultAvatarUrl)) entity.defaultAvatarUrl = raw.defaultAvatarUrl.trim();
  if (isSafeHttpUrl(raw.wikiUrl)) entity.wikiUrl = raw.wikiUrl.trim();
  if (parsedAliases.length > 0) entity.aliases = Array.from(new Set(parsedAliases));
  if (Object.keys(cleanedOverrides).length > 0) entity.arcOverrides = cleanedOverrides;
  if (raw.scriptMoments && raw.scriptMoments.length > 0) entity.scriptMoments = raw.scriptMoments;

  return entity;
}

export const AdminStudio: React.FC<{ boot: WpAdminBootConfig }> = ({ boot }) => {
  const [dataset, setDataset] = useState<GraphDataset | null>(null);
  const [manifest, setManifest] = useState<ManifestInfo | null>(null);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const [activeTab, setActiveTab] = useState<'canvas' | 'relations' | 'entities' | 'arcs' | 'io'>('canvas');
  const [studioArc, setStudioArc] = useState<string>('kuro');
  const [studioTier, setStudioTier] = useState<ImportanceTier>('supporting');

  // Quick-add bar state
  const [qaSource, setQaSource] = useState('');
  const [qaTarget, setQaTarget] = useState('');
  const [qaCategory, setQaCategory] = useState<RelationCategory>('ally');
  const [qaLabel, setQaLabel] = useState('');
  const [qaDir, setQaDir] = useState<'directed' | 'bidirectional'>('bidirectional');
  const [qaArcs, setQaArcs] = useState<string[]>(['kuro']);
  const [qaSupersedesId, setQaSupersedesId] = useState<string>('');

  // Visual Canvas state
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>('van-arkride');
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<ResolvedLink | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connectFirstNodeId, setConnectFirstNodeId] = useState<string | null>(null);
  const [canvasFullscreen, setCanvasFullscreen] = useState(false);
  const canvasSplitRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (activeTab !== 'canvas' && canvasFullscreen) {
      setCanvasFullscreen(false);
    }
  }, [activeTab, canvasFullscreen]);

  useEffect(() => {
    if (!canvasFullscreen || activeTab !== 'canvas' || typeof document === 'undefined') {
      return;
    }

    document.documentElement.classList.add('kr-studio-fullscreen-active');
    document.body.classList.add('kr-studio-fullscreen-active');

    const modified: Array<{ el: HTMLElement; prevStyleAttr: string | null }> = [];
    let parent = canvasSplitRef.current?.parentElement ?? null;
    while (parent && parent !== document.documentElement) {
      const cs = window.getComputedStyle(parent);
      const overrides: Array<[string, string]> = [];
      for (const prop of ['transform', 'translate', 'rotate', 'scale', 'filter', 'perspective', 'contain', 'clip-path']) {
        const val = cs.getPropertyValue(prop).trim();
        if (val !== '' && val !== 'none') overrides.push([prop, 'none']);
      }
      if (
        (cs.getPropertyValue('backdrop-filter').trim() !== '' && cs.getPropertyValue('backdrop-filter').trim() !== 'none') ||
        (cs.getPropertyValue('-webkit-backdrop-filter').trim() !== '' && cs.getPropertyValue('-webkit-backdrop-filter').trim() !== 'none')
      ) {
        overrides.push(['backdrop-filter', 'none'], ['-webkit-backdrop-filter', 'none']);
      }
      if (cs.position !== 'static' && cs.zIndex !== 'auto') {
        overrides.push(['z-index', '2147483000']);
      }
      if (overrides.length > 0) {
        modified.push({ el: parent, prevStyleAttr: parent.getAttribute('style') });
        for (const [prop, val] of overrides) {
          parent.style.setProperty(prop, val, 'important');
        }
      }
      parent = parent.parentElement;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setCanvasFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      for (const { el, prevStyleAttr } of modified) {
        if (prevStyleAttr === null) el.removeAttribute('style');
        else el.setAttribute('style', prevStyleAttr);
      }
      document.documentElement.classList.remove('kr-studio-fullscreen-active');
      document.body.classList.remove('kr-studio-fullscreen-active');
    };
  }, [canvasFullscreen, activeTab]);

  // Relations Table filters
  const [relQuery, setRelQuery] = useState('');
  const [relArcFilter, setRelArcFilter] = useState<string>('all');
  const [relCatFilter, setRelCatFilter] = useState<string>('all');
  const [relStatusFilter, setRelStatusFilter] = useState<string>('all');
  const [relPage, setRelPage] = useState(1);

  // Entities Table & Editor state
  const [entQuery, setEntQuery] = useState('');
  const [entTypeFilter, setEntTypeFilter] = useState<string>('all');
  const [entTierFilter, setEntTierFilter] = useState<string>('all');
  const [entPage, setEntPage] = useState(1);
  const [editingEntity, setEditingEntity] = useState<EntityRecord | null>(null);
  const [isNewEntity, setIsNewEntity] = useState(false);
  const [aliasesDraft, setAliasesDraft] = useState('');
  const [overrideArcId, setOverrideArcId] = useState<string>('kuro');
  const [wpSearchTerm, setWpSearchTerm] = useState('');
  const [wpSearchHits, setWpSearchHits] = useState<WpSearchItem[]>([]);

  // Arc Manager state
  const [editingArcId, setEditingArcId] = useState<string | null>(null);
  const [newArcId, setNewArcId] = useState('');
  const [newArcName, setNewArcName] = useState('');
  const [newArcShort, setNewArcShort] = useState('');
  const [newArcSub, setNewArcSub] = useState('');
  const [newArcOrder, setNewArcOrder] = useState<number>(50);
  const [newArcAccent, setNewArcAccent] = useState('#a78bfa');

  // Import state
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importFormat, setImportFormat] = useState<'json' | 'csv' | 'xlsx'>('json');
  const [importText, setImportText] = useState('');
  const [importFileName, setImportFileName] = useState('');

  const showToast = useCallback((kind: 'ok' | 'err', msg: string) => {
    setToast({ kind, msg });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const refreshAdminState = useCallback(async () => {
    const res = await fetch(`${boot.restUrl.replace(/\/$/, '')}/admin/state`, {
      headers: {
        'Content-Type': 'application/json',
        'X-WP-Nonce': boot.nonce,
      },
    });
    if (res.ok) {
      const data = (await res.json()) as {
        dataset: GraphDataset;
        manifest: ManifestInfo;
        backups: BackupEntry[];
      };
      setDataset(data.dataset);
      setManifest(data.manifest);
      setBackups(data.backups ?? []);
    }
  }, [boot.nonce, boot.restUrl]);

  const apiFetch = useCallback(
    async <T,>(path: string, options?: RequestInit): Promise<T> => {
      const res = await fetch(`${boot.restUrl.replace(/\/$/, '')}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'X-WP-Nonce': boot.nonce,
          ...(options?.headers ?? {}),
        },
      });
      const json = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          refreshAdminState().catch(() => {});
        }
        throw new Error(json?.message || `HTTP ${res.status}`);
      }
      return json as T;
    },
    [boot.nonce, boot.restUrl, refreshAdminState]
  );

  useEffect(() => {
    setBusy(true);
    apiFetch<{ dataset: GraphDataset; manifest: ManifestInfo; backups: BackupEntry[] }>('/admin/state')
      .then((res) => {
        setDataset(res.dataset);
        setManifest(res.manifest);
        setBackups(res.backups ?? []);
        // Check URL `&evolve=...` deep link from frontend viewer
        const params = new URLSearchParams(window.location.search);
        const evoId = params.get('evolve');
        if (evoId && res.dataset.relations) {
          const found = res.dataset.relations.find((r) => r.id === evoId);
          if (found) {
            setQaSource(found.source);
            setQaTarget(found.target);
            setQaCategory(found.category);
            setQaLabel(`${found.label}（新作演变）`);
            setQaSupersedesId(found.id);
          }
        }
      })
      .catch((err) => showToast('err', `加载失败：${err.message}`))
      .finally(() => setBusy(false));
  }, [apiFetch, showToast]);

  const submitPatch = async (payload: Record<string, unknown>, okMessage: string) => {
    setBusy(true);
    try {
      const baseVersion = manifest?.currentVersion ?? dataset?.version;
      const res = await apiFetch<{
        dataset: GraphDataset;
        manifest: ManifestInfo;
        backups: BackupEntry[];
      }>('/admin/patch', {
        method: 'POST',
        body: JSON.stringify({
          ...(baseVersion !== undefined ? { baseVersion } : {}),
          ...payload,
        }),
      });
      setDataset(res.dataset);
      setManifest(res.manifest);
      setBackups(res.backups ?? []);
      showToast('ok', `${okMessage}（已发布静态快照 v${res.manifest.currentVersion}）`);
    } catch (err: unknown) {
      showToast('err', `保存失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const openEntityEditor = (ent: EntityRecord, isNew: boolean) => {
    const clonedOverrides: Record<string, ArcProfileOverride> = {};
    if (ent.arcOverrides) {
      for (const [k, v] of Object.entries(ent.arcOverrides)) {
        clonedOverrides[k] = { ...v };
      }
    }
    setIsNewEntity(isNew);
    setEditingEntity({
      ...ent,
      arcs: [...(ent.arcs ?? [])],
      aliases: ent.aliases ? [...ent.aliases] : undefined,
      arcOverrides: Object.keys(clonedOverrides).length > 0 ? clonedOverrides : undefined,
    });
    setAliasesDraft((ent.aliases ?? []).join(', '));
    setOverrideArcId(ent.arcs[ent.arcs.length - 1] || dataset?.arcs[0]?.id || 'kuro');
    setWpSearchTerm(ent.canonicalName || '');
    setWpSearchHits([]);
  };

  const entityMap = useMemo(
    () => new Map((dataset?.entities ?? []).map((e) => [e.id, e])),
    [dataset]
  );

  const nationEntities = useMemo(
    () => (dataset?.entities ?? []).filter((e) => e.entityType === 'nation'),
    [dataset]
  );

  const groupEntities = useMemo(
    () =>
      (dataset?.entities ?? []).filter(
        (e) =>
          e.entityType === 'organization' ||
          e.entityType === 'family' ||
          e.entityType === 'school'
      ),
    [dataset]
  );

  // Sync qaArcs & reset entPage when studioArc changes
  useEffect(() => {
    if (studioArc !== 'all') {
      setQaArcs([studioArc]);
    }
    setEntPage(1);
  }, [studioArc]);

  const resolvedPreview = useMemo(() => {
    if (!dataset) return { nodes: [], links: [], nodeMap: new Map() };
    const activeArcs =
      studioArc === 'all' ? dataset.arcs.map((a) => a.id) : [studioArc];
    return resolveGraph(dataset.arcs, dataset.entities, dataset.relations, {
      selectedArcs: activeArcs,
      maxImportanceTier: studioTier,
      enabledEntityTypes: ALL_ENTITY_TYPES_SET,
      enabledCategories: ALL_CATEGORIES_SET,
      collapsedGroupIds: EMPTY_SET,
    });
  }, [dataset, studioArc, studioTier]);

  const { highlightedNodeIds, highlightedLinkIds } = useMemo(() => {
    const nSet = new Set<string>();
    const lSet = new Set<string>();

    if (selectedLink && !hoveredNodeId && !selectedNodeId) {
      nSet.add(selectedLink.sourceId);
      nSet.add(selectedLink.targetId);
      lSet.add(selectedLink.id);
      return { highlightedNodeIds: nSet, highlightedLinkIds: lSet };
    }

    const focus = hoveredNodeId ?? selectedNodeId;
    if (focus && resolvedPreview.nodeMap.has(focus)) {
      nSet.add(focus);
      for (const l of resolvedPreview.links) {
        if (l.sourceId === focus) {
          nSet.add(l.targetId);
          lSet.add(l.id);
        } else if (l.targetId === focus) {
          nSet.add(l.sourceId);
          lSet.add(l.id);
        }
      }
    }
    return { highlightedNodeIds: nSet, highlightedLinkIds: lSet };
  }, [hoveredNodeId, selectedNodeId, selectedLink, resolvedPreview]);

  const resolveEntityInput = (inputVal: string): EntityRecord | undefined => {
    if (!dataset || !inputVal.trim()) return undefined;
    const trimmed = inputVal.trim();
    const byId = entityMap.get(trimmed);
    if (byId) return byId;
    const bracketMatch = trimmed.match(/\[([^\]]+)\]$/);
    if (bracketMatch && entityMap.get(bracketMatch[1])) {
      return entityMap.get(bracketMatch[1]);
    }
    return dataset.entities.find(
      (e) => e.canonicalName === trimmed || e.aliases?.includes(trimmed)
    );
  };

  const handleQuickAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const sEnt = resolveEntityInput(qaSource);
    const tEnt = resolveEntityInput(qaTarget);
    if (!sEnt || !tEnt) {
      showToast('err', '请从下拉提示中选择有效的源实体与目标实体');
      return;
    }
    if (sEnt.id === tEnt.id) {
      showToast('err', '源实体与目标实体不能相同');
      return;
    }
    if (!qaLabel.trim()) {
      showToast('err', '请输入关系描述词（如：师徒 / 宿敌 / 所属成员）');
      return;
    }
    const newRel: RelationRecord = {
      id: `rel-${Date.now()}`,
      source: sEnt.id,
      target: tEnt.id,
      category: qaCategory,
      label: qaLabel.trim(),
      direction: qaDir,
      weight: 4,
      arcs: qaArcs.length ? qaArcs : ['kuro'],
      status: 'published',
      ...(qaSupersedesId ? { supersedesId: qaSupersedesId } : {}),
    };
    const ensure = newRel.arcs.flatMap((arcId) => [
      { entityId: sEnt.id, arcId },
      { entityId: tEnt.id, arcId },
    ]);
    submitPatch(
      {
        action: 'upsert_relation',
        relation: newRel,
        ensureEntityArcs: ensure,
        summary: `新增关系 ${sEnt.canonicalName} -> ${tEnt.canonicalName} (${newRel.label})`,
      },
      `已新增关系：${sEnt.canonicalName} ──(${newRel.label})──► ${tEnt.canonicalName}`
    );
    setQaLabel('');
    setQaSupersedesId('');
    setConnectFirstNodeId(null);
  };

  const prepareEvolveRelation = (rel: RelationRecord) => {
    const sEnt = entityMap.get(rel.source);
    const tEnt = entityMap.get(rel.target);
    setQaSource(sEnt ? `${sEnt.canonicalName} [${sEnt.id}]` : rel.source);
    setQaTarget(tEnt ? `${tEnt.canonicalName} [${tEnt.id}]` : rel.target);
    setQaCategory(rel.category);
    setQaLabel(`${rel.label}（新作演变）`);
    setQaDir(rel.direction);
    setQaSupersedesId(rel.id);
    if (dataset?.arcs.length) {
      setQaArcs([dataset.arcs[dataset.arcs.length - 1].id]);
    }
    showToast('ok', '已填入顶部快捷栏，请选择新作品层与新关系描述后点击「录入关系」');
  };

  const handleSearchWpPosts = async () => {
    if (!wpSearchTerm.trim()) return;
    try {
      const hits = await apiFetch<WpSearchItem[]>(
        `/admin/wp-search?q=${encodeURIComponent(wpSearchTerm.trim())}`
      );
      setWpSearchHits(hits);
    } catch (err) {
      showToast('err', `检索词条失败：${(err as Error).message}`);
    }
  };

  const handlePickMediaAvatar = () => {
    if (!editingEntity) return;
    if (!window.wp?.media) {
      showToast('err', '当前页面未加载 wp.media，可直接粘贴头像 URL');
      return;
    }
    const frame = window.wp.media({
      title: '选择角色或组织头像徽章',
      multiple: false,
      library: { type: 'image' },
    });
    frame.on('select', () => {
      const att = frame.state().get('selection').first().toJSON();
      const url = att.sizes?.thumbnail?.url || att.url || '';
      if (url) {
        setEditingEntity((prev) => (prev ? { ...prev, defaultAvatarUrl: url } : null));
      }
    });
    frame.open();
  };

  const updateEditingOverride = (arcKey: string, patch: Partial<ArcProfileOverride> | null) => {
    setEditingEntity((prev) => {
      if (!prev) return null;
      const nextOverrides = { ...(prev.arcOverrides ?? {}) };
      if (patch === null) {
        delete nextOverrides[arcKey];
      } else {
        nextOverrides[arcKey] = {
          ...(nextOverrides[arcKey] ?? {}),
          ...patch,
        };
      }
      return {
        ...prev,
        arcOverrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
      };
    });
  };

  const handleExportDownload = (fmt: 'json' | 'csv') => {
    if (!dataset) return;
    let blob: Blob;
    let filename: string;
    if (fmt === 'json') {
      blob = new Blob([JSON.stringify(dataset, null, 2)], { type: 'application/json' });
      filename = `zemuria.v${manifest?.currentVersion ?? 1}.json`;
    } else {
      const rows = [
        ['id', 'source', 'sourceName', 'target', 'targetName', 'category', 'label', 'direction', 'arcs', 'status', 'supersedesId'].join(','),
        ...dataset.relations.map((r) =>
          [
            r.id,
            r.source,
            `"${(entityMap.get(r.source)?.canonicalName ?? '').replace(/"/g, '""')}"`,
            r.target,
            `"${(entityMap.get(r.target)?.canonicalName ?? '').replace(/"/g, '""')}"`,
            r.category,
            `"${r.label.replace(/"/g, '""')}"`,
            r.direction,
            `"${r.arcs.join('|')}"`,
            r.status ?? 'published',
            r.supersedesId ?? '',
          ].join(',')
        ),
      ];
      blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
      filename = `zemuria-relations.v${manifest?.currentVersion ?? 1}.csv`;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const lower = f.name.toLowerCase();
    setImportFileName(f.name);

    if (lower.endsWith('.xlsx')) {
      setImportFormat('xlsx');
      const reader = new FileReader();
      reader.onload = () => {
        const raw = typeof reader.result === 'string' ? reader.result : '';
        const b64 = raw.includes(',') ? raw.split(',')[1] : raw;
        setImportText(b64);
        showToast(
          'ok',
          `已读取 Excel 工作簿「${f.name}」（${Math.max(1, Math.round(f.size / 1024))} KB），请点击下方导入按钮`
        );
      };
      reader.onerror = () => {
        showToast('err', '读取 .xlsx 文件失败');
      };
      reader.readAsDataURL(f);
      return;
    }

    if (lower.endsWith('.csv')) {
      setImportFormat('csv');
    } else {
      setImportFormat('json');
    }
    f.text()
      .then((txt) => setImportText(txt))
      .catch(() => showToast('err', '读取文本文件失败'));
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importText.trim()) {
      showToast('err', '请先选择文件或粘贴导入内容');
      return;
    }
    setBusy(true);
    try {
      const baseVersion = manifest?.currentVersion ?? dataset?.version;
      const res = await apiFetch<{
        dataset: GraphDataset;
        manifest: ManifestInfo;
        backups: BackupEntry[];
      }>('/admin/import', {
        method: 'POST',
        body: JSON.stringify({
          mode: importMode,
          format: importFormat,
          content: importText,
          ...(baseVersion !== undefined ? { baseVersion } : {}),
        }),
      });
      setDataset(res.dataset);
      setManifest(res.manifest);
      setBackups(res.backups ?? []);
      setImportText('');
      setImportFileName('');
      showToast('ok', `导入成功！当前版本 v${res.manifest.currentVersion}`);
    } catch (err) {
      showToast('err', `导入失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreBackup = async (file: string) => {
    setBusy(true);
    try {
      const res = await apiFetch<{
        dataset: GraphDataset;
        manifest: ManifestInfo;
        backups: BackupEntry[];
      }>('/admin/restore', {
        method: 'POST',
        body: JSON.stringify({ backupFile: file }),
      });
      setDataset(res.dataset);
      setManifest(res.manifest);
      setBackups(res.backups ?? []);
      showToast('ok', `已回滚至备份 ${file}，当前版本 v${res.manifest.currentVersion}`);
    } catch (err) {
      showToast('err', `回滚失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const pendingRelationCount = useMemo(() => {
    if (!dataset) return 0;
    return dataset.relations.filter((r) => (r.status ?? 'published') !== 'published').length;
  }, [dataset]);

  const filteredRelations = useMemo(() => {
    if (!dataset) return [];
    const q = relQuery.trim().toLowerCase();
    return dataset.relations.filter((r) => {
      if (relArcFilter !== 'all' && !r.arcs.includes(relArcFilter)) return false;
      if (relCatFilter !== 'all' && r.category !== relCatFilter) return false;
      const st = r.status ?? 'published';
      if (relStatusFilter !== 'all' && st !== relStatusFilter) return false;
      if (!q) return true;
      const sName = entityMap.get(r.source)?.canonicalName ?? r.source;
      const tName = entityMap.get(r.target)?.canonicalName ?? r.target;
      return `${sName} ${tName} ${r.label} ${r.id}`.toLowerCase().includes(q);
    });
  }, [dataset, relQuery, relArcFilter, relCatFilter, relStatusFilter, entityMap]);

  const filteredEntities = useMemo(() => {
    if (!dataset) return [];
    const q = entQuery.trim().toLowerCase();
    return dataset.entities.filter((e) => {
      if (studioArc !== 'all' && !e.arcs.includes(studioArc)) return false;
      if (entTypeFilter !== 'all' && e.entityType !== entTypeFilter) return false;
      if (entTierFilter !== 'all' && (e.importance ?? 'supporting') !== entTierFilter) return false;
      if (!q) return true;
      return `${e.canonicalName} ${e.nameEn ?? ''} ${e.id} ${(e.aliases ?? []).join(' ')}`
        .toLowerCase()
        .includes(q);
    });
  }, [dataset, studioArc, entQuery, entTypeFilter, entTierFilter]);

  if (!dataset) {
    return <div className="kr-admin-loading">正在初始化轨迹关系图后台工作台…</div>;
  }

  const activeCanvasEntity = selectedNodeId ? entityMap.get(selectedNodeId) ?? null : null;
  const activeCanvasEdges = selectedNodeId
    ? dataset.relations.filter((r) => r.source === selectedNodeId || r.target === selectedNodeId)
    : [];
  const activeCanvasRelation = selectedLink
    ? dataset.relations.find((r) => r.id === selectedLink.id) ?? null
    : null;

  const totalRelPages = Math.max(1, Math.ceil(filteredRelations.length / REL_PAGE_SIZE));
  const safeRelPage = Math.min(relPage, totalRelPages);

  const totalEntPages = Math.max(1, Math.ceil(filteredEntities.length / ENT_PAGE_SIZE));
  const safeEntPage = Math.min(entPage, totalEntPages);

  const currentOverride: ArcProfileOverride =
    editingEntity?.arcOverrides?.[overrideArcId] ?? {};

  const resetArcForm = () => {
    setEditingArcId(null);
    setNewArcId('');
    setNewArcName('');
    setNewArcShort('');
    setNewArcSub('');
    const maxOrder = Math.max(0, ...dataset.arcs.map((a) => a.order));
    setNewArcOrder(maxOrder + 10);
    setNewArcAccent('#a78bfa');
  };

  return (
    <div className="kr-studio-wrap">
      {toast && <div className={`kr-toast ${toast.kind}`}>{toast.msg}</div>}

      {/* Top Header */}
      <div className="kr-studio-topbar">
        <div>
          <h1>
            塞姆利亚导力关系图谱 · 后台工作台
            <span className="kr-role-badge">
              当前操作员：{boot.currentUser} ({boot.userRoles.join(', ')})
            </span>
          </h1>
          <div className="kr-meta-sub">
            静态 JSON 存储模式（零 SQL 负载） · 快照版本{' '}
            <strong>v{manifest?.currentVersion ?? dataset.version}</strong> · 共{' '}
            <strong>{dataset.entities.length}</strong> 个实体 /{' '}
            <strong>{dataset.relations.length}</strong> 条关系弧 · 最近更新：
            {manifest?.updatedBy || dataset.updatedBy || 'system'}
          </div>
        </div>

        <div className="kr-topbar-actions">
          <select
            value={studioArc}
            onChange={(e) => setStudioArc(e.target.value)}
            className="kr-select"
          >
            <option value="all">工作台视角：全系列 ({dataset.entities.length})</option>
            {dataset.arcs.map((a) => (
              <option key={a.id} value={a.id}>
                工作台视角：{a.name} ({a.shortName})
              </option>
            ))}
          </select>

          {isSafeNavUrl(boot.frontendPreviewUrl) && (
            <a
              href={boot.frontendPreviewUrl.trim()}
              target="_blank"
              rel="noopener noreferrer"
              className="kr-btn secondary"
            >
              打开前台关系图页 ↗
            </a>
          )}

          <button
            type="button"
            className="kr-btn primary"
            disabled={busy}
            onClick={() =>
              submitPatch({ action: 'republish', summary: '手动重新生成静态快照与清缓存' }, '静态快照已重新发布并清理缓存')
            }
          >
            🚀 刷新静态快照 (v{manifest?.currentVersion ?? 1})
          </button>
        </div>
      </div>

      {/* Always-Ready 3-Second Quick-Add & Evolve Bar */}
      <form className="kr-quickadd-bar" onSubmit={handleQuickAddSubmit}>
        <div className="kr-qa-title">
          {qaSupersedesId ? (
            <span className="kr-evo-pill">
              ✦ 演变自 {qaSupersedesId}
              <button type="button" onClick={() => setQaSupersedesId('')}>
                ×
              </button>
            </span>
          ) : (
            <span>⚡ 3秒快捷新增关系</span>
          )}
        </div>

        <input
          list="kr-entity-datalist"
          value={qaSource}
          onChange={(e) => setQaSource(e.target.value)}
          placeholder="源角色/组织 (输入名字搜索)"
          className="kr-input"
        />

        <select
          value={qaCategory}
          onChange={(e) => setQaCategory(e.target.value as RelationCategory)}
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
          value={qaLabel}
          onChange={(e) => setQaLabel(e.target.value)}
          placeholder="关系词（如：师徒 / 所长与助手 / 宿敌）"
          className="kr-input"
        />

        <select
          value={qaDir}
          onChange={(e) => setQaDir(e.target.value as 'directed' | 'bidirectional')}
          className="kr-select compact"
        >
          <option value="bidirectional">⟷ 双向</option>
          <option value="directed">⟶ 单向</option>
        </select>

        <input
          list="kr-entity-datalist"
          value={qaTarget}
          onChange={(e) => setQaTarget(e.target.value)}
          placeholder="目标角色/组织 (输入名字搜索)"
          className="kr-input"
        />

        <div className="kr-qa-arcs">
          {dataset.arcs.map((a) => {
            const on = qaArcs.includes(a.id);
            return (
              <button
                key={a.id}
                type="button"
                className={`kr-arc-chip ${on ? 'on' : ''}`}
                onClick={() =>
                  setQaArcs((prev) =>
                    prev.includes(a.id)
                      ? prev.length > 1
                        ? prev.filter((x) => x !== a.id)
                        : prev
                      : [...prev, a.id]
                  )
                }
              >
                {a.shortName}
              </button>
            );
          })}
        </div>

        <button type="submit" className="kr-btn primary" disabled={busy}>
          + 录入关系
        </button>

        <datalist id="kr-entity-datalist">
          {dataset.entities.map((ent) => (
            <option key={ent.id} value={`${ent.canonicalName} [${ent.id}]`} />
          ))}
        </datalist>
      </form>

      {/* Studio Navigation Tabs */}
      <div className="kr-studio-tabs">
        <button
          type="button"
          className={activeTab === 'canvas' ? 'active' : ''}
          onClick={() => setActiveTab('canvas')}
        >
          🌐 可视化画布与点选连线
        </button>
        <button
          type="button"
          className={activeTab === 'relations' ? 'active' : ''}
          onClick={() => setActiveTab('relations')}
        >
          📋 关系总表批量编辑 ({dataset.relations.length}
          {pendingRelationCount > 0 ? ` · 待审 ${pendingRelationCount}` : ''})
        </button>
        <button
          type="button"
          className={activeTab === 'entities' ? 'active' : ''}
          onClick={() => setActiveTab('entities')}
        >
          👤 实体词条与 WP 百科关联 ({dataset.entities.length})
        </button>
        <button
          type="button"
          className={activeTab === 'arcs' ? 'active' : ''}
          onClick={() => setActiveTab('arcs')}
        >
          🗂 作品分层管理 ({dataset.arcs.length})
        </button>
        <button
          type="button"
          className={activeTab === 'io' ? 'active' : ''}
          onClick={() => setActiveTab('io')}
        >
          📦 导入导出与备份回滚 ({backups.length})
        </button>
      </div>

      {/* TAB 1: VISUAL STUDIO CANVAS */}
      {activeTab === 'canvas' && (
        <div
          ref={canvasSplitRef}
          className={`kr-canvas-split${canvasFullscreen ? ' is-fullscreen' : ''}`}
        >
          <div className="kr-canvas-pane xipha-app-shell">
            <div className="kr-canvas-toolbar">
              <button
                type="button"
                className={`kr-btn ${connectMode ? 'primary' : 'secondary'}`}
                onClick={() => {
                  setConnectMode((v) => !v);
                  setConnectFirstNodeId(null);
                }}
              >
                {connectMode
                  ? connectFirstNodeId
                    ? `🔗 已选起点 [${entityMap.get(connectFirstNodeId)?.canonicalName}] → 请点击终点节点`
                    : '🔗 点选连线模式开启中：请点击起点节点'
                  : '🔗 开启「两次点击连线」模式'}
              </button>

              <div className="kr-canvas-toolbar-right">
                <div className="kr-inline-tiers">
                  <span>预览密度：</span>
                  {(['core', 'supporting', 'minor'] as ImportanceTier[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={`kr-arc-chip ${studioTier === t ? 'on' : ''}`}
                      onClick={() => setStudioTier(t)}
                    >
                      {t === 'core' ? '★核心' : t === 'supporting' ? '★★配角' : '★★★全量'}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  className={`kr-fullscreen-btn ${canvasFullscreen ? 'active' : ''}`}
                  onClick={() => setCanvasFullscreen((v) => !v)}
                  aria-pressed={canvasFullscreen}
                  title={canvasFullscreen ? '退出网页全屏 (Esc)' : '网页全屏展开工作台画布 (Esc 退出)'}
                >
                  {canvasFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                  <span>{canvasFullscreen ? '退出全屏' : '网页全屏'}</span>
                </button>
              </div>
            </div>

            <Graph2DView
              nodes={resolvedPreview.nodes}
              links={resolvedPreview.links}
              selectedNodeId={selectedNodeId}
              hoveredNodeId={hoveredNodeId}
              highlightedNodeIds={highlightedNodeIds}
              highlightedLinkIds={highlightedLinkIds}
              egoFocusMode={false}
              alwaysShowLabels={false}
              collapsedGroupIds={EMPTY_SET}
              onSelectNode={(id) => {
                setSelectedLink(null);
                setSelectedNodeId(id);
                if (connectMode && id) {
                  if (!connectFirstNodeId) {
                    setConnectFirstNodeId(id);
                    const s = entityMap.get(id);
                    if (s) setQaSource(`${s.canonicalName} [${s.id}]`);
                  } else if (connectFirstNodeId !== id) {
                    const t = entityMap.get(id);
                    if (t) setQaTarget(`${t.canonicalName} [${t.id}]`);
                    setConnectFirstNodeId(null);
                    setConnectMode(false);
                    showToast('ok', '起点与终点已自动填入上方快捷栏，输入关系词即可保存！');
                  }
                }
              }}
              onHoverNode={setHoveredNodeId}
              onSelectLink={(l) => {
                setSelectedNodeId(null);
                setSelectedLink(l);
              }}
              onToggleCollapseGroup={NOOP}
            />
          </div>

          <div className="kr-side-editor">
            {activeCanvasEntity ? (
              <>
                <div className="kr-side-head">
                  {activeCanvasEntity.defaultAvatarUrl && (
                    <img
                      src={activeCanvasEntity.defaultAvatarUrl}
                      alt=""
                      crossOrigin="anonymous"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  )}
                  <div>
                    <h3>{activeCanvasEntity.canonicalName}</h3>
                    <div className="kr-muted">{activeCanvasEntity.id}</div>
                  </div>
                  <button
                    type="button"
                    className="kr-btn secondary small"
                    onClick={() => {
                      openEntityEditor(activeCanvasEntity, false);
                      setActiveTab('entities');
                    }}
                  >
                    完整编辑
                  </button>
                </div>

                <div className="kr-field-block">
                  <label>角色/实体重要度分级（一键切换）</label>
                  <div className="kr-tier-pills">
                    {(
                      [
                        ['core', '★ 核心主线'],
                        ['supporting', '★★ 重要配角'],
                        ['minor', '★★★ 次要登场'],
                      ] as Array<[ImportanceTier, string]>
                    ).map(([val, txt]) => (
                      <button
                        key={val}
                        type="button"
                        className={(activeCanvasEntity.importance ?? 'supporting') === val ? 'active' : ''}
                        onClick={() =>
                          submitPatch(
                            {
                              action: 'upsert_entity',
                              entity: { ...activeCanvasEntity, importance: val },
                              summary: `修改 ${activeCanvasEntity.canonicalName} 重要度为 ${val}`,
                            },
                            `已更新「${activeCanvasEntity.canonicalName}」重要度`
                          )
                        }
                      >
                        {txt}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="kr-field-block">
                  <label>所属作品层（勾选即在该层登场）</label>
                  <div className="kr-qa-arcs">
                    {dataset.arcs.map((a) => {
                      const on = activeCanvasEntity.arcs.includes(a.id);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          className={`kr-arc-chip ${on ? 'on' : ''}`}
                          onClick={() => {
                            const nextArcs = on
                              ? activeCanvasEntity.arcs.length > 1
                                ? activeCanvasEntity.arcs.filter((x) => x !== a.id)
                                : activeCanvasEntity.arcs
                              : [...activeCanvasEntity.arcs, a.id];
                            submitPatch(
                              {
                                action: 'upsert_entity',
                                entity: { ...activeCanvasEntity, arcs: nextArcs },
                                summary: `修改 ${activeCanvasEntity.canonicalName} 作品层`,
                              },
                              `已更新「${activeCanvasEntity.canonicalName}」登场作品层`
                            );
                          }}
                        >
                          {on ? '✓ ' : ''}
                          {a.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="kr-field-block">
                  <label>该实体的全部关系 ({activeCanvasEdges.length})</label>
                  <div className="kr-mini-edge-list">
                    {activeCanvasEdges.map((rel) => {
                      const otherId =
                        rel.source === activeCanvasEntity.id ? rel.target : rel.source;
                      const other = entityMap.get(otherId);
                      return (
                        <div key={rel.id} className="kr-mini-edge-item">
                          <div className="kr-mini-edge-main">
                            <strong>{other?.canonicalName ?? otherId}</strong>
                            <span className="kr-edge-tag">{rel.label}</span>
                            <span className="kr-muted">[{rel.arcs.join(',')}]</span>
                          </div>
                          <div className="kr-mini-edge-btns">
                            <button type="button" onClick={() => prepareEvolveRelation(rel)}>
                              演变
                            </button>
                            <button
                              type="button"
                              className="danger"
                              onClick={() =>
                                submitPatch(
                                  {
                                    action: 'delete_relation',
                                    relationId: rel.id,
                                    summary: `删除关系 ${rel.label}`,
                                  },
                                  `已删除关系 ${rel.label}`
                                )
                              }
                            >
                              删
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : activeCanvasRelation ? (
              <>
                <div className="kr-side-head">
                  <div>
                    <h3>
                      关系弧详情 · {getRelationCategoryMeta(activeCanvasRelation.category).label}
                    </h3>
                    <div className="kr-muted">{activeCanvasRelation.id}</div>
                  </div>
                  <button
                    type="button"
                    className="kr-btn secondary small"
                    onClick={() => setSelectedLink(null)}
                  >
                    关闭
                  </button>
                </div>

                <div className="kr-side-link-card">
                  <div className="kr-row-btns">
                    <button
                      type="button"
                      className="kr-btn secondary small"
                      onClick={() => {
                        setSelectedLink(null);
                        setSelectedNodeId(activeCanvasRelation.source);
                      }}
                    >
                      {entityMap.get(activeCanvasRelation.source)?.canonicalName ??
                        activeCanvasRelation.source}
                    </button>
                    <strong>
                      {activeCanvasRelation.direction === 'bidirectional' ? '⟷' : '⟶'}
                    </strong>
                    <button
                      type="button"
                      className="kr-btn secondary small"
                      onClick={() => {
                        setSelectedLink(null);
                        setSelectedNodeId(activeCanvasRelation.target);
                      }}
                    >
                      {entityMap.get(activeCanvasRelation.target)?.canonicalName ??
                        activeCanvasRelation.target}
                    </button>
                  </div>
                </div>

                <div className="kr-form-stack" style={{ marginTop: 12 }}>
                  <label>
                    关系描述词（失焦自动保存）
                    <input
                      key={`${activeCanvasRelation.id}-${activeCanvasRelation.label}`}
                      type="text"
                      defaultValue={activeCanvasRelation.label}
                      onBlur={(e) => {
                        const next = e.target.value.trim();
                        if (next && next !== activeCanvasRelation.label) {
                          submitPatch(
                            {
                              action: 'upsert_relation',
                              relation: { ...activeCanvasRelation, label: next },
                              summary: `修改关系词为 ${next}`,
                            },
                            `已更新关系词为「${next}」`
                          );
                        }
                      }}
                      className="kr-input"
                    />
                  </label>

                  <div className="kr-grid-2">
                    <label>
                      性质大类
                      <select
                        value={activeCanvasRelation.category}
                        onChange={(e) =>
                          submitPatch(
                            {
                              action: 'upsert_relation',
                              relation: {
                                ...activeCanvasRelation,
                                category: e.target.value as RelationCategory,
                              },
                              summary: `修改关系分类 ${activeCanvasRelation.id}`,
                            },
                            '已更新关系分类'
                          )
                        }
                        className="kr-select compact"
                      >
                        {(Object.keys(RELATION_CATEGORY_META) as RelationCategory[]).map((c) => (
                          <option key={c} value={c}>
                            {RELATION_CATEGORY_META[c].label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      方向性
                      <select
                        value={activeCanvasRelation.direction}
                        onChange={(e) =>
                          submitPatch(
                            {
                              action: 'upsert_relation',
                              relation: {
                                ...activeCanvasRelation,
                                direction: e.target.value as 'directed' | 'bidirectional',
                              },
                              summary: `切换关系方向 ${activeCanvasRelation.id}`,
                            },
                            '已更新关系方向'
                          )
                        }
                        className="kr-select compact"
                      >
                        <option value="bidirectional">⟷ 双向</option>
                        <option value="directed">⟶ 单向</option>
                      </select>
                    </label>
                  </div>

                  <label>
                    发布状态
                    <select
                      value={activeCanvasRelation.status ?? 'published'}
                      onChange={(e) =>
                        submitPatch(
                          {
                            action: 'upsert_relation',
                            relation: {
                              ...activeCanvasRelation,
                              status: e.target.value as RelationStatus,
                            },
                            summary: `修改关系状态 ${activeCanvasRelation.id}`,
                          },
                          '已更新关系发布状态'
                        )
                      }
                      className="kr-select compact"
                    >
                      <option value="published">已发布 (published)</option>
                      <option value="pending_review">待审核 (pending_review)</option>
                      <option value="draft">草稿 (draft)</option>
                    </select>
                  </label>

                  <div>
                    <div className="kr-muted" style={{ marginBottom: 4 }}>
                      生效作品层
                    </div>
                    <div className="kr-qa-arcs">
                      {dataset.arcs.map((a) => {
                        const on = activeCanvasRelation.arcs.includes(a.id);
                        return (
                          <button
                            key={a.id}
                            type="button"
                            className={`kr-arc-chip ${on ? 'on' : ''}`}
                            onClick={() => {
                              const nextArcs = on
                                ? activeCanvasRelation.arcs.length > 1
                                  ? activeCanvasRelation.arcs.filter((x) => x !== a.id)
                                  : activeCanvasRelation.arcs
                                : [...activeCanvasRelation.arcs, a.id];
                              submitPatch(
                                {
                                  action: 'upsert_relation',
                                  relation: { ...activeCanvasRelation, arcs: nextArcs },
                                  summary: `修改关系作品层 ${activeCanvasRelation.id}`,
                                },
                                '已更新关系所属作品层'
                              );
                            }}
                          >
                            {on ? '✓ ' : ''}
                            {a.shortName}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <label>
                    补充考据备注（失焦保存）
                    <textarea
                      key={`${activeCanvasRelation.id}-${activeCanvasRelation.note ?? ''}`}
                      rows={2}
                      defaultValue={activeCanvasRelation.note ?? ''}
                      onBlur={(e) => {
                        const nextNote = e.target.value.trim();
                        if (nextNote !== (activeCanvasRelation.note ?? '')) {
                          submitPatch(
                            {
                              action: 'upsert_relation',
                              relation: {
                                ...activeCanvasRelation,
                                ...(nextNote ? { note: nextNote } : { note: undefined }),
                              },
                              summary: `修改关系备注 ${activeCanvasRelation.id}`,
                            },
                            '已更新补充考据备注'
                          );
                        }
                      }}
                      className="kr-textarea"
                    />
                  </label>

                  <div className="kr-row-btns">
                    <button
                      type="button"
                      className="kr-btn secondary small"
                      onClick={() => prepareEvolveRelation(activeCanvasRelation)}
                    >
                      ✦ 在新作演变此关系
                    </button>
                    <button
                      type="button"
                      className="kr-btn danger small"
                      onClick={() => {
                        const relId = activeCanvasRelation.id;
                        const relLbl = activeCanvasRelation.label;
                        setSelectedLink(null);
                        submitPatch(
                          {
                            action: 'delete_relation',
                            relationId: relId,
                            summary: `删除关系 ${relLbl}`,
                          },
                          `已删除关系「${relLbl}」`
                        );
                      }}
                    >
                      删除此关系
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="kr-empty-side">
                点击左侧画布中的任意人物、组织、国家或关系连线，即可在此秒级调整其属性、重要度、登场作品层或增删演变关系。
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: SPREADSHEET RELATIONS TABLE */}
      {activeTab === 'relations' && (
        <div className="kr-panel-card">
          <div className="kr-table-filters">
            <input
              type="text"
              value={relQuery}
              onChange={(e) => {
                setRelQuery(e.target.value);
                setRelPage(1);
              }}
              placeholder="搜索源节点 / 目标节点 / 关系词…"
              className="kr-input"
            />
            <select
              value={relArcFilter}
              onChange={(e) => {
                setRelArcFilter(e.target.value);
                setRelPage(1);
              }}
              className="kr-select compact"
            >
              <option value="all">全部作品层</option>
              {dataset.arcs.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <select
              value={relCatFilter}
              onChange={(e) => {
                setRelCatFilter(e.target.value);
                setRelPage(1);
              }}
              className="kr-select compact"
            >
              <option value="all">全部关系性质</option>
              {(Object.keys(RELATION_CATEGORY_META) as RelationCategory[]).map((c) => (
                <option key={c} value={c}>
                  {RELATION_CATEGORY_META[c].label}
                </option>
              ))}
            </select>
            <select
              value={relStatusFilter}
              onChange={(e) => {
                setRelStatusFilter(e.target.value);
                setRelPage(1);
              }}
              className="kr-select compact"
            >
              <option value="all">全部状态</option>
              <option value="published">已发布 (published)</option>
              <option value="pending_review">待审核 (pending_review)</option>
              <option value="draft">草稿 (draft)</option>
            </select>
            <span className="kr-muted">共匹配 {filteredRelations.length} 条关系</span>
          </div>

          <table className="kr-data-table">
            <thead>
              <tr>
                <th>源实体</th>
                <th>方向</th>
                <th>目标实体</th>
                <th>性质大类</th>
                <th>关系描述词（失焦自动保存）</th>
                <th>状态</th>
                <th>生效作品层</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredRelations
                .slice((safeRelPage - 1) * REL_PAGE_SIZE, safeRelPage * REL_PAGE_SIZE)
                .map((r) => {
                  const sEnt = entityMap.get(r.source);
                  const tEnt = entityMap.get(r.target);
                  return (
                    <tr key={r.id}>
                      <td>
                        <strong>{sEnt?.canonicalName ?? r.source}</strong>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="kr-link-btn"
                          onClick={() =>
                            submitPatch(
                              {
                                action: 'upsert_relation',
                                relation: {
                                  ...r,
                                  direction:
                                    r.direction === 'bidirectional' ? 'directed' : 'bidirectional',
                                },
                                summary: `切换关系方向 ${r.id}`,
                              },
                              '已切换关系方向'
                            )
                          }
                        >
                          {r.direction === 'bidirectional' ? '⟷ 双向' : '⟶ 单向'}
                        </button>
                      </td>
                      <td>
                        <strong>{tEnt?.canonicalName ?? r.target}</strong>
                      </td>
                      <td>
                        <select
                          value={r.category in RELATION_CATEGORY_META ? r.category : 'ally'}
                          onChange={(e) =>
                            submitPatch(
                              {
                                action: 'upsert_relation',
                                relation: { ...r, category: e.target.value as RelationCategory },
                                summary: `修改关系分类 ${r.id}`,
                              },
                              '已修改关系分类'
                            )
                          }
                          className="kr-select compact"
                        >
                          {(Object.keys(RELATION_CATEGORY_META) as RelationCategory[]).map((c) => (
                            <option key={c} value={c}>
                              {RELATION_CATEGORY_META[c].label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          key={`${r.id}-${r.label}`}
                          type="text"
                          defaultValue={r.label}
                          onBlur={(e) => {
                            const next = e.target.value.trim();
                            if (next && next !== r.label) {
                              submitPatch(
                                {
                                  action: 'upsert_relation',
                                  relation: { ...r, label: next },
                                  summary: `修改关系词为 ${next}`,
                                },
                                `已将关系词更新为「${next}」`
                              );
                            }
                          }}
                          className="kr-input compact"
                        />
                      </td>
                      <td>
                        <select
                          value={r.status ?? 'published'}
                          onChange={(e) =>
                            submitPatch(
                              {
                                action: 'upsert_relation',
                                relation: { ...r, status: e.target.value as RelationStatus },
                                summary: `修改关系状态 ${r.id} -> ${e.target.value}`,
                              },
                              '已更新关系状态'
                            )
                          }
                          className="kr-select compact"
                        >
                          <option value="published">已发布</option>
                          <option value="pending_review">待审核</option>
                          <option value="draft">草稿</option>
                        </select>
                      </td>
                      <td>
                        <div className="kr-qa-arcs">
                          {dataset.arcs.map((a) => {
                            const on = r.arcs.includes(a.id);
                            return (
                              <button
                                key={a.id}
                                type="button"
                                className={`kr-arc-chip ${on ? 'on' : ''}`}
                                onClick={() => {
                                  const nextArcs = on
                                    ? r.arcs.length > 1
                                      ? r.arcs.filter((x) => x !== a.id)
                                      : r.arcs
                                    : [...r.arcs, a.id];
                                  submitPatch(
                                    {
                                      action: 'upsert_relation',
                                      relation: { ...r, arcs: nextArcs },
                                      summary: `修改关系作品层 ${r.id}`,
                                    },
                                    '已更新关系所属作品层'
                                  );
                                }}
                              >
                                {a.shortName}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                      <td>
                        <div className="kr-row-btns">
                          <button
                            type="button"
                            className="kr-btn secondary small"
                            onClick={() => prepareEvolveRelation(r)}
                          >
                            ✦ 演变
                          </button>
                          <button
                            type="button"
                            className="kr-btn danger small"
                            onClick={() =>
                              submitPatch(
                                {
                                  action: 'delete_relation',
                                  relationId: r.id,
                                  summary: `删除关系 ${r.id}`,
                                },
                                `已删除关系 ${r.id}`
                              )
                            }
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>

          {filteredRelations.length > REL_PAGE_SIZE && (
            <div className="kr-pagination">
              <button
                type="button"
                className="kr-btn secondary small"
                disabled={safeRelPage <= 1}
                onClick={() => setRelPage(Math.max(1, safeRelPage - 1))}
              >
                上一页
              </button>
              <span>
                第 {safeRelPage} / {totalRelPages} 页
              </span>
              <button
                type="button"
                className="kr-btn secondary small"
                disabled={safeRelPage >= totalRelPages}
                onClick={() => setRelPage(Math.min(totalRelPages, safeRelPage + 1))}
              >
                下一页
              </button>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: ENTITIES & WP POST AUTO-LINKER */}
      {activeTab === 'entities' && (
        <div className="kr-entities-layout">
          <div className="kr-panel-card">
            <div className="kr-table-filters">
              <input
                type="text"
                value={entQuery}
                onChange={(e) => {
                  setEntQuery(e.target.value);
                  setEntPage(1);
                }}
                placeholder="搜索角色 / 组织 / 国家 / ID / 别名…"
                className="kr-input"
              />
              <select
                value={entTypeFilter}
                onChange={(e) => {
                  setEntTypeFilter(e.target.value);
                  setEntPage(1);
                }}
                className="kr-select compact"
              >
                <option value="all">全部类型</option>
                {(Object.keys(ENTITY_TYPE_META) as EntityType[]).map((t) => (
                  <option key={t} value={t}>
                    {ENTITY_TYPE_META[t].label}
                  </option>
                ))}
              </select>
              <select
                value={entTierFilter}
                onChange={(e) => {
                  setEntTierFilter(e.target.value);
                  setEntPage(1);
                }}
                className="kr-select compact"
              >
                <option value="all">全部重要度</option>
                <option value="core">★ 核心主线</option>
                <option value="supporting">★★ 重要配角</option>
                <option value="minor">★★★ 次要登场</option>
              </select>
              <span className="kr-muted">共匹配 {filteredEntities.length} 个实体</span>
              <button
                type="button"
                className="kr-btn primary"
                onClick={() =>
                  openEntityEditor(
                    {
                      id: `entity-${Date.now()}`,
                      canonicalName: '',
                      entityType: 'character',
                      importance: 'supporting',
                      arcs: studioArc === 'all' ? ['kuro'] : [studioArc],
                      bio: '',
                    },
                    true
                  )
                }
              >
                + 新增实体节点
              </button>
            </div>

            <table className="kr-data-table">
              <thead>
                <tr>
                  <th>头像</th>
                  <th>名称 / ID</th>
                  <th>类型</th>
                  <th>重要度</th>
                  <th>作品层</th>
                  <th>WP 词条链接</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredEntities
                  .slice((safeEntPage - 1) * ENT_PAGE_SIZE, safeEntPage * ENT_PAGE_SIZE)
                  .map((ent) => (
                    <tr key={ent.id}>
                      <td>
                        {ent.defaultAvatarUrl ? (
                          <img
                            src={ent.defaultAvatarUrl}
                            alt=""
                            crossOrigin="anonymous"
                            className="kr-table-avatar"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                            }}
                          />
                        ) : (
                          <span className="kr-avatar-placeholder">
                            {ent.canonicalName.slice(0, 1)}
                          </span>
                        )}
                      </td>
                      <td>
                        <strong>{ent.canonicalName}</strong>
                        <div className="kr-muted">{ent.id}</div>
                      </td>
                      <td>{getEntityTypeMeta(ent.entityType).label}</td>
                      <td>
                        {ent.importance === 'core'
                          ? '★ 核心'
                          : ent.importance === 'minor'
                            ? '★★★ 次要'
                            : '★★ 配角'}
                      </td>
                      <td>{ent.arcs.join(', ')}</td>
                      <td>
                        {isSafeHttpUrl(ent.wikiUrl) ? (
                          <a
                            href={ent.wikiUrl.trim()}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            已关联 #{ent.wpPostId ?? 'URL'} ↗
                          </a>
                        ) : ent.wpPostId ? (
                          <span className="kr-muted">已绑定 #{ent.wpPostId}</span>
                        ) : (
                          <span className="kr-muted">未关联</span>
                        )}
                      </td>
                      <td>
                        <div className="kr-row-btns">
                          <button
                            type="button"
                            className="kr-btn secondary small"
                            onClick={() => openEntityEditor(ent, false)}
                          >
                            编辑 / 关联词条
                          </button>
                          <button
                            type="button"
                            className="kr-btn danger small"
                            onClick={() =>
                              submitPatch(
                                {
                                  action: 'delete_entity',
                                  entityId: ent.id,
                                  summary: `删除实体 ${ent.canonicalName}`,
                                },
                                `已删除实体 ${ent.canonicalName}`
                              )
                            }
                          >
                            删
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>

            {filteredEntities.length > ENT_PAGE_SIZE && (
              <div className="kr-pagination">
                <button
                  type="button"
                  className="kr-btn secondary small"
                  disabled={safeEntPage <= 1}
                  onClick={() => setEntPage(Math.max(1, safeEntPage - 1))}
                >
                  上一页
                </button>
                <span>
                  第 {safeEntPage} / {totalEntPages} 页
                </span>
                <button
                  type="button"
                  className="kr-btn secondary small"
                  disabled={safeEntPage >= totalEntPages}
                  onClick={() => setEntPage(Math.min(totalEntPages, safeEntPage + 1))}
                >
                  下一页
                </button>
              </div>
            )}
          </div>

          {editingEntity && (
            <div className="kr-entity-drawer">
              <h3>
                {isNewEntity ? '新增实体：' : '编辑实体：'}
                {editingEntity.canonicalName || '新实体'}
              </h3>

              {/* 1-Click WP Post Search & Auto-Linker */}
              <div className="kr-wp-linker-box">
                <label>🔍 一键关联 WordPress 百科词条 (dt_team / org / region)</label>
                <div className="kr-wp-search-row">
                  <input
                    type="text"
                    value={wpSearchTerm}
                    onChange={(e) => setWpSearchTerm(e.target.value)}
                    placeholder="输入词条标题检索本站点文章…"
                    className="kr-input"
                  />
                  <button
                    type="button"
                    className="kr-btn secondary"
                    onClick={handleSearchWpPosts}
                  >
                    检索词条
                  </button>
                </div>
                {wpSearchHits.length > 0 && (
                  <div className="kr-wp-hits">
                    {wpSearchHits.map((hit) => (
                      <div key={hit.id} className="kr-wp-hit-row">
                        <div>
                          <strong>
                            [{hit.postType}] {hit.title}
                          </strong>
                          <div className="kr-muted">{hit.link}</div>
                        </div>
                        <button
                          type="button"
                          className="kr-btn primary small"
                          onClick={() => {
                            setEditingEntity((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    canonicalName: prev.canonicalName || hit.title,
                                    wpPostId: hit.id,
                                    wikiUrl: hit.link,
                                    defaultAvatarUrl: hit.avatarUrl || prev.defaultAvatarUrl,
                                    bio: prev.bio || hit.excerpt,
                                  }
                                : null
                            );
                            showToast('ok', `已自动填入词条 #${hit.id} 的页面链接与特色头像！`);
                          }}
                        >
                          一键带入
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="kr-form-stack">
                <label>
                  <span>
                    唯一标识 Slug ID{' '}
                    {!isNewEntity && <span className="kr-muted">（既有实体已锁定，防止断链）</span>}
                  </span>
                  <input
                    type="text"
                    value={editingEntity.id}
                    readOnly={!isNewEntity}
                    disabled={!isNewEntity}
                    onChange={(e) => {
                      if (!isNewEntity) return;
                      setEditingEntity({ ...editingEntity, id: e.target.value.trim() });
                    }}
                    className={`kr-input ${!isNewEntity ? 'kr-input-readonly' : ''}`}
                  />
                </label>

                <div className="kr-grid-2">
                  <label>
                    中文标准名称
                    <input
                      type="text"
                      value={editingEntity.canonicalName}
                      onChange={(e) =>
                        setEditingEntity({ ...editingEntity, canonicalName: e.target.value })
                      }
                      className="kr-input"
                    />
                  </label>

                  <label>
                    英文 / 罗马音名称 (nameEn)
                    <input
                      type="text"
                      value={editingEntity.nameEn ?? ''}
                      onChange={(e) =>
                        setEditingEntity({ ...editingEntity, nameEn: e.target.value })
                      }
                      placeholder="例如：Van Arkride"
                      className="kr-input"
                    />
                  </label>
                </div>

                <div className="kr-grid-2">
                  <label>
                    实体类型
                    <select
                      value={editingEntity.entityType}
                      onChange={(e) =>
                        setEditingEntity({
                          ...editingEntity,
                          entityType: e.target.value as EntityType,
                        })
                      }
                      className="kr-select"
                    >
                      {(Object.keys(ENTITY_TYPE_META) as EntityType[]).map((t) => (
                        <option key={t} value={t}>
                          {ENTITY_TYPE_META[t].label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    默认重要度分级
                    <select
                      value={editingEntity.importance ?? 'supporting'}
                      onChange={(e) =>
                        setEditingEntity({
                          ...editingEntity,
                          importance: e.target.value as ImportanceTier,
                        })
                      }
                      className="kr-select"
                    >
                      <option value="core">★ 核心主线</option>
                      <option value="supporting">★★ 重要配角</option>
                      <option value="minor">★★★ 次要登场</option>
                    </select>
                  </label>
                </div>

                <div className="kr-grid-2">
                  <label>
                    所属国家 / 政体 (nationId)
                    <select
                      value={editingEntity.nationId ?? ''}
                      onChange={(e) =>
                        setEditingEntity({
                          ...editingEntity,
                          nationId: e.target.value || undefined,
                        })
                      }
                      className="kr-select"
                    >
                      <option value="">（无 / 跨国或中立）</option>
                      {nationEntities
                        .filter((n) => n.id !== editingEntity.id)
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.canonicalName} ({n.id})
                          </option>
                        ))}
                    </select>
                  </label>

                  <label>
                    默认归属组织/家族/流派 (defaultGroupId)
                    <select
                      value={editingEntity.defaultGroupId ?? ''}
                      onChange={(e) =>
                        setEditingEntity({
                          ...editingEntity,
                          defaultGroupId: e.target.value || undefined,
                        })
                      }
                      className="kr-select"
                    >
                      <option value="">（无默认归属组织）</option>
                      {groupEntities
                        .filter((g) => g.id !== editingEntity.id)
                        .map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.canonicalName}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>

                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                    登场作品层 (arcs)
                  </div>
                  <div className="kr-qa-arcs">
                    {dataset.arcs.map((a) => {
                      const on = editingEntity.arcs.includes(a.id);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          className={`kr-arc-chip ${on ? 'on' : ''}`}
                          onClick={() => {
                            const nextArcs = on
                              ? editingEntity.arcs.length > 1
                                ? editingEntity.arcs.filter((x) => x !== a.id)
                                : editingEntity.arcs
                              : [...editingEntity.arcs, a.id];
                            setEditingEntity({ ...editingEntity, arcs: nextArcs });
                          }}
                        >
                          {on ? '✓ ' : ''}
                          {a.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <label>
                  别名 / 称号检索词（逗号分隔，用于前台搜索命中）
                  <input
                    type="text"
                    value={aliasesDraft}
                    onChange={(e) => setAliasesDraft(e.target.value)}
                    placeholder="例如：剑圣, 八叶一刀流传人"
                    className="kr-input"
                  />
                </label>

                <label>
                  默认头衔 / 身份副标题
                  <input
                    type="text"
                    value={editingEntity.defaultTitle ?? ''}
                    onChange={(e) =>
                      setEditingEntity({ ...editingEntity, defaultTitle: e.target.value })
                    }
                    className="kr-input"
                  />
                </label>

                <label>
                  头像 URL（支持直接粘贴或从 WP 媒体库选取）
                  <div className="kr-wp-search-row">
                    <input
                      type="text"
                      value={editingEntity.defaultAvatarUrl ?? ''}
                      onChange={(e) =>
                        setEditingEntity({ ...editingEntity, defaultAvatarUrl: e.target.value })
                      }
                      className="kr-input"
                    />
                    <button
                      type="button"
                      className="kr-btn secondary"
                      onClick={handlePickMediaAvatar}
                    >
                      媒体库
                    </button>
                  </div>
                </label>

                <label>
                  百科词条页面 URL (wikiUrl)
                  <input
                    type="text"
                    value={editingEntity.wikiUrl ?? ''}
                    onChange={(e) =>
                      setEditingEntity({ ...editingEntity, wikiUrl: e.target.value })
                    }
                    className="kr-input"
                  />
                </label>

                <label>
                  简介描述
                  <textarea
                    rows={3}
                    value={editingEntity.bio}
                    onChange={(e) => setEditingEntity({ ...editingEntity, bio: e.target.value })}
                    className="kr-textarea"
                  />
                </label>

                {/* Cross-Arc Profile Evolution Editor (arcOverrides) */}
                <div className="kr-override-box">
                  <div className="kr-override-header">
                    <span>✦ 跨作品身份与重要度演变覆写 (arcOverrides)</span>
                    {editingEntity.arcOverrides?.[overrideArcId] && (
                      <button
                        type="button"
                        className="kr-btn danger small"
                        onClick={() => updateEditingOverride(overrideArcId, null)}
                      >
                        清除该层覆写
                      </button>
                    )}
                  </div>

                  <div className="kr-qa-arcs" style={{ marginBottom: 8 }}>
                    {dataset.arcs.map((a) => {
                      const hasOv = Boolean(editingEntity.arcOverrides?.[a.id]);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          className={`kr-arc-chip ${overrideArcId === a.id ? 'on' : ''}`}
                          onClick={() => setOverrideArcId(a.id)}
                        >
                          {hasOv ? '✦ ' : ''}
                          {a.shortName}
                        </button>
                      );
                    })}
                  </div>

                  <div className="kr-form-stack">
                    <div className="kr-grid-2">
                      <label>
                        该层显示名 (displayName)
                        <input
                          type="text"
                          value={currentOverride.displayName ?? ''}
                          onChange={(e) =>
                            updateEditingOverride(overrideArcId, { displayName: e.target.value })
                          }
                          placeholder="留空继承默认名称"
                          className="kr-input compact"
                        />
                      </label>
                      <label>
                        该层重要度 (importance)
                        <select
                          value={currentOverride.importance ?? ''}
                          onChange={(e) =>
                            updateEditingOverride(overrideArcId, {
                              importance: (e.target.value || undefined) as ImportanceTier | undefined,
                            })
                          }
                          className="kr-select compact"
                        >
                          <option value="">（继承默认重要度）</option>
                          <option value="core">★ 核心主线</option>
                          <option value="supporting">★★ 重要配角</option>
                          <option value="minor">★★★ 次要登场</option>
                        </select>
                      </label>
                    </div>

                    <div className="kr-grid-2">
                      <label>
                        该层头衔 (title)
                        <input
                          type="text"
                          value={currentOverride.title ?? ''}
                          onChange={(e) =>
                            updateEditingOverride(overrideArcId, { title: e.target.value })
                          }
                          placeholder="留空继承默认头衔"
                          className="kr-input compact"
                        />
                      </label>
                      <label>
                        该层归属组织 (primaryGroupId)
                        <select
                          value={currentOverride.primaryGroupId ?? ''}
                          onChange={(e) =>
                            updateEditingOverride(overrideArcId, {
                              primaryGroupId: e.target.value || undefined,
                            })
                          }
                          className="kr-select compact"
                        >
                          <option value="">（继承默认归属组织）</option>
                          {groupEntities
                            .filter((g) => g.id !== editingEntity.id)
                            .map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.canonicalName}
                              </option>
                            ))}
                        </select>
                      </label>
                    </div>

                    <label>
                      该层专属头像 URL (avatarUrl)
                      <input
                        type="text"
                        value={currentOverride.avatarUrl ?? ''}
                        onChange={(e) =>
                          updateEditingOverride(overrideArcId, { avatarUrl: e.target.value })
                        }
                        placeholder="https://... 留空继承默认头像"
                        className="kr-input compact"
                      />
                    </label>

                    <label>
                      该层专属简介 (bio)
                      <textarea
                        rows={2}
                        value={currentOverride.bio ?? ''}
                        onChange={(e) =>
                          updateEditingOverride(overrideArcId, { bio: e.target.value })
                        }
                        placeholder="留空继承默认简介"
                        className="kr-textarea"
                      />
                    </label>
                  </div>
                </div>

                <div className="kr-row-btns end">
                  <button
                    type="button"
                    className="kr-btn secondary"
                    onClick={() => {
                      setEditingEntity(null);
                      setIsNewEntity(false);
                    }}
                  >
                    关闭
                  </button>
                  <button
                    type="button"
                    className="kr-btn primary"
                    disabled={busy || !editingEntity.id.trim() || !editingEntity.canonicalName.trim()}
                    onClick={() => {
                      if (isNewEntity && entityMap.has(editingEntity.id.trim())) {
                        showToast('err', `实体 ID「${editingEntity.id.trim()}」已存在，请更换新的唯一 ID`);
                        return;
                      }
                      const cleanEntity = sanitizeEntityForSave(
                        editingEntity,
                        aliasesDraft,
                        dataset.arcs[dataset.arcs.length - 1]?.id || 'kuro'
                      );
                      submitPatch(
                        {
                          action: 'upsert_entity',
                          entity: cleanEntity,
                          summary: `${isNewEntity ? '新增' : '更新'}实体 ${cleanEntity.canonicalName}`,
                        },
                        `已保存实体「${cleanEntity.canonicalName}」`
                      );
                      setEditingEntity(null);
                      setIsNewEntity(false);
                    }}
                  >
                    保存实体更改
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: ARC LAYERS MANAGER */}
      {activeTab === 'arcs' && (
        <div className="kr-panel-card">
          <h3>作品分层列表（决定前台顶部作品层切换栏与跨作演变时间轴顺序）</h3>
          <table className="kr-data-table">
            <thead>
              <tr>
                <th>排序权重</th>
                <th>标识 ID</th>
                <th>作品全称</th>
                <th>简称</th>
                <th>纪年副标题</th>
                <th>主题色</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {dataset.arcs.map((a) => (
                <tr key={a.id}>
                  <td>{a.order}</td>
                  <td>
                    <code>{a.id}</code>
                  </td>
                  <td>
                    <strong>{a.name}</strong>
                  </td>
                  <td>{a.shortName}</td>
                  <td>{a.subtitle}</td>
                  <td>
                    <span className="kr-color-dot" style={{ background: a.accent }} /> {a.accent}
                  </td>
                  <td>
                    <div className="kr-row-btns">
                      <button
                        type="button"
                        className="kr-btn secondary small"
                        onClick={() => {
                          setEditingArcId(a.id);
                          setNewArcId(a.id);
                          setNewArcName(a.name);
                          setNewArcShort(a.shortName);
                          setNewArcSub(a.subtitle);
                          setNewArcOrder(a.order);
                          setNewArcAccent(/^#[0-9a-fA-F]{6}$/.test(a.accent) ? a.accent : '#38bdf8');
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="kr-btn danger small"
                        disabled={busy || dataset.arcs.length <= 1}
                        onClick={() => {
                          if (!window.confirm(`确认删除作品层「${a.name} (${a.id})」吗？`)) return;
                          if (studioArc === a.id) setStudioArc('all');
                          if (editingArcId === a.id) resetArcForm();
                          submitPatch(
                            {
                              action: 'delete_arc',
                              arcId: a.id,
                              id: a.id,
                              summary: `删除作品层 ${a.name} (${a.id})`,
                            },
                            `已删除作品层「${a.name}」`
                          );
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <form
            className="kr-new-arc-form"
            onSubmit={(e) => {
              e.preventDefault();
              const cleanId = (editingArcId ?? newArcId).trim().toLowerCase();
              if (!cleanId || !newArcName.trim()) return;
              const maxOrder = Math.max(0, ...dataset.arcs.map((a) => a.order));
              const arc: ArcDefinition = {
                id: cleanId,
                name: newArcName.trim(),
                shortName: newArcShort.trim() || newArcName.trim().slice(0, 2),
                subtitle: newArcSub.trim() || '新增作品篇章',
                order: editingArcId ? Number(newArcOrder) || 10 : maxOrder + 10,
                accent: /^#[0-9a-fA-F]{6}$/.test(newArcAccent) ? newArcAccent : '#a78bfa',
              };
              submitPatch(
                {
                  action: 'upsert_arc',
                  arc,
                  summary: `${editingArcId ? '修改' : '新增'}作品层 ${arc.name}`,
                },
                `已${editingArcId ? '更新' : '新增'}作品层「${arc.name}」`
              );
              resetArcForm();
            }}
          >
            <h4>
              {editingArcId
                ? `✎ 编辑作品层：${editingArcId}`
                : '+ 新增后续作品层（例如：kuro2 黎之轨迹II / kai 界之轨迹）'}
            </h4>
            <div className="kr-grid-5">
              <input
                type="text"
                value={editingArcId ?? newArcId}
                readOnly={Boolean(editingArcId)}
                disabled={Boolean(editingArcId)}
                onChange={(e) => setNewArcId(e.target.value)}
                placeholder="层ID (如 kuro2)"
                className={`kr-input ${editingArcId ? 'kr-input-readonly' : ''}`}
              />
              <input
                type="text"
                value={newArcName}
                onChange={(e) => setNewArcName(e.target.value)}
                placeholder="名称 (如 黎之轨迹II)"
                className="kr-input"
              />
              <input
                type="text"
                value={newArcShort}
                onChange={(e) => setNewArcShort(e.target.value)}
                placeholder="简称 (如 黎轨II)"
                className="kr-input"
              />
              <input
                type="text"
                value={newArcSub}
                onChange={(e) => setNewArcSub(e.target.value)}
                placeholder="副标题 (如 S.1209)"
                className="kr-input"
              />
              <div className="kr-wp-search-row">
                {editingArcId && (
                  <input
                    type="number"
                    value={newArcOrder}
                    onChange={(e) => setNewArcOrder(Number(e.target.value))}
                    title="排序权重"
                    className="kr-input compact"
                    style={{ minWidth: 68, width: 68 }}
                  />
                )}
                <input
                  type="color"
                  value={newArcAccent}
                  onChange={(e) => setNewArcAccent(e.target.value)}
                />
                <button type="submit" className="kr-btn primary" disabled={busy}>
                  {editingArcId ? '保存修改' : '创建作品层'}
                </button>
                {editingArcId && (
                  <button
                    type="button"
                    className="kr-btn secondary small"
                    onClick={resetArcForm}
                  >
                    取消
                  </button>
                )}
              </div>
            </div>
          </form>
        </div>
      )}

      {/* TAB 5: IMPORT / EXPORT & BACKUP ROLLBACK */}
      {activeTab === 'io' && (
        <div className="kr-grid-2-panels">
          <div className="kr-panel-card">
            <h3>📤 导出与 📥 批量导入</h3>
            <p className="kr-muted">
              支持导出标准静态 JSON / CSV，并可直接上传 Excel 工作簿 (<code>.xlsx</code> 含「角色」与「人物组织关系」工作表)、JSON 或 CSV 进行合并或全量更新。
            </p>
            <div className="kr-row-btns">
              <button
                type="button"
                className="kr-btn primary"
                onClick={() => handleExportDownload('json')}
              >
                下载完整静态 JSON (zemuria.json)
              </button>
              <button
                type="button"
                className="kr-btn secondary"
                onClick={() => handleExportDownload('csv')}
              >
                导出关系表 CSV
              </button>
            </div>

            <hr className="kr-sep" />

            <form onSubmit={handleImportSubmit} className="kr-form-stack">
              <div className="kr-grid-2">
                <label>
                  导入模式
                  <select
                    value={importMode}
                    onChange={(e) => setImportMode(e.target.value as 'merge' | 'replace')}
                    className="kr-select"
                  >
                    <option value="merge">增量合并（保留现有手动修改）</option>
                    <option value="replace">全量替换（自动备份旧版后覆盖）</option>
                  </select>
                </label>
                <label>
                  数据格式
                  <select
                    value={importFormat}
                    onChange={(e) => {
                      const nextFmt = e.target.value as 'json' | 'csv' | 'xlsx';
                      setImportFormat(nextFmt);
                      if (nextFmt !== 'xlsx') setImportFileName('');
                    }}
                    className="kr-select"
                  >
                    <option value="json">标准图谱 JSON</option>
                    <option value="csv">关系列表 CSV</option>
                    <option value="xlsx">Excel 工作簿 (.xlsx)</option>
                  </select>
                </label>
              </div>

              <label>
                选择本地文件自动读取 (.json / .csv / .xlsx)
                <input
                  type="file"
                  accept=".json,.csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={handleImportFileChange}
                />
              </label>

              {importFormat === 'xlsx' ? (
                <div className="kr-xlsx-ready">
                  <span>
                    {importText
                      ? `📊 已加载 Excel 工作簿：${importFileName || 'relation.xlsx'}（Base64 就绪）`
                      : '请选择包含「角色」或「人物组织关系」表的 .xlsx 文件'}
                  </span>
                  {importText && (
                    <button
                      type="button"
                      className="kr-btn secondary small"
                      onClick={() => {
                        setImportText('');
                        setImportFileName('');
                      }}
                    >
                      清除
                    </button>
                  )}
                </div>
              ) : (
                <textarea
                  rows={6}
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder="或直接在此粘贴 JSON / CSV 文本…"
                  className="kr-textarea"
                />
              )}

              <button type="submit" className="kr-btn primary" disabled={busy || !importText.trim()}>
                执行导入并更新静态快照
              </button>
            </form>
          </div>

          <div className="kr-panel-card">
            <h3>🕒 自动滚动历史备份（支持一键无损回滚）</h3>
            <p className="kr-muted">
              每次保存、导入或回滚前系统均会自动在 <code>uploads/kiseki-relations/backups/</code>{' '}
              生成带操作员署名的备份快照。
            </p>
            <div className="kr-backup-list">
              {backups.length === 0 ? (
                <div className="kr-muted">尚无历史修订记录（首次修改后自动生成）。</div>
              ) : (
                backups.map((b) => (
                  <div key={b.file} className="kr-backup-row">
                    <div>
                      <strong>v{b.version}</strong> · {b.timestamp} · 操作员：
                      <strong>{b.user}</strong> ({b.sizeKb} KB)
                      <div className="kr-muted">{b.file}</div>
                    </div>
                    <button
                      type="button"
                      className="kr-btn secondary small"
                      disabled={busy}
                      onClick={() => handleRestoreBackup(b.file)}
                    >
                      回滚至此版
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
