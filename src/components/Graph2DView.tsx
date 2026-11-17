import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  Simulation,
} from 'd3-force';
import { polygonHull } from 'd3-polygon';
import {
  getEntityTypeMeta,
  getRelationCategoryMeta,
  ResolvedLink,
  ResolvedNode,
} from '../types/graph';
import { drawNodeShapePath, requestAvatarImage } from '../engine/spriteRenderer';

interface Graph2DViewProps {
  nodes: ResolvedNode[];
  links: ResolvedLink[];
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  highlightedNodeIds: Set<string>;
  highlightedLinkIds: Set<string>;
  egoFocusMode: boolean;
  alwaysShowLabels: boolean;
  collapsedGroupIds: Set<string>;
  onSelectNode: (nodeId: string | null) => void;
  onHoverNode: (nodeId: string | null) => void;
  onSelectLink: (link: ResolvedLink | null) => void;
  onToggleCollapseGroup: (groupId: string) => void;
}

const NATION_CENTERS_2D: Record<string, [number, number]> = {
  calvard: [290, 20],
  erebonia: [-310, -30],
  crossbell: [-15, -20],
  liberl: [-165, 275],
  elsaim: [370, 265],
  ored: [185, -235],
  arteria: [30, -295],
  remiferia: [-160, -265],
  northambria: [-265, -245],
};

function expandHullPoints(pts: [number, number][], pad: number): [number, number][] {
  if (pts.length === 0) return [];
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= pts.length;
  cy /= pts.length;
  return pts.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * pad, y + (dy / len) * pad];
  });
}

function pointToSegmentDistSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return (px - projX) * (px - projX) + (py - projY) * (py - projY);
}

function distToQuadraticBezier(
  px: number,
  py: number,
  sx: number,
  sy: number,
  cx: number,
  cy: number,
  tx: number,
  ty: number
): number {
  const steps = 24;
  let minSq = Infinity;
  let prevX = sx;
  let prevY = sy;
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const inv = 1 - u;
    const qx = inv * inv * sx + 2 * inv * u * cx + u * u * tx;
    const qy = inv * inv * sy + 2 * inv * u * cy + u * u * ty;
    const dSq = pointToSegmentDistSq(px, py, prevX, prevY, qx, qy);
    if (dSq < minSq) minSq = dSq;
    prevX = qx;
    prevY = qy;
  }
  return Math.sqrt(minSq);
}

export const Graph2DView: React.FC<Graph2DViewProps> = ({
  nodes,
  links,
  selectedNodeId,
  hoveredNodeId,
  highlightedNodeIds,
  highlightedLinkIds,
  egoFocusMode,
  alwaysShowLabels,
  collapsedGroupIds,
  onSelectNode,
  onHoverNode,
  onSelectLink,
  onToggleCollapseGroup,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simNodesRef = useRef<ResolvedNode[]>([]);
  const simLinksRef = useRef<ResolvedLink[]>([]);
  const simRef = useRef<Simulation<ResolvedNode, ResolvedLink> | null>(null);

  const transformRef = useRef({ x: 0, y: 0, k: 0.92 });
  const [zoomTier, setZoomTier] = useState<'macro' | 'mid' | 'detail'>('mid');
  const dragStateRef = useRef<{
    type: 'pan' | 'node' | null;
    node?: ResolvedNode;
    pointerId?: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  }>({ type: null, startX: 0, startY: 0, origX: 0, origY: 0, moved: false });

  const renderTickRef = useRef<() => void>(() => {});
  const rafPendingRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);

  // Single stable coalesced repaint callback per Graph2DView instance (prevents O(M * 2^K) listener explosion)
  const requestRepaint = useCallback(() => {
    if (rafPendingRef.current) return;
    rafPendingRef.current = true;
    rafIdRef.current = window.requestAnimationFrame(() => {
      rafPendingRef.current = false;
      rafIdRef.current = null;
      renderTickRef.current();
    });
  }, []);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      rafPendingRef.current = false;
    };
  }, []);

  const getNodeRadius = (n: ResolvedNode) => getEntityTypeMeta(n.entityType).baseSize;

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    // Tactical dark orbment background + subtle coordinate grid
    const bg = ctx.createRadialGradient(
      width * 0.5,
      height * 0.45,
      40,
      width * 0.5,
      height * 0.5,
      Math.max(width, height) * 0.75
    );
    bg.addColorStop(0, '#0d162c');
    bg.addColorStop(1, '#060913');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    const { x: tx, y: ty, k } = transformRef.current;

    // World space transform
    ctx.translate(width / 2 + tx, height / 2 + ty);
    ctx.scale(k, k);

    // Subtle Xipha tactical radar rings in Ego Focus Mode
    if (egoFocusMode && selectedNodeId) {
      ctx.save();
      for (const ringR of [190, 365]) {
        ctx.beginPath();
        ctx.arc(0, 0, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.16)';
        ctx.setLineDash([8, 8]);
        ctx.lineWidth = 1.5 / k;
        ctx.stroke();
      }
      ctx.restore();
    }

    const activeNodes = simNodesRef.current;
    const activeLinks = simLinksRef.current;
    const nodeById = new Map(activeNodes.map((n) => [n.id, n]));
    const hasHighlight = highlightedNodeIds.size > 0;

    // 1. Draw translucent Faction / Nation Territory Convex Hulls (when not in Ego ring mode)
    if (!egoFocusMode) {
      const groupBuckets = new Map<string, ResolvedNode[]>();
      for (const n of activeNodes) {
        const gid = n.primaryGroupId || (n.entityType === 'organization' ? n.id : undefined);
        if (!gid) continue;
        if (!groupBuckets.has(gid)) groupBuckets.set(gid, []);
        groupBuckets.get(gid)!.push(n);
      }

      for (const [gid, members] of groupBuckets.entries()) {
        const groupEntity = nodeById.get(gid);
        if (!groupEntity || members.length < 3) continue;
        const pts: [number, number][] = [];
        for (const m of members) {
          if (m.x === undefined || m.y === undefined) continue;
          pts.push([m.x, m.y]);
        }
        if (groupEntity.x !== undefined && groupEntity.y !== undefined) {
          pts.push([groupEntity.x, groupEntity.y]);
        }
        if (pts.length < 3) continue;
        const rawHull = polygonHull(pts);
        if (!rawHull) continue;
        const hull = expandHullPoints(rawHull, 40);

        const hueColor =
          groupEntity.entityType === 'nation'
            ? 'rgba(245, 158, 11, 0.06)'
            : 'rgba(56, 189, 248, 0.055)';
        const borderColor =
          groupEntity.entityType === 'nation'
            ? 'rgba(245, 158, 11, 0.22)'
            : 'rgba(56, 189, 248, 0.18)';

        ctx.save();
        ctx.beginPath();
        for (let i = 0; i < hull.length; i++) {
          const curr = hull[i];
          const next = hull[(i + 1) % hull.length];
          const midX = (curr[0] + next[0]) / 2;
          const midY = (curr[1] + next[1]) / 2;
          if (i === 0) {
            const prev = hull[hull.length - 1];
            ctx.moveTo((prev[0] + curr[0]) / 2, (prev[1] + curr[1]) / 2);
          }
          ctx.quadraticCurveTo(curr[0], curr[1], midX, midY);
        }
        ctx.closePath();
        ctx.fillStyle = hueColor;
        ctx.fill();
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1.2 / k;
        ctx.stroke();
        ctx.restore();
      }
    }

    // 2. Draw Curved Multi-Edges & Directional Arrowheads
    activeLinks.forEach((link, linkIdx) => {
      const s = nodeById.get(link.sourceId);
      const t = nodeById.get(link.targetId);
      if (!s || !t || s.x === undefined || s.y === undefined || t.x === undefined || t.y === undefined) {
        return;
      }

      // Semantic zoom culling: at extreme macro zoom (<0.52), hide non-highlighted character-to-character minor links
      const isHighlightedLink = !hasHighlight || highlightedLinkIds.has(link.id);
      if (k < 0.52 && !hasHighlight && s.entityType === 'character' && t.entityType === 'character' && link.weight < 4) {
        return;
      }

      const catMeta = getRelationCategoryMeta(link.category);
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = -dy / dist;
      const ny = dx / dist;
      const offset = link.curvature * Math.min(dist * 0.55, 160);
      const cx = (s.x + t.x) / 2 + nx * offset;
      const cy = (s.y + t.y) / 2 + ny * offset;

      ctx.save();
      ctx.globalAlpha = isHighlightedLink ? (hasHighlight ? 0.96 : 0.68) : 0.09;
      ctx.strokeStyle = catMeta.color;
      ctx.lineWidth = isHighlightedLink && hasHighlight ? 2.6 : 1.5;
      if (catMeta.dashed) {
        ctx.setLineDash([6, 5]);
      }

      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.quadraticCurveTo(cx, cy, t.x, t.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Directional arrowhead near target perimeter
      if (link.direction === 'directed') {
        const tr = getNodeRadius(t) + 5;
        const tParam = Math.max(0.55, 1 - tr / dist);
        const ax = (1 - tParam) * (1 - tParam) * s.x + 2 * (1 - tParam) * tParam * cx + tParam * tParam * t.x;
        const ay = (1 - tParam) * (1 - tParam) * s.y + 2 * (1 - tParam) * tParam * cy + tParam * tParam * t.y;
        const txVec = 2 * (1 - tParam) * (cx - s.x) + 2 * tParam * (t.x - cx);
        const tyVec = 2 * (1 - tParam) * (cy - s.y) + 2 * tParam * (t.y - cy);
        const angle = Math.atan2(tyVec, txVec);
        const arrowLen = 7.5;

        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - arrowLen * Math.cos(angle - Math.PI / 6), ay - arrowLen * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(ax - arrowLen * Math.cos(angle + Math.PI / 6), ay - arrowLen * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fillStyle = catMeta.color;
        ctx.fill();
      }

      // Semantic Zoom LOD Edge Label: show when zoomed in (k >= 1.08), alwaysShowLabels, or highlighted!
      const showLabel =
        (hasHighlight && isHighlightedLink) ||
        alwaysShowLabels ||
        (k >= 1.08 && isHighlightedLink);

      if (showLabel) {
        ctx.save();
        ctx.globalAlpha = isHighlightedLink ? 0.98 : 0.55;
        const labelT = 0.36 + (linkIdx % 3) * 0.14;
        const oneMinusT = 1 - labelT;
        const midX = oneMinusT * oneMinusT * s.x + 2 * oneMinusT * labelT * cx + labelT * labelT * t.x;
        const midY = oneMinusT * oneMinusT * s.y + 2 * oneMinusT * labelT * cy + labelT * labelT * t.y;
        const labelTxt = link.priorLabel ? `✦ ${link.label}` : link.label;
        ctx.font = '600 10.5px "Noto Sans SC", "PingFang SC", sans-serif';
        const tw = ctx.measureText(labelTxt).width;
        const pw = tw + 12;
        const ph = 18;
        ctx.fillStyle = 'rgba(8, 13, 27, 0.92)';
        ctx.beginPath();
        ctx.roundRect(midX - pw / 2, midY - ph / 2, pw, ph, 5);
        ctx.fill();
        ctx.strokeStyle = `${catMeta.color}99`;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#e2e8f0';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(labelTxt, midX, midY + 0.5);
        ctx.restore();
      }

      ctx.restore();
    });

    // 3. Draw Nodes with Semantic Zoom LOD
    for (const node of activeNodes) {
      if (node.x === undefined || node.y === undefined) continue;
      const r = getNodeRadius(node);
      const meta = getEntityTypeMeta(node.entityType);
      const isHighlighted = !hasHighlight || highlightedNodeIds.has(node.id);
      const isPrimary = node.id === selectedNodeId || node.id === hoveredNodeId;

      // Macro LOD: when zoomed way out (k < 0.55) and nothing highlighted, softly shrink minor characters
      const isMacroMinor =
        k < 0.55 && !hasHighlight && node.entityType === 'character' && node.degree < 3;

      ctx.save();
      ctx.globalAlpha = isHighlighted ? (isMacroMinor ? 0.55 : 1) : 0.14;

      if (isPrimary) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 8, 0, Math.PI * 2);
        ctx.fillStyle = `${meta.color}33`;
        ctx.fill();
      }

      // Interior clipped avatar / monogram
      ctx.save();
      drawNodeShapePath(ctx, node.entityType, node.x, node.y, r);
      ctx.clip();
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(node.x - r - 2, node.y - r - 2, (r + 2) * 2, (r + 2) * 2);

      const img = requestAvatarImage(node.avatarUrl, requestRepaint);
      if (img) {
        const sc = Math.max((r * 2) / img.width, (r * 2) / img.height);
        ctx.drawImage(
          img,
          node.x - (img.width * sc) / 2,
          node.y - (img.height * sc) / 2,
          img.width * sc,
          img.height * sc
        );
      } else {
        const short = node.name.replace(/[《》()（）·\s]/g, '').slice(0, node.entityType === 'character' ? 1 : 2);
        ctx.fillStyle = '#f8fafc';
        ctx.font = `700 ${Math.round(r * 0.72)}px "Noto Sans SC", "PingFang SC", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(short, node.x, node.y + 1);
      }
      ctx.restore();

      // Border frame
      drawNodeShapePath(ctx, node.entityType, node.x, node.y, r);
      ctx.strokeStyle = isPrimary ? '#ffffff' : meta.color;
      ctx.lineWidth = isPrimary ? 3 : 2.2;
      ctx.stroke();

      // Collapsed group badge (+)
      if (collapsedGroupIds.has(node.id)) {
        ctx.beginPath();
        ctx.arc(node.x + r * 0.75, node.y - r * 0.75, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#0284c7';
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '700 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('+', node.x + r * 0.75, node.y - r * 0.75 + 0.5);
      } else if (node.hasEvolution) {
        ctx.beginPath();
        ctx.arc(node.x + r * 0.72, node.y - r * 0.72, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#0f172a';
        ctx.fill();
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.fillStyle = '#fbbf24';
        ctx.font = '700 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('✦', node.x + r * 0.72, node.y - r * 0.72 + 0.5);
      }

      // Nameplate LOD: Nations & Orgs always show names; Characters show when k >= 0.58 or highlighted
      const showNodeName =
        node.entityType !== 'character' || k >= 0.58 || (hasHighlight && isHighlighted);

      if (showNodeName) {
        const fontSz = node.entityType === 'nation' ? 12.5 : node.entityType === 'organization' ? 11.5 : 10.5;
        ctx.font = `600 ${fontSz}px "Noto Sans SC", "PingFang SC", sans-serif`;
        const tw = ctx.measureText(node.name).width;
        const pw = tw + 12;
        const ph = 18;
        const py = node.y + r + 5;

        ctx.fillStyle = 'rgba(7, 12, 25, 0.88)';
        ctx.beginPath();
        ctx.roundRect(node.x - pw / 2, py, pw, ph, 5);
        ctx.fill();
        ctx.strokeStyle = `${meta.color}66`;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(node.name, node.x, py + ph / 2 + 0.5);
      }

      ctx.restore();
    }

    ctx.restore();
  }, [
    selectedNodeId,
    hoveredNodeId,
    highlightedNodeIds,
    highlightedLinkIds,
    egoFocusMode,
    alwaysShowLabels,
    collapsedGroupIds,
    requestRepaint,
  ]);

  renderTickRef.current = drawFrame;

  // Only rebuild/re-pin layout on selectedNodeId change when egoFocusMode is active!
  const activeEgoCenterId = egoFocusMode ? selectedNodeId : null;

  // Build / update d3-force simulation or Ego-Ring radial layout
  useEffect(() => {
    const prevPositions = new Map(
      simNodesRef.current.map((n) => [n.id, { x: n.x, y: n.y }])
    );

    const clonedNodes: ResolvedNode[] = nodes.map((n, i) => {
      const prev = prevPositions.get(n.id);
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      return {
        ...n,
        x: prev?.x ?? Math.cos(angle) * 180,
        y: prev?.y ?? Math.sin(angle) * 180,
        fx: undefined,
        fy: undefined,
      };
    });

    const clonedLinks: ResolvedLink[] = links.map((l) => ({
      ...l,
      source: l.sourceId,
      target: l.targetId,
    }));

    simNodesRef.current = clonedNodes;
    simLinksRef.current = clonedLinks;

    simRef.current?.stop();

    // Ego-Centric Ring Mode around activeEgoCenterId
    if (egoFocusMode && activeEgoCenterId && clonedNodes.some((n) => n.id === activeEgoCenterId)) {
      const adj = new Map<string, Set<string>>();
      for (const l of clonedLinks) {
        if (!adj.has(l.sourceId)) adj.set(l.sourceId, new Set());
        if (!adj.has(l.targetId)) adj.set(l.targetId, new Set());
        adj.get(l.sourceId)!.add(l.targetId);
        adj.get(l.targetId)!.add(l.sourceId);
      }

      const ring1Ids = [...(adj.get(activeEgoCenterId) ?? [])];
      const ring1Set = new Set(ring1Ids);
      const ring2Set = new Set<string>();
      for (const r1 of ring1Ids) {
        for (const r2 of adj.get(r1) ?? []) {
          if (r2 !== activeEgoCenterId && !ring1Set.has(r2)) ring2Set.add(r2);
        }
      }
      const ring2Ids = [...ring2Set];
      const outerIds = clonedNodes
        .map((n) => n.id)
        .filter((id) => id !== activeEgoCenterId && !ring1Set.has(id) && !ring2Set.has(id));

      for (const n of clonedNodes) {
        if (n.id === activeEgoCenterId) {
          n.fx = 0;
          n.fy = 0;
          n.x = 0;
          n.y = 0;
        } else if (ring1Set.has(n.id)) {
          const idx = ring1Ids.indexOf(n.id);
          const a = (idx / Math.max(1, ring1Ids.length)) * Math.PI * 2 - Math.PI / 2;
          n.fx = Math.cos(a) * 190;
          n.fy = Math.sin(a) * 190;
          n.x = n.fx;
          n.y = n.fy;
        } else if (ring2Set.has(n.id)) {
          const idx = ring2Ids.indexOf(n.id);
          const a = (idx / Math.max(1, ring2Ids.length)) * Math.PI * 2 - Math.PI / 2;
          n.fx = Math.cos(a) * 365;
          n.fy = Math.sin(a) * 365;
          n.x = n.fx;
          n.y = n.fy;
        } else {
          const idx = outerIds.indexOf(n.id);
          const a = (idx / Math.max(1, outerIds.length)) * Math.PI * 2;
          n.fx = Math.cos(a) * 510;
          n.fy = Math.sin(a) * 510;
          n.x = n.fx;
          n.y = n.fy;
        }
      }

      transformRef.current = { x: 0, y: 0, k: 0.95 };
      renderTickRef.current();
      return;
    }

    const distinctNations = new Set(
      clonedNodes.map((n) => n.nationId || (n.entityType === 'nation' ? n.id : undefined)).filter(Boolean)
    );
    const multiNation = distinctNations.size > 1;
    const nodeMap = new Map(clonedNodes.map((n) => [n.id, n]));

    const sim = forceSimulation<ResolvedNode>(clonedNodes)
      .force(
        'link',
        forceLink<ResolvedNode, ResolvedLink>(clonedLinks)
          .id((d) => d.id)
          .distance((l) => (l.category === 'membership' ? 120 : 175))
          .strength((l) => (l.category === 'membership' ? 0.6 : 0.28))
      )
      .force('charge', forceManyBody<ResolvedNode>().strength((d) => (d.entityType === 'nation' ? -820 : -460)))
      .force('collide', forceCollide<ResolvedNode>((d) => getNodeRadius(d) + 32))
      .force('cluster2d', (alpha) => {
        for (const n of clonedNodes) {
          let tx = 0;
          let ty = 0;
          const nationKey = n.entityType === 'nation' ? n.id : n.nationId;
          if (multiNation && nationKey && NATION_CENTERS_2D[nationKey]) {
            [tx, ty] = NATION_CENTERS_2D[nationKey];
          }
          // Pull characters gently toward their primary organization
          if (n.entityType === 'character' && n.primaryGroupId) {
            const grp = nodeMap.get(n.primaryGroupId);
            if (grp && grp.x !== undefined && grp.y !== undefined) {
              tx = tx * 0.35 + grp.x * 0.65;
              ty = ty * 0.35 + grp.y * 0.65;
            }
          }
          const k = 0.08 * alpha;
          n.vx = (n.vx ?? 0) + (tx - (n.x ?? 0)) * k;
          n.vy = (n.vy ?? 0) + (ty - (n.y ?? 0)) * k;
        }
      })
      .on('tick', () => {
        renderTickRef.current();
      });

    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, [nodes, links, egoFocusMode, activeEgoCenterId]);

  // Repaint on visual highlight/prop change
  useEffect(() => {
    drawFrame();
  }, [drawFrame]);

  // Resize observer & native non-passive wheel listener
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => renderTickRef.current());
    ro.observe(canvas);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;

      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const prevK = transformRef.current.k;
      const nextK = Math.max(0.32, Math.min(2.6, prevK * factor));

      transformRef.current.x = mx - ((mx - transformRef.current.x) / prevK) * nextK;
      transformRef.current.y = my - ((my - transformRef.current.y) / prevK) * nextK;
      transformRef.current.k = nextK;

      setZoomTier(nextK < 0.58 ? 'macro' : nextK >= 1.08 ? 'detail' : 'mid');
      renderTickRef.current();
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  const screenToWorld = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const { x, y, k } = transformRef.current;
    return {
      wx: (sx - rect.width / 2 - x) / k,
      wy: (sy - rect.height / 2 - y) / k,
    };
  };

  const hitTestNode = (wx: number, wy: number): ResolvedNode | null => {
    const arr = simNodesRef.current;
    for (let i = arr.length - 1; i >= 0; i--) {
      const n = arr[i];
      if (n.x === undefined || n.y === undefined) continue;
      const r = getNodeRadius(n) + 5;
      if (Math.hypot(wx - n.x, wy - n.y) <= r) return n;
    }
    return null;
  };

  const hitTestLink = (wx: number, wy: number): ResolvedLink | null => {
    const k = transformRef.current.k;
    const thresholdWorld = 8 / k;
    const nodeById = new Map(simNodesRef.current.map((n) => [n.id, n]));
    const hasHighlight = highlightedNodeIds.size > 0;

    let bestLink: ResolvedLink | null = null;
    let bestDist = thresholdWorld;

    for (const link of simLinksRef.current) {
      const s = nodeById.get(link.sourceId);
      const t = nodeById.get(link.targetId);
      if (!s || !t || s.x === undefined || s.y === undefined || t.x === undefined || t.y === undefined) {
        continue;
      }
      if (k < 0.52 && !hasHighlight && s.entityType === 'character' && t.entityType === 'character' && link.weight < 4) {
        continue;
      }

      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = -dy / dist;
      const ny = dx / dist;
      const offset = link.curvature * Math.min(dist * 0.55, 160);
      const cx = (s.x + t.x) / 2 + nx * offset;
      const cy = (s.y + t.y) / 2 + ny * offset;

      // Quick bounding box pre-reject
      const minX = Math.min(s.x, cx, t.x) - thresholdWorld;
      const maxX = Math.max(s.x, cx, t.x) + thresholdWorld;
      const minY = Math.min(s.y, cy, t.y) - thresholdWorld;
      const maxY = Math.max(s.y, cy, t.y) + thresholdWorld;
      if (wx < minX || wx > maxX || wy < minY || wy > maxY) continue;

      const d = distToQuadraticBezier(wx, wy, s.x, s.y, cx, cy, t.x, t.y);
      if (d <= bestDist) {
        bestDist = d;
        bestLink = link;
      }
    }
    return bestLink;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore if synthetic event without active pointerId
    }
    const { wx, wy } = screenToWorld(e.clientX, e.clientY);
    const hit = hitTestNode(wx, wy);
    if (hit && hit.x !== undefined && hit.y !== undefined) {
      dragStateRef.current = {
        type: 'node',
        node: hit,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origX: hit.x,
        origY: hit.y,
        moved: false,
      };
      hit.fx = hit.x;
      hit.fy = hit.y;
      simRef.current?.alphaTarget(0.2).restart();
    } else {
      dragStateRef.current = {
        type: 'pan',
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origX: transformRef.current.x,
        origY: transformRef.current.y,
        moved: false,
      };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const st = dragStateRef.current;
    if (st.type === 'node' && st.node) {
      const dx = (e.clientX - st.startX) / transformRef.current.k;
      const dy = (e.clientY - st.startY) / transformRef.current.k;
      if (Math.hypot(e.clientX - st.startX, e.clientY - st.startY) > 4) st.moved = true;
      st.node.fx = st.origX + dx;
      st.node.fy = st.origY + dy;
      st.node.x = st.node.fx;
      st.node.y = st.node.fy;
      drawFrame();
      return;
    }
    if (st.type === 'pan') {
      const dx = e.clientX - st.startX;
      const dy = e.clientY - st.startY;
      if (Math.hypot(dx, dy) > 4) st.moved = true;
      transformRef.current.x = st.origX + dx;
      transformRef.current.y = st.origY + dy;
      drawFrame();
      return;
    }

    const { wx, wy } = screenToWorld(e.clientX, e.clientY);
    const hit = hitTestNode(wx, wy);
    const hitEdge = hit ? null : hitTestLink(wx, wy);
    if (canvasRef.current) {
      canvasRef.current.style.cursor = hit || hitEdge ? 'pointer' : 'grab';
    }
    onHoverNode(hit ? hit.id : null);
  };

  const releaseDragCapture = (target: HTMLCanvasElement, pointerId: number) => {
    try {
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore release errors
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    releaseDragCapture(e.currentTarget, e.pointerId);
    const st = dragStateRef.current;
    if (st.type === 'node' && st.node) {
      if (!egoFocusMode) {
        st.node.fx = undefined;
        st.node.fy = undefined;
      }
      simRef.current?.alphaTarget(0);
      if (!st.moved) {
        onSelectNode(st.node.id);
      }
    } else if (st.type === 'pan' && !st.moved) {
      const { wx, wy } = screenToWorld(e.clientX, e.clientY);
      const hitEdge = hitTestLink(wx, wy);
      if (hitEdge) {
        onSelectLink(hitEdge);
      } else {
        onSelectNode(null);
        onSelectLink(null);
      }
    }
    dragStateRef.current = { type: null, startX: 0, startY: 0, origX: 0, origY: 0, moved: false };
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    releaseDragCapture(e.currentTarget, e.pointerId);
    const st = dragStateRef.current;
    if (st.type === 'node' && st.node) {
      if (!egoFocusMode) {
        st.node.fx = undefined;
        st.node.fy = undefined;
      }
      simRef.current?.alphaTarget(0);
    }
    dragStateRef.current = { type: null, startX: 0, startY: 0, origX: 0, origY: 0, moved: false };
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { wx, wy } = screenToWorld(e.clientX, e.clientY);
    const hit = hitTestNode(wx, wy);
    if (hit && hit.entityType === 'organization') {
      onToggleCollapseGroup(hit.id);
    }
  };

  const adjustZoom = (deltaFactor: number) => {
    const nextK = Math.max(0.32, Math.min(2.6, transformRef.current.k * deltaFactor));
    transformRef.current.k = nextK;
    setZoomTier(nextK < 0.58 ? 'macro' : nextK >= 1.08 ? 'detail' : 'mid');
    drawFrame();
  };

  return (
    <div className="graph-canvas-host">
      <canvas
        ref={canvasRef}
        className="graph-2d-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onDoubleClick={handleDoubleClick}
      />
      <div className="lod-hud-badge">
        <span className="lod-dot" />
        <span>
          {egoFocusMode
            ? '2D 中心同心环聚焦 (1-Hop / 2-Hop)'
            : zoomTier === 'macro'
              ? 'LOD 1 · 宏观国家与势力疆域层'
              : zoomTier === 'detail'
                ? 'LOD 3 · 全量并行关系细节层'
                : 'LOD 2 · 势力集群与角色层（滚轮放大自动展开关系词）'}
        </span>
        <div className="zoom-mini-btns">
          <button type="button" onClick={() => adjustZoom(1.22)} title="放大">
            +
          </button>
          <button type="button" onClick={() => adjustZoom(0.82)} title="缩小">
            −
          </button>
          <button
            type="button"
            onClick={() => {
              transformRef.current = { x: 0, y: 0, k: 0.92 };
              setZoomTier('mid');
              drawFrame();
            }}
            title="重置视角"
          >
            重置
          </button>
        </div>
      </div>
    </div>
  );
};
