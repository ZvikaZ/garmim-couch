#!/usr/bin/env python3
"""Download landmarks for Israel and its surroundings from OpenStreetMap (Overpass)
and write a compact static file, data/landmarks.json, so the app loads instantly and offline.

Usage: python3 tools/build_landmarks.py [--input raw.json] [--out data/landmarks.json]
"""
import argparse
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

# south, west, north, east: Israel, Lebanon, Golan + south Syria, west Jordan, north-east Sinai
REGION = (29.3, 34.0, 34.75, 36.95)

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]


def query():
    s, w, n, e = REGION
    bb = f"({s},{w},{n},{e})"
    return f"""[out:json][timeout:300];
(
  node["place"~"^(city|town|village|hamlet)$"]["name"]{bb};
  node["natural"~"^(peak|volcano)$"]["name"]{bb};
  way["natural"="water"]["name"]["wikidata"]{bb};
  relation["natural"="water"]["name"]["wikidata"]{bb};
  way["natural"="valley"]["name"]["wikidata"]{bb};
  relation["natural"="valley"]["name"]["wikidata"]{bb};
);
out tags bb qt;"""


def fetch(q):
    body = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for attempt in range(3):
        for url in ENDPOINTS:
            try:
                print(f"querying {url} (attempt {attempt + 1})", file=sys.stderr)
                req = urllib.request.Request(url, data=body, headers={"User-Agent": "ma-roim-landmarks/1.0"})
                with urllib.request.urlopen(req, timeout=400) as r:
                    return json.load(r)
            except Exception as ex:  # noqa: BLE001
                print(f"  failed: {ex}", file=sys.stderr)
                last = ex
        time.sleep(30)
    raise SystemExit(f"all Overpass endpoints failed: {last}")


def dist_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(min(1, math.sqrt(a)))


def parse_float(v):
    if not v:
        return None
    try:
        return round(float(str(v).replace(",", ".").split()[0]), 1)
    except ValueError:
        return None


def parse_int(v):
    try:
        return int(str(v).replace(",", "").split()[0])
    except (ValueError, IndexError):
        return None


def convert(raw):
    out, seen = [], set()
    for el in raw.get("elements", []):
        t = el.get("tags", {})
        name = t.get("name:he") or t.get("name:en") or t.get("name")
        if not name:
            continue
        kind = t.get("place") or t.get("natural")
        lat, lon, area = el.get("lat"), el.get("lon"), None
        if lat is None and "bounds" in el:
            b = el["bounds"]
            lat = (b["minlat"] + b["maxlat"]) / 2
            lon = (b["minlon"] + b["maxlon"]) / 2
            h = dist_km(b["minlat"], lon, b["maxlat"], lon)
            w = dist_km(lat, b["minlon"], lat, b["maxlon"])
            area = round(h * w * 0.6, 2)
        if lat is None:
            continue
        key = (kind, name, round(lat, 2), round(lon, 2))
        if key in seen:
            continue
        seen.add(key)
        wp = f"he:{t['wikipedia:he']}" if t.get("wikipedia:he") else t.get("wikipedia")
        rec = {"k": kind, "n": name, "la": round(lat, 5), "lo": round(lon, 5)}
        if t.get("name") and t["name"] != name:
            rec["nl"] = t["name"]
        for k, v in (("e", parse_float(t.get("ele"))), ("p", parse_int(t.get("population"))),
                     ("w", t.get("wikidata")), ("wp", wp), ("a", area)):
            if v is not None:
                rec[k] = v
        out.append(rec)
    out.sort(key=lambda r: (r["la"], r["lo"]))
    return out


def roads_query():
    s, w, n, e = REGION
    return f"""[out:json][timeout:300];
way["highway"~"^(motorway|trunk|primary|secondary)$"]["ref"]({s},{w},{n},{e});
out tags geom qt;"""


ROAD_STEP_KM = 0.6


def convert_roads(raw):
    """Resample every numbered road to a point every ~600 m: [refIndex, lat, lon]."""
    refs, ref_idx, pts = [], {}, []
    for el in raw.get("elements", []):
        ref = (el.get("tags", {}).get("ref") or "").split(";")[0].strip()
        geom = el.get("geometry") or []
        if not ref or len(geom) < 2:
            continue
        if ref not in ref_idx:
            ref_idx[ref] = len(refs)
            refs.append(ref)
        ri = ref_idx[ref]
        carry = ROAD_STEP_KM / 2  # distance to the next sample along the way
        for a, b in zip(geom, geom[1:]):
            seg = dist_km(a["lat"], a["lon"], b["lat"], b["lon"])
            pos = carry
            while pos <= seg:
                t = pos / seg if seg else 0
                pts.append([ri, round(a["lat"] + (b["lat"] - a["lat"]) * t, 5), round(a["lon"] + (b["lon"] - a["lon"]) * t, 5)])
                pos += ROAD_STEP_KM
            carry = pos - seg
    return {"refs": refs, "pts": pts}


def write(path, doc):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", help="use a saved Overpass JSON instead of downloading (landmarks)")
    ap.add_argument("--roads-input", help="use a saved Overpass JSON instead of downloading (roads)")
    ap.add_argument("--out", default="data/landmarks.json")
    ap.add_argument("--roads-out", default="data/roads.json")
    ap.add_argument("--what", choices=["all", "landmarks", "roads"], default="all")
    a = ap.parse_args()
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    meta = {"generated": stamp, "region": REGION, "source": "© OpenStreetMap contributors, ODbL"}

    if a.what in ("all", "landmarks"):
        raw = json.load(open(a.input, encoding="utf-8")) if a.input else fetch(query())
        pois = convert(raw)
        if len(pois) < 500 and not a.input:
            raise SystemExit(f"suspiciously few landmarks ({len(pois)}), not writing")
        write(a.out, {**meta, "pois": pois})
        kinds = {}
        for p in pois:
            kinds[p["k"]] = kinds.get(p["k"], 0) + 1
        print(f"wrote {len(pois)} landmarks to {a.out}: {kinds}", file=sys.stderr)

    if a.what in ("all", "roads"):
        raw = json.load(open(a.roads_input, encoding="utf-8")) if a.roads_input else fetch(roads_query())
        roads = convert_roads(raw)
        if len(roads["pts"]) < 1000 and not a.roads_input:
            raise SystemExit(f"suspiciously few road points ({len(roads['pts'])}), not writing")
        write(a.roads_out, {**meta, **roads})
        print(f"wrote {len(roads['refs'])} roads / {len(roads['pts'])} points to {a.roads_out}", file=sys.stderr)


if __name__ == "__main__":
    main()
