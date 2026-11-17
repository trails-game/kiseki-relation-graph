#!/usr/bin/env python3
"""Fetches character (dt_team), organization (org), and region metadata from trails-game.com WP REST API."""

import json
import os
import time
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.environ.get(
    "WP_CATALOG_OUT",
    os.path.join(REPO_ROOT, "tools", "cache", "trails_wp_catalog.json"),
)


def get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read().decode("utf-8")), resp.headers


def main():
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    catalog = {}
    if os.path.exists(OUT_PATH):
        with open(OUT_PATH, "r", encoding="utf-8") as f:
            catalog = json.load(f)

    for cpt in ["dt_team", "org", "region"]:
        if catalog.get(cpt):
            for it in catalog[cpt]:
                av = it.get("avatar", "")
                if av.startswith("https://trails-game.com/wp-content/uploads/"):
                    it["avatar"] = av.replace("https://trails-game.com/", "https://cdn.trails-game.com/")
            print(f"{cpt}: already cached ({len(catalog[cpt])} items)")
            continue

        items = []
        page = 1
        while True:
            url = f"https://trails-game.com/wp-json/wp/v2/{cpt}?per_page=50&page={page}&_fields=id,slug,title,link,featured_media,excerpt"
            try:
                batch, hdrs = get_json(url)
                total_pages = int(hdrs.get("X-WP-TotalPages", "1"))
            except Exception as e:
                print(f"Stopped {cpt} page {page}: {e}")
                break
            for x in batch:
                items.append({
                    "id": x["id"],
                    "slug": x.get("slug", ""),
                    "title": x.get("title", {}).get("rendered", ""),
                    "link": x.get("link", ""),
                    "featured_media": x.get("featured_media", 0),
                    "avatar": "",
                    "excerpt": x.get("excerpt", {}).get("rendered", "")[:240],
                })
            time.sleep(0.25)
            if page >= total_pages or not batch:
                break
            page += 1

        mids = sorted({it["featured_media"] for it in items if it.get("featured_media")})
        media_map = {}
        for i in range(0, len(mids), 50):
            chunk = ",".join(str(m) for m in mids[i : i + 50])
            api = f"https://trails-game.com/wp-json/wp/v2/media?include={chunk}&per_page=50&_fields=id,source_url,media_details"
            try:
                mbatch, _ = get_json(api)
                for m in mbatch:
                    sizes = m.get("media_details", {}).get("sizes", {})
                    av = (
                        sizes.get("thumbnail", {}).get("source_url")
                        or sizes.get("medium", {}).get("source_url")
                        or m.get("source_url", "")
                    )
                    media_map[m["id"]] = av
            except Exception as e:
                print(f"Media chunk error: {e}")
            time.sleep(0.2)

        for it in items:
            av = media_map.get(it.get("featured_media"), "")
            if av.startswith("https://trails-game.com/wp-content/uploads/"):
                av = av.replace("https://trails-game.com/", "https://cdn.trails-game.com/")
            it["avatar"] = av

        catalog[cpt] = items
        with_av = sum(1 for it in items if it["avatar"])
        print(f"{cpt}: fetched {len(items)} items ({with_av} with avatars)")

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
