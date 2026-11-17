import React, { useEffect, useRef, useState } from 'react';
import ForceGraph3D, { ForceGraph3DInstance } from '3d-force-graph';
import * as THREE from 'three';
import {
  getRelationCategoryMeta,
  ResolvedLink,
  ResolvedNode,
} from '../types/graph';
import { createNodeThreeSprite } from '../engine/spriteRenderer';

interface Graph3DViewProps {
  nodes: ResolvedNode[];
  links: ResolvedLink[];
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  highlightedNodeIds: Set<string>;
  highlightedLinkIds: Set<string>;
  alwaysShowLabels: boolean;
  onSelectNode: (nodeId: string | null) => void;
  onHoverNode: (nodeId: string | null) => void;
  onSelectLink: (link: ResolvedLink | null) => void;
}

type LiveGraphLink = ResolvedLink & {
  __curve?: THREE.Curve<THREE.Vector3> | null;
};

type HostElementWithDebug = HTMLDivElement & {
  __krGraph3d?: ForceGraph3DInstance;
};

const NATION_SECTORS_3D: Record<string, [number, number, number]> = {
  calvard: [195, 18, 0],
  erebonia: [-205, 25, 45],
  crossbell: [-15, 28, 85],
  liberl: [-105, -155, -70],
  elsaim: [235, -130, 115],
  ored: [120, 130, -85],
  arteria: [20, 175, -110],
  remiferia: [-75, 165, 95],
  northambria: [-190, 145, -75],
};

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return hex;
}

function drawPillRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function createEdgeLabelSprite(label: string, color: string, hasPrior: boolean): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const display = hasPrior ? `✦ ${label}` : label;
  const fontSpec =
    '600 22px "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.font = fontSpec;
  const textW = ctx.measureText(display).width;
  const W = Math.ceil(textW + 34);
  const H = 42;
  const dpr = 2;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  ctx.font = fontSpec;
  ctx.fillStyle = 'rgba(8, 13, 27, 0.92)';
  drawPillRect(ctx, 2, 2, W - 4, H - 4, 11);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.stroke();

  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(display, W / 2, H / 2 + 1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 30;
  sprite.userData.isEdgeLabel = true;
  sprite.userData.edgeLabel = display;
  sprite.userData.dispose = () => {
    tex.dispose();
    mat.dispose();
  };
  sprite.scale.set(W * 0.155, H * 0.155, 1);
  return sprite;
}

function getLinkLabelTPos(linkId: string): number {
  if (!linkId) return 0.5;
  return 0.38 + (Math.abs(linkId.charCodeAt(linkId.length - 1)) % 3) * 0.12;
}

function syncLinkGroupPosition(
  group: THREE.Group,
  link: LiveGraphLink,
  coords?: {
    start: { x: number; y: number; z: number };
    end: { x: number; y: number; z: number };
  }
) {
  const tPos = getLinkLabelTPos(link.id);
  if (link.__curve && typeof link.__curve.getPoint === 'function') {
    const pt = link.__curve.getPoint(tPos);
    if (Number.isFinite(pt.x) && Number.isFinite(pt.y) && Number.isFinite(pt.z)) {
      group.position.set(pt.x, pt.y, pt.z);
      return;
    }
  }
  if (coords) {
    const sx = coords.start.x || 0;
    const sy = coords.start.y || 0;
    const sz = coords.start.z || 0;
    const ex = coords.end.x || 0;
    const ey = coords.end.y || 0;
    const ez = coords.end.z || 0;
    group.position.set(
      sx + (ex - sx) * tPos,
      sy + (ey - sy) * tPos,
      sz + (ez - sz) * tPos
    );
    return;
  }
  if (
    typeof link.source === 'object' &&
    link.source !== null &&
    typeof link.target === 'object' &&
    link.target !== null
  ) {
    const sx = link.source.x;
    const sy = link.source.y;
    const sz = link.source.z;
    const ex = link.target.x;
    const ey = link.target.y;
    const ez = link.target.z;
    if (typeof sx === 'number' && typeof ex === 'number') {
      group.position.set(
        sx + (ex - sx) * tPos,
        (sy ?? 0) + ((ey ?? 0) - (sy ?? 0)) * tPos,
        (sz ?? 0) + ((ez ?? 0) - (sz ?? 0)) * tPos
      );
    }
  }
}

function disposeThreeSprite(sprite: THREE.Sprite | undefined | null) {
  if (!sprite) return;
  if (typeof sprite.userData?.dispose === 'function') {
    sprite.userData.dispose();
    return;
  }
  const mat = sprite.material as THREE.SpriteMaterial | undefined;
  if (mat) {
    mat.map?.dispose();
    mat.dispose();
  }
}

function disposeSpriteMap(map: Map<string, THREE.Sprite>) {
  for (const sprite of map.values()) {
    disposeThreeSprite(sprite);
  }
  map.clear();
}

export const Graph3DView: React.FC<Graph3DViewProps> = ({
  nodes,
  links,
  selectedNodeId,
  hoveredNodeId,
  highlightedNodeIds,
  highlightedLinkIds,
  alwaysShowLabels,
  onSelectNode,
  onHoverNode,
  onSelectLink,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);
  const spriteMapRef = useRef<Map<string, THREE.Sprite>>(new Map());
  const labelSpriteMapRef = useRef<Map<string, THREE.Sprite>>(new Map());
  const labelHolderMapRef = useRef<Map<string, { group: THREE.Group; link: LiveGraphLink }>>(
    new Map()
  );

  const [hoveredLinkId, setHoveredLinkId] = useState<string | null>(null);
  const hoveredLinkIdRef = useRef<string | null>(null);
  const hoveredNodeLocalRef = useRef<string | null>(hoveredNodeId);
  hoveredNodeLocalRef.current = hoveredNodeId;

  const isPointerInsideCanvasRef = useRef<boolean>(false);
  const suppressAutoHoverRef = useRef<boolean>(false);

  const selectedNodeIdRef = useRef<string | null>(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;

  const callbacksRef = useRef({ onSelectNode, onHoverNode, onSelectLink });
  callbacksRef.current = { onSelectNode, onHoverNode, onSelectLink };

  const liveVisRef = useRef({
    alwaysShowLabels,
    selectedNodeId,
    hoveredNodeId,
    hoveredLinkId,
    highlightedNodeIds,
    highlightedLinkIds,
    hasActiveFilter: highlightedNodeIds.size > 0,
  });
  liveVisRef.current = {
    alwaysShowLabels,
    selectedNodeId,
    hoveredNodeId,
    hoveredLinkId,
    highlightedNodeIds,
    highlightedLinkIds,
    hasActiveFilter: highlightedNodeIds.size > 0,
  };

  const ensureLinkLabelSprite = (link: ResolvedLink, group: THREE.Group): THREE.Sprite => {
    let sprite = labelSpriteMapRef.current.get(link.id);
    if (!sprite) {
      const color = getRelationCategoryMeta(link.category).color;
      sprite = createEdgeLabelSprite(link.label, color, Boolean(link.priorLabel));
      labelSpriteMapRef.current.set(link.id, sprite);
    }
    if (sprite.parent !== group) {
      group.add(sprite);
    }
    return sprite;
  };

  const applyNodeSpriteHighlight = (id: string, sprite: THREE.Sprite) => {
    const {
      highlightedNodeIds: hlNodes,
      selectedNodeId: selId,
      hoveredNodeId: hovNodeId,
      hasActiveFilter,
    } = liveVisRef.current;
    const isHighlighted = !hasActiveFilter || hlNodes.has(id);
    const isPrimary = id === selId || id === hovNodeId;
    sprite.material.opacity = isHighlighted ? 1 : 0.14;
    const baseScale =
      sprite.userData.baseScale ??
      (() => {
        sprite.userData.baseScale = sprite.scale.x;
        return sprite.scale.x;
      })();
    const factor = isPrimary ? 1.18 : isHighlighted && hasActiveFilter ? 1.05 : 1.0;
    sprite.scale.set(baseScale * factor, baseScale * (340 / 320) * factor, 1);
  };

  const syncSingleLinkLabel = (
    linkId: string,
    group: THREE.Group,
    link: LiveGraphLink,
    coords?: {
      start: { x: number; y: number; z: number };
      end: { x: number; y: number; z: number };
    }
  ) => {
    syncLinkGroupPosition(group, link, coords);

    const {
      alwaysShowLabels: showAll,
      highlightedLinkIds: hlSet,
      hoveredLinkId: hovLinkId,
      hasActiveFilter,
    } = liveVisRef.current;
    const isHl = hlSet.has(linkId);
    const isHoveredLink = hovLinkId === linkId;
    const shouldShow = showAll || isHoveredLink || (hasActiveFilter && isHl);

    if (shouldShow) {
      const labelSprite = ensureLinkLabelSprite(link, group);
      labelSprite.visible = true;
      labelSprite.material.opacity = !hasActiveFilter || isHl || isHoveredLink ? 0.98 : 0.68;
    } else {
      const existing = labelSpriteMapRef.current.get(linkId);
      if (existing) {
        existing.visible = false;
      }
    }
  };

  const syncAllVisualsRef = useRef<() => void>(() => {});
  syncAllVisualsRef.current = () => {
    for (const [id, sprite] of spriteMapRef.current.entries()) {
      applyNodeSpriteHighlight(id, sprite);
    }
    for (const [linkId, { group, link }] of labelHolderMapRef.current.entries()) {
      syncSingleLinkLabel(linkId, group, link);
    }
  };

  // Initialize 3d-force-graph instance once
  useEffect(() => {
    const el = containerRef.current as HostElementWithDebug | null;
    if (!el) return;

    const resolveLinkColor = (l: object) => {
      const link = l as ResolvedLink;
      const baseHex = getRelationCategoryMeta(link.category).color;
      const {
        highlightedLinkIds: hlSet,
        hoveredLinkId: hovLinkId,
        hasActiveFilter,
      } = liveVisRef.current;
      if (link.id === hovLinkId) return hexToRgba(baseHex, 1);
      if (hasActiveFilter) {
        return hexToRgba(baseHex, hlSet.has(link.id) ? 1 : 0.16);
      }
      return hexToRgba(baseHex, 0.7);
    };

    const fg = new ForceGraph3D(el, { controlType: 'orbit' })
      .backgroundColor('#060913')
      .showNavInfo(false)
      .linkHoverPrecision(4)
      .nodeRelSize(6)
      .nodeThreeObject((obj: object) => {
        const node = obj as ResolvedNode;
        const existing = spriteMapRef.current.get(node.id);
        if (existing) {
          disposeThreeSprite(existing);
        }
        const sprite = createNodeThreeSprite(node);
        spriteMapRef.current.set(node.id, sprite);
        applyNodeSpriteHighlight(node.id, sprite);
        return sprite;
      })
      .linkCurvature((l: object) => Math.abs((l as ResolvedLink).curvature))
      .linkCurveRotation((l: object) => (l as ResolvedLink).curveRotation)
      .linkColor(resolveLinkColor)
      .linkWidth((l: object) => {
        const link = l as ResolvedLink;
        const {
          highlightedLinkIds: hlSet,
          hoveredLinkId: hovLinkId,
          hasActiveFilter,
        } = liveVisRef.current;
        if (link.id === hovLinkId) return 2.6;
        if (hasActiveFilter) {
          return hlSet.has(link.id) ? 2.4 : 0.65;
        }
        return link.weight >= 4 ? 1.35 : 1.0;
      })
      .linkOpacity(0.85)
      .linkDirectionalArrowLength((l: object) =>
        (l as ResolvedLink).direction === 'directed' ? 4.2 : 0
      )
      .linkDirectionalArrowRelPos(0.88)
      .linkDirectionalParticleWidth(2.4)
      .linkDirectionalParticleSpeed(0.006)
      .linkThreeObjectExtend(true)
      .linkThreeObject((l: object) => {
        const link = l as LiveGraphLink;
        const staleSprite = labelSpriteMapRef.current.get(link.id);
        if (staleSprite) {
          disposeThreeSprite(staleSprite);
          labelSpriteMapRef.current.delete(link.id);
        }
        const group = new THREE.Group();
        // Keep groupOrder >= 30 (above three-forcegraph's parent link Group renderOrder = 10)
        // so Three.js projectObject sorts edge label sprites strictly above 3D cylinder tubes.
        group.renderOrder = 30;
        labelHolderMapRef.current.set(link.id, { group, link });
        syncSingleLinkLabel(link.id, group, link);
        return group;
      })
      .linkPositionUpdate(
        (
          holderObj: object,
          coords: {
            start: { x: number; y: number; z: number };
            end: { x: number; y: number; z: number };
          },
          l: object
        ) => {
          const group = holderObj as THREE.Group;
          const link = l as LiveGraphLink;
          labelHolderMapRef.current.set(link.id, { group, link });
          syncSingleLinkLabel(link.id, group, link, coords);
          return false;
        }
      )
      .onEngineStop(() => {
        syncAllVisualsRef.current();
      })
      .onNodeHover((node: object | null) => {
        if (!isPointerInsideCanvasRef.current || suppressAutoHoverRef.current) {
          return;
        }
        const nextNodeId = node ? (node as ResolvedNode).id : null;
        hoveredNodeLocalRef.current = nextNodeId;
        el.style.cursor = nextNodeId || hoveredLinkIdRef.current ? 'pointer' : 'grab';
        callbacksRef.current.onHoverNode(nextNodeId);
      })
      .onLinkHover((link: object | null) => {
        if (!isPointerInsideCanvasRef.current || suppressAutoHoverRef.current) {
          return;
        }
        const nextLinkId = link ? (link as ResolvedLink).id : null;
        if (hoveredLinkIdRef.current !== nextLinkId) {
          hoveredLinkIdRef.current = nextLinkId;
          setHoveredLinkId(nextLinkId);
        }
        el.style.cursor = nextLinkId || hoveredNodeLocalRef.current ? 'pointer' : 'grab';
      })
      .onNodeClick((node: object) => {
        const n = node as ResolvedNode;
        hoveredNodeLocalRef.current = null;
        callbacksRef.current.onHoverNode(null);
        callbacksRef.current.onSelectNode(n.id);
      })
      .onLinkClick((link: object) => {
        callbacksRef.current.onSelectLink(link as ResolvedLink);
      })
      .onBackgroundClick(() => {
        callbacksRef.current.onSelectNode(null);
        callbacksRef.current.onSelectLink(null);
      });

    const handlePointerEnter = () => {
      isPointerInsideCanvasRef.current = true;
    };
    const handlePointerMove = () => {
      isPointerInsideCanvasRef.current = true;
      suppressAutoHoverRef.current = false;
    };
    const handlePointerLeave = () => {
      isPointerInsideCanvasRef.current = false;
      el.style.cursor = 'grab';
      if (hoveredNodeLocalRef.current !== null) {
        hoveredNodeLocalRef.current = null;
        callbacksRef.current.onHoverNode(null);
      }
      if (hoveredLinkIdRef.current !== null) {
        hoveredLinkIdRef.current = null;
        setHoveredLinkId(null);
      }
    };
    el.addEventListener('pointerenter', handlePointerEnter, { passive: true });
    el.addEventListener('pointermove', handlePointerMove, { passive: true });
    el.addEventListener('pointerleave', handlePointerLeave, { passive: true });

    // Add subtle ambient starfield particles in 3D space for depth cues
    const scene = fg.scene();
    const starGeo = new THREE.BufferGeometry();
    const starCount = 420;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 1400;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 1400;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 1400;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0x38bdf8,
      size: 2.2,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    });
    const starPoints = new THREE.Points(starGeo, starMat);
    scene.add(starPoints);

    fg.d3Force('charge')?.strength(-260);
    fg.d3Force('link')?.distance((l: ResolvedLink) => {
      if (l.category === 'membership') return 62;
      if (l.category === 'hierarchy') return 85;
      return 96;
    });

    graphRef.current = fg;
    el.__krGraph3d = fg;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          fg.width(width);
          fg.height(height);
        }
      }
    });
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      el.removeEventListener('pointerenter', handlePointerEnter);
      el.removeEventListener('pointermove', handlePointerMove);
      el.removeEventListener('pointerleave', handlePointerLeave);
      delete el.__krGraph3d;
      disposeSpriteMap(spriteMapRef.current);
      disposeSpriteMap(labelSpriteMapRef.current);
      labelHolderMapRef.current.clear();
      scene.remove(starPoints);
      starGeo.dispose();
      starMat.dispose();
      const renderer = fg.renderer?.();
      fg._destructor();
      if (renderer) {
        renderer.dispose();
        renderer.forceContextLoss?.();
      }
      graphRef.current = null;
    };
  }, []);

  // Update graph data & custom 3D Nation/Sector clustering force when nodes/links change
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg) return;

    hoveredLinkIdRef.current = null;
    setHoveredLinkId(null);

    disposeSpriteMap(spriteMapRef.current);
    disposeSpriteMap(labelSpriteMapRef.current);
    labelHolderMapRef.current.clear();

    const clonedNodes = nodes.map((n) => ({ ...n }));
    const clonedLinks = links.map((l) => ({
      ...l,
      source: l.sourceId,
      target: l.targetId,
    }));

    // Custom 3D sector clustering force so Nations & Factions form readable spatial galaxies
    const distinctNations = new Set(
      clonedNodes
        .map((n) => n.nationId || (n.entityType === 'nation' ? n.id : undefined))
        .filter(Boolean)
    );
    const multiNation = distinctNations.size > 1;

    fg.d3Force('sector3d', (alpha: number) => {
      for (const n of clonedNodes) {
        const sectorKey = n.entityType === 'nation' ? n.id : n.nationId;
        let targetPos: [number, number, number] = [0, 0, 0];
        if (multiNation && sectorKey && NATION_SECTORS_3D[sectorKey]) {
          targetPos = NATION_SECTORS_3D[sectorKey];
        } else if (n.entityType === 'nation') {
          targetPos = [0, 40, 0];
        }
        const k = (multiNation ? 0.085 : 0.03) * alpha;
        n.vx = (n.vx ?? 0) + (targetPos[0] - (n.x ?? 0)) * k;
        n.vy = (n.vy ?? 0) + (targetPos[1] - (n.y ?? 0)) * k;
        n.vz = (n.vz ?? 0) + (targetPos[2] - (n.z ?? 0)) * k;
      }
    });

    fg.graphData({ nodes: clonedNodes, links: clonedLinks });

    // Sync edge labels & node highlights once three-forcegraph finishes its debounced digest + first tick
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      syncAllVisualsRef.current();
      raf2 = window.requestAnimationFrame(() => {
        syncAllVisualsRef.current();
      });
    });
    const syncTimer = window.setTimeout(() => {
      syncAllVisualsRef.current();
    }, 60);

    // Frame graph nicely after brief layout settle when no specific node is focused
    const cameraTimer = window.setTimeout(() => {
      if (graphRef.current && !selectedNodeIdRef.current) {
        graphRef.current.cameraPosition(
          { x: 0, y: 35, z: multiNation ? 460 : 340 },
          { x: 0, y: 0, z: 0 },
          700
        );
      }
    }, 120);

    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
      window.clearTimeout(syncTimer);
      window.clearTimeout(cameraTimer);
    };
  }, [nodes, links]);

  // Smoothly fly camera when user selects a node (with settle retry on cross-arc switches)
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg || !selectedNodeId) return;

    let retryTimer: number | undefined;
    const attemptFly = (attempt: number) => {
      const inst = graphRef.current;
      if (!inst) return;
      const gData = inst.graphData();
      const target = (gData.nodes as ResolvedNode[]).find((n) => n.id === selectedNodeId);
      if (!target) return;

      const tx = target.x;
      const ty = target.y;
      const tz = target.z;
      const isUnsettled =
        tx === undefined ||
        ty === undefined ||
        tz === undefined ||
        (Math.hypot(tx, ty, tz) < 2 && gData.nodes.length > 1);

      if (isUnsettled && attempt < 3) {
        retryTimer = window.setTimeout(() => attemptFly(attempt + 1), 260);
        return;
      }

      const fx = tx ?? 0;
      const fy = ty ?? 0;
      const fz = tz ?? 0;
      const dist = gData.nodes.length <= 32 ? 155 : 235;
      const mag = Math.hypot(fx, fy, fz) || 1;
      const ratio = 1 + dist / mag;
      const newPos =
        mag < 25
          ? { x: fx, y: fy + 26, z: fz + dist }
          : { x: fx * ratio, y: fy * ratio + 24, z: fz * ratio };

      suppressAutoHoverRef.current = true;
      inst.cameraPosition(newPos, { x: fx, y: fy, z: fz }, 750);
    };

    attemptFly(0);
    return () => {
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [selectedNodeId, nodes]);

  // Update highlight opacities, particles & lazy LOD edge labels reactively
  // NOTE: Never call fg.linkWidth(...) here — three-forcegraph clears linkDataMapper on linkWidth prop changes!
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg) return;

    const hasActiveFilter = highlightedNodeIds.size > 0;

    syncAllVisualsRef.current();
    const raf = window.requestAnimationFrame(() => {
      syncAllVisualsRef.current();
    });

    fg.linkColor((l: object) => {
      const link = l as ResolvedLink;
      const baseHex = getRelationCategoryMeta(link.category).color;
      if (link.id === hoveredLinkId) return hexToRgba(baseHex, 1);
      if (hasActiveFilter) {
        return hexToRgba(baseHex, highlightedLinkIds.has(link.id) ? 1 : 0.16);
      }
      return hexToRgba(baseHex, 0.7);
    });

    fg.linkDirectionalParticles((l: object) => {
      const link = l as ResolvedLink;
      return (hasActiveFilter && highlightedLinkIds.has(link.id)) || link.id === hoveredLinkId
        ? 4
        : 0;
    });

    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [
    highlightedNodeIds,
    highlightedLinkIds,
    hoveredLinkId,
    selectedNodeId,
    hoveredNodeId,
    alwaysShowLabels,
    nodes,
    links,
  ]);

  return <div ref={containerRef} className="graph-canvas-host" />;
};
