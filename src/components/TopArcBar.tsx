import React from 'react';
import {
  Layers,
  Orbit,
  Network,
  Focus,
  Tag,
  Sparkles,
  Settings,
  ExternalLink,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { ArcDefinition, isSafeNavUrl } from '../types/graph';

interface TopArcBarProps {
  arcs: ArcDefinition[];
  selectedArcs: string[];
  viewMode: '3d' | '2d';
  mode: 'full' | 'mini';
  egoFocusMode: boolean;
  alwaysShowLabels: boolean;
  isWebFullscreen: boolean;
  hasSelectedNode: boolean;
  nodeCount: number;
  linkCount: number;
  adminStudioUrl?: string;
  fullGraphPageUrl?: string;
  enableDemoSandbox?: boolean;
  onSelectSingleArc: (arcId: string) => void;
  onToggleArcMulti: (arcId: string) => void;
  onSelectAllArcs: () => void;
  onChangeViewMode: (mode: '3d' | '2d') => void;
  onToggleEgoFocus: () => void;
  onToggleAlwaysShowLabels: () => void;
  onToggleWebFullscreen: () => void;
  onOpenQuickEdit: () => void;
}

export const TopArcBar: React.FC<TopArcBarProps> = ({
  arcs,
  selectedArcs,
  viewMode,
  mode,
  egoFocusMode,
  alwaysShowLabels,
  isWebFullscreen,
  hasSelectedNode,
  nodeCount,
  linkCount,
  adminStudioUrl,
  fullGraphPageUrl,
  enableDemoSandbox,
  onSelectSingleArc,
  onToggleArcMulti,
  onSelectAllArcs,
  onChangeViewMode,
  onToggleEgoFocus,
  onToggleAlwaysShowLabels,
  onToggleWebFullscreen,
  onOpenQuickEdit,
}) => {
  const isAllSelected = selectedArcs.length === arcs.length && arcs.length > 1;

  return (
    <header className="top-arc-bar">
      <div className="brand-cluster">
        <div className="xipha-core-badge">XIPHA</div>
        <div>
          <div className="brand-title">
            {mode === 'mini' ? '角色关联导力网' : '塞姆利亚导力关系图谱'}
          </div>
          <div className="brand-stats">
            <span>{nodeCount} 实体</span>
            <span className="dot-sep">·</span>
            <span>{linkCount} 关系弧</span>
          </div>
        </div>
      </div>

      <div className="arc-layer-switcher" role="tablist" aria-label="作品分层切换">
        {mode === 'full' && (
          <span className="switcher-caption" title="按住 Shift 点击可多选叠加不同作品层">
            <Layers size={14} />
            作品层
          </span>
        )}
        {arcs.map((arc) => {
          const active = !isAllSelected && selectedArcs.includes(arc.id);
          return (
            <button
              key={arc.id}
              type="button"
              className={`arc-pill ${active ? 'active' : ''}`}
              style={{ '--arc-accent': arc.accent } as React.CSSProperties}
              onClick={(e) => {
                if (e.shiftKey) {
                  onToggleArcMulti(arc.id);
                } else {
                  onSelectSingleArc(arc.id);
                }
              }}
              title={`${arc.subtitle}（按住 Shift 点击可跨作叠加对比）`}
            >
              <span className="arc-pill-dot" style={{ background: arc.accent }} />
              <span>{mode === 'mini' ? arc.shortName : arc.name}</span>
            </button>
          );
        })}
        {arcs.length > 1 && (
          <button
            type="button"
            className={`arc-pill all-series ${isAllSelected ? 'active' : ''}`}
            onClick={onSelectAllArcs}
            title="合并展示所有作品星系与跨作品角色演变"
          >
            <span>{mode === 'mini' ? '全系列' : '全系列总览'}</span>
          </button>
        )}
      </div>

      <div className="view-action-cluster">
        <div className="segmented-toggle" role="group" aria-label="渲染维度切换">
          <button
            type="button"
            className={viewMode === '3d' ? 'active' : ''}
            onClick={() => onChangeViewMode('3d')}
          >
            <Orbit size={15} />
            <span>3D 星盘</span>
          </button>
          <button
            type="button"
            className={viewMode === '2d' ? 'active' : ''}
            onClick={() => onChangeViewMode('2d')}
          >
            <Network size={15} />
            <span>2D 战术图</span>
          </button>
        </div>

        {viewMode === '2d' && mode === 'full' && (
          <button
            type="button"
            className={`hud-btn ${egoFocusMode ? 'active' : ''}`}
            disabled={!hasSelectedNode && !egoFocusMode}
            onClick={onToggleEgoFocus}
            title={hasSelectedNode ? '以当前选中人物/组织为圆心展开1-2跳同心环' : '请先点击任意节点'}
          >
            <Focus size={14} />
            <span>中心环聚焦</span>
          </button>
        )}

        <button
          type="button"
          className={`hud-btn ${alwaysShowLabels ? 'active' : ''}`}
          onClick={onToggleAlwaysShowLabels}
          title="切换是否常驻显示所有边的关系文字"
        >
          <Tag size={14} />
          <span>常显关系词</span>
        </button>

        {mode === 'mini' && isSafeNavUrl(fullGraphPageUrl) && (
          <a href={fullGraphPageUrl.trim()} className="hud-btn accent-btn">
            <span>全幅关系图</span>
            <ExternalLink size={13} />
          </a>
        )}

        {isSafeNavUrl(adminStudioUrl) && (
          <a
            href={adminStudioUrl.trim()}
            className="hud-btn accent-btn"
            title="Editor / Admin 专属入口：进入 WordPress 后台关系图工作台"
          >
            <Settings size={14} />
            <span>后台编辑</span>
          </a>
        )}

        {enableDemoSandbox && !adminStudioUrl && (
          <button
            type="button"
            className="hud-btn accent-btn"
            onClick={onOpenQuickEdit}
            title="预览后台「3秒新增关系 / 跨作关系演变」操作体验"
          >
            <Sparkles size={14} />
            <span>快捷编辑预览</span>
          </button>
        )}

        <button
          type="button"
          className={`hud-btn ${isWebFullscreen ? 'active' : ''}`}
          onClick={onToggleWebFullscreen}
          aria-pressed={isWebFullscreen}
          title={isWebFullscreen ? '退出网页全屏 (Esc)' : '在当前浏览器窗口内全屏铺满关系图 (Esc 退出)'}
        >
          {isWebFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          <span>{isWebFullscreen ? '退出全屏' : '网页全屏'}</span>
        </button>
      </div>
    </header>
  );
};
