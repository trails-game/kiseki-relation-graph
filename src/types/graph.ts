export type EntityType = 'nation' | 'organization' | 'family' | 'school' | 'character';

export type ImportanceTier = 'core' | 'supporting' | 'minor';

export type RelationCategory =
  | 'membership'
  | 'hierarchy'
  | 'family'
  | 'school'
  | 'ally'
  | 'romance'
  | 'hostile';

export interface ArcDefinition {
  id: string;
  name: string;
  shortName: string;
  subtitle: string;
  order: number;
  accent: string;
}

export interface ArcProfileOverride {
  displayName?: string;
  title?: string;
  primaryGroupId?: string;
  avatarUrl?: string;
  importance?: ImportanceTier;
  bio?: string;
}

export interface ScriptMoment {
  chapter: string;
  speaker: string;
  quote: string;
}

export interface EntityRecord {
  id: string;
  canonicalName: string;
  nameEn?: string;
  entityType: EntityType;
  subtype?: string;
  importance?: ImportanceTier;
  nationId?: string;
  defaultGroupId?: string;
  defaultTitle?: string;
  wpPostId?: number;
  defaultAvatarUrl?: string;
  wikiUrl?: string;
  aliases?: string[];
  arcs: string[];
  arcOverrides?: Record<string, ArcProfileOverride>;
  bio: string;
  scriptMoments?: ScriptMoment[];
}

export interface RelationRecord {
  id: string;
  source: string;
  target: string;
  category: RelationCategory;
  label: string;
  direction: 'directed' | 'bidirectional';
  weight: number;
  arcs: string[];
  supersedesId?: string;
  status?: 'published' | 'pending_review' | 'draft';
  note?: string;
}

export interface GraphDataset {
  schemaVersion: number;
  version: number;
  updatedAt: string;
  updatedBy?: string;
  arcs: ArcDefinition[];
  entities: EntityRecord[];
  relations: RelationRecord[];
}

export interface ViewerMountConfig {
  dataUrl?: string;
  initialData?: GraphDataset;
  mode?: 'full' | 'mini';
  defaultArc?: string;
  defaultTier?: ImportanceTier;
  defaultView?: '3d' | '2d';
  focusNodeId?: string;
  focusWpPostId?: number;
  height?: string;
  fullGraphPageUrl?: string;
  adminStudioUrl?: string;
  enableDemoSandbox?: boolean;
}

export interface ResolvedNode {
  id: string;
  name: string;
  canonicalName: string;
  nameEn?: string;
  entityType: EntityType;
  subtype?: string;
  title?: string;
  avatarUrl?: string;
  importance: ImportanceTier;
  wpPostId?: number;
  wikiUrl?: string;
  nationId?: string;
  primaryGroupId?: string;
  bio: string;
  arcs: string[];
  hasEvolution: boolean;
  isBridgeNode: boolean;
  degree: number;
  raw: EntityRecord;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  fx?: number;
  fy?: number;
  fz?: number;
}

export interface ResolvedLink {
  id: string;
  source: string | ResolvedNode;
  target: string | ResolvedNode;
  sourceId: string;
  targetId: string;
  category: RelationCategory;
  label: string;
  direction: 'directed' | 'bidirectional';
  weight: number;
  arcs: string[];
  supersedesId?: string;
  priorLabel?: string;
  priorArcs?: string[];
  note?: string;
  parallelIndex: number;
  parallelTotal: number;
  curvature: number;
  curveRotation: number;
}

export const ENTITY_TYPE_META: Record<
  EntityType,
  { label: string; color: string; badgeBg: string; baseSize: number }
> = {
  nation: {
    label: '国家 / 政体',
    color: '#f59e0b',
    badgeBg: 'rgba(245, 158, 11, 0.18)',
    baseSize: 26,
  },
  organization: {
    label: '组织 / 势力',
    color: '#38bdf8',
    badgeBg: 'rgba(56, 189, 248, 0.18)',
    baseSize: 20,
  },
  family: {
    label: '家族 / 氏族',
    color: '#34d399',
    badgeBg: 'rgba(52, 211, 153, 0.18)',
    baseSize: 17,
  },
  school: {
    label: '武术流派',
    color: '#c084fc',
    badgeBg: 'rgba(192, 132, 252, 0.18)',
    baseSize: 18,
  },
  character: {
    label: '角色人物',
    color: '#e2e8f0',
    badgeBg: 'rgba(148, 163, 184, 0.18)',
    baseSize: 14,
  },
};

export const RELATION_CATEGORY_META: Record<
  RelationCategory,
  { label: string; color: string; dashed?: boolean }
> = {
  membership: { label: '隶属 / 成员', color: '#38bdf8' },
  hierarchy: { label: '管辖 / 委托 / 合作', color: '#fbbf24' },
  family: { label: '血脉 / 家族', color: '#34d399' },
  school: { label: '师徒 / 流派', color: '#c084fc' },
  ally: { label: '伙伴 / 挚友', color: '#60a5fa' },
  romance: { label: '羁绊 / 恋慕', color: '#f472b6' },
  hostile: { label: '宿敌 / 对立', color: '#f87171', dashed: true },
};

export function getEntityTypeMeta(t?: string | null) {
  return (t ? ENTITY_TYPE_META[t as EntityType] : undefined) ?? ENTITY_TYPE_META.character;
}

export function getRelationCategoryMeta(c?: string | null) {
  return (c ? RELATION_CATEGORY_META[c as RelationCategory] : undefined) ?? RELATION_CATEGORY_META.ally;
}

export function isSafeHttpUrl(url?: string | null): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

export function isSafeNavUrl(url?: string | null): url is string {
  return typeof url === 'string' && /^(https?:\/\/|\/)/i.test(url.trim());
}
