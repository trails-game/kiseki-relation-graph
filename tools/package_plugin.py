#!/usr/bin/env python3
"""Packages wp-plugin/kiseki-relation-graph into a clean, deterministic WordPress plugin ZIP."""

import argparse
import os
import re
import sys
import zipfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN_DIR = os.path.join(REPO_ROOT, "wp-plugin", "kiseki-relation-graph")
MAIN_PHP = os.path.join(PLUGIN_DIR, "kiseki-relation-graph.php")
PACKAGE_JSON = os.path.join(REPO_ROOT, "package.json")

EXPECTED_REL_FILES = [
    "kiseki-relation-graph.php",
    "includes/class-admin-frontend.php",
    "includes/class-json-store.php",
    "includes/class-rest-controller.php",
    "assets/viewer.js",
    "assets/viewer.css",
    "assets/admin.js",
    "assets/admin.css",
    "seed/zemuria.seed.json",
]


def stamp_version(version: str) -> None:
    if not re.match(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$", version):
        raise ValueError(f"Invalid semantic version: {version!r}")

    with open(MAIN_PHP, "r", encoding="utf-8") as f:
        php_txt = f.read()
    php_txt = re.sub(
        r"(\*\s*Version:\s*)[0-9A-Za-z.\-]+",
        rf"\g<1>{version}",
        php_txt,
        count=1,
    )
    php_txt = re.sub(
        r"(define\(\s*'KISEKI_RELATION_VERSION',\s*')[^']+('\s*\);)",
        rf"\g<1>{version}\g<2>",
        php_txt,
        count=1,
    )
    with open(MAIN_PHP, "w", encoding="utf-8") as f:
        f.write(php_txt)

    if os.path.isfile(PACKAGE_JSON):
        with open(PACKAGE_JSON, "r", encoding="utf-8") as f:
            pkg_txt = f.read()
        pkg_txt = re.sub(
            r'("version"\s*:\s*")[^"]+(")',
            rf"\g<1>{version}\g<2>",
            pkg_txt,
            count=1,
        )
        with open(PACKAGE_JSON, "w", encoding="utf-8") as f:
            f.write(pkg_txt)


def read_plugin_version() -> str:
    with open(MAIN_PHP, "r", encoding="utf-8") as f:
        txt = f.read()
    m_hdr = re.search(r"\*\s*Version:\s*([0-9A-Za-z.\-]+)", txt)
    m_const = re.search(r"define\(\s*'KISEKI_RELATION_VERSION',\s*'([^']+)'\s*\);", txt)
    if not m_hdr or not m_const or m_hdr.group(1) != m_const.group(1):
        raise RuntimeError("Plugin Version header and KISEKI_RELATION_VERSION constant do not match.")
    return m_hdr.group(1)


def main() -> int:
    parser = argparse.ArgumentParser(description="Package kiseki-relation-graph.zip")
    parser.add_argument("--output", default=os.path.join(REPO_ROOT, "kiseki-relation-graph.zip"))
    parser.add_argument("--stamp-version", help="Update plugin version before packaging")
    parser.add_argument("--expect-version", help="Verify plugin version matches expected string")
    args = parser.parse_args()

    if args.stamp_version:
        stamp_version(args.stamp_version)

    ver = read_plugin_version()
    if args.expect_version and ver != args.expect_version:
        print(f"ERROR: Plugin version {ver!r} != expected {args.expect_version!r}", file=sys.stderr)
        return 1

    for rel in EXPECTED_REL_FILES:
        fp = os.path.join(PLUGIN_DIR, rel)
        if not os.path.isfile(fp) or os.path.getsize(fp) == 0:
            print(f"ERROR: Missing or empty plugin file: {fp}", file=sys.stderr)
            return 1

    out_path = os.path.abspath(args.output)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel in EXPECTED_REL_FILES:
            src_fp = os.path.join(PLUGIN_DIR, rel)
            arcname = f"kiseki-relation-graph/{rel}"
            info = zipfile.ZipInfo(arcname, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(src_fp, "rb") as rf:
                zf.writestr(info, rf.read())

    size_kb = os.path.getsize(out_path) / 1024
    print(f"Packaged {out_path} (v{ver}, {len(EXPECTED_REL_FILES)} files, {size_kb:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
