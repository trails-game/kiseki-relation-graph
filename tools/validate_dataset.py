#!/usr/bin/env python3
"""Validates schema, ontology, supersede chains, and multi-arc subgraph integrity for data/zemuria.latest.json."""

import itertools
import json
import os
import sys
from collections import Counter, defaultdict

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATASET_PATH = os.path.join(REPO_ROOT, "data", "zemuria.latest.json")

VALID_ENTITY_TYPES = {"nation", "organization", "family", "school", "character"}
VALID_TIERS = {"core", "supporting", "minor"}
VALID_CATEGORIES = {"membership", "hierarchy", "family", "school", "ally", "romance", "hostile"}
VALID_DIRECTIONS = {"directed", "bidirectional"}
TIER_RANK = {"core": 1, "supporting": 2, "minor": 3}


def main() -> int:
    if not os.path.isfile(DATASET_PATH):
        print(f"ERROR: Dataset not found at {DATASET_PATH}", file=sys.stderr)
        return 1

    with open(DATASET_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    arcs = data.get("arcs", [])
    entities = data.get("entities", [])
    relations = data.get("relations", [])

    if not arcs or not entities or not relations:
        print("ERROR: arcs, entities, and relations must all be non-empty.", file=sys.stderr)
        return 1

    arc_ids = [a["id"] for a in arcs]
    if len(arc_ids) != len(set(arc_ids)):
        print("ERROR: Duplicate arc IDs detected.", file=sys.stderr)
        return 1
    arc_order = {a["id"]: a["order"] for a in arcs}
    arc_set = set(arc_ids)

    entity_by_id = {}
    wp_post_ids = set()
    for ent in entities:
        eid = ent.get("id", "")
        if not eid or eid in entity_by_id:
            print(f"ERROR: Invalid or duplicate entity id: {eid!r}", file=sys.stderr)
            return 1
        if ent.get("entityType") not in VALID_ENTITY_TYPES:
            print(f"ERROR: Entity {eid} has invalid entityType {ent.get('entityType')!r}", file=sys.stderr)
            return 1
        if ent.get("importance") not in VALID_TIERS:
            print(f"ERROR: Entity {eid} has invalid importance {ent.get('importance')!r}", file=sys.stderr)
            return 1
        earcs = ent.get("arcs", [])
        if not earcs or any(a not in arc_set for a in earcs):
            print(f"ERROR: Entity {eid} has invalid arcs {earcs!r}", file=sys.stderr)
            return 1
        pid = ent.get("wpPostId")
        if pid is not None:
            if pid in wp_post_ids:
                print(f"ERROR: Duplicate wpPostId {pid} on {eid}", file=sys.stderr)
                return 1
            wp_post_ids.add(pid)
        entity_by_id[eid] = ent

    rel_by_id = {}
    for rel in relations:
        rid = rel.get("id", "")
        if not rid or rid in rel_by_id:
            print(f"ERROR: Invalid or duplicate relation id: {rid!r}", file=sys.stderr)
            return 1
        if rel.get("source") not in entity_by_id or rel.get("target") not in entity_by_id:
            print(f"ERROR: Relation {rid} references unknown endpoint.", file=sys.stderr)
            return 1
        if rel.get("source") == rel.get("target"):
            print(f"ERROR: Self-loop relation {rid}.", file=sys.stderr)
            return 1
        if rel.get("category") not in VALID_CATEGORIES:
            print(f"ERROR: Relation {rid} has invalid category {rel.get('category')!r}", file=sys.stderr)
            return 1
        if rel.get("direction") not in VALID_DIRECTIONS:
            print(f"ERROR: Relation {rid} has invalid direction {rel.get('direction')!r}", file=sys.stderr)
            return 1
        if not str(rel.get("label", "")).strip():
            print(f"ERROR: Relation {rid} has empty label.", file=sys.stderr)
            return 1
        rarcs = rel.get("arcs", [])
        if not rarcs or any(a not in arc_set for a in rarcs):
            print(f"ERROR: Relation {rid} has invalid arcs {rarcs!r}", file=sys.stderr)
            return 1
        rel_by_id[rid] = rel

    # Verify supersedesId chains are valid and acyclic
    for rid, rel in rel_by_id.items():
        sup = rel.get("supersedesId")
        seen = {rid}
        while sup:
            if sup not in rel_by_id:
                print(f"ERROR: Relation {rid} has dangling supersedesId {sup!r}", file=sys.stderr)
                return 1
            if sup in seen:
                print(f"ERROR: Cycle detected in supersedesId chain starting at {rid}", file=sys.stderr)
                return 1
            seen.add(sup)
            sup = rel_by_id[sup].get("supersedesId")

    def check_subgraph(selected_arcs: list[str], max_tier: str) -> None:
        sel_set = set(selected_arcs)
        ordered = sorted(selected_arcs, key=lambda a: arc_order[a])
        active_nodes = set()
        for eid, ent in entity_by_id.items():
            if not any(a in sel_set for a in ent["arcs"]):
                continue
            eff_tier = ent["importance"]
            overrides = ent.get("arcOverrides") or {}
            for a in ordered:
                ov = overrides.get(a)
                if ov and ov.get("importance") in VALID_TIERS:
                    eff_tier = ov["importance"]
            if TIER_RANK[eff_tier] <= TIER_RANK[max_tier]:
                active_nodes.add(eid)

        cand = [
            r for r in relations
            if r["source"] in active_nodes
            and r["target"] in active_nodes
            and any(a in sel_set for a in r["arcs"])
        ]
        cand_ids = {r["id"] for r in cand}
        superseded = set()
        for r in cand:
            cur = r.get("supersedesId")
            while cur:
                if cur in cand_ids:
                    superseded.add(cur)
                cur = rel_by_id[cur].get("supersedesId")

        kept = [r for r in cand if r["id"] not in superseded]
        deg = Counter()
        pairs = defaultdict(list)
        for r in kept:
            deg[r["source"]] += 1
            deg[r["target"]] += 1
            pairs[tuple(sorted((r["source"], r["target"])))].append(r["category"])

        orphans = [eid for eid in active_nodes if deg[eid] == 0]
        if orphans:
            raise AssertionError(f"Orphans in arcs={selected_arcs} tier={max_tier}: {orphans}")
        for pair, cats in pairs.items():
            if len(cats) != len(set(cats)):
                raise AssertionError(
                    f"Duplicate same-category parallel edge in arcs={selected_arcs} tier={max_tier} on {pair}"
                )

    for r_len in range(1, len(arc_ids) + 1):
        for combo in itertools.combinations(arc_ids, r_len):
            for tier in ("core", "supporting", "minor"):
                check_subgraph(list(combo), tier)

    print(
        f"Dataset OK: {len(arcs)} arcs, {len(entities)} entities, "
        f"{len(relations)} relations across {(2 ** len(arc_ids) - 1) * 3} verified subgraphs."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
