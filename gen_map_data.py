"""
重新生成縣市 / 鄉鎮 GeoJSON 嵌入式 JS 檔案
使用較低容差（縣市 0.0002°、鄉鎮 0.0003°）以保留更精確的邊界
"""
import json, sys, os
from shapely.geometry import shape, mapping
from shapely.validation import make_valid

BASE = os.path.dirname(os.path.abspath(__file__))

COUNTY_IN  = os.path.join(BASE, "台灣地圖圖資資料", "台灣直轄市縣市界線", "台灣直轄市縣市界線_1140318.geojson")
TOWN_IN    = os.path.join(BASE, "台灣地圖圖資資料", "台灣鄉鎮市區界線", "台灣鄉鎮市區界線_1140318.geojson")
COUNTY_OUT = os.path.join(BASE, "county_data.js")
TOWN_OUT   = os.path.join(BASE, "town_data.js")

COUNTY_TOL = 0        # 0 = 不簡化，保留原始座標
TOWN_TOL   = 0        # 0 = 不簡化，保留原始座標
COORD_DIG  = 7        # 座標四捨五入位數（約 1cm 精度）

def round_coords(obj):
    """遞迴四捨五入座標"""
    if isinstance(obj, (int, float)):
        return round(obj, COORD_DIG)
    if isinstance(obj, list):
        return [round_coords(v) for v in obj]
    return obj


def simplify_feature(feature, tolerance):
    geom = shape(feature["geometry"])
    if not geom.is_valid:
        geom = make_valid(geom)
    if tolerance > 0:
        simplified = geom.simplify(tolerance, preserve_topology=True)
        if simplified.is_empty:
            simplified = geom
    else:
        simplified = geom  # tolerance=0：保留全部原始座標
    geo = mapping(simplified)
    geo["coordinates"] = round_coords(geo["coordinates"])
    return {**feature, "geometry": geo}


def process(in_path, out_path, js_var, tolerance, keep_props):
    print(f"載入 {os.path.basename(in_path)} ...")
    with open(in_path, encoding="utf-8") as f:
        data = json.load(f)

    total = len(data["features"])
    features = []
    for i, feat in enumerate(data["features"]):
        props = {k: feat["properties"][k] for k in keep_props if k in feat["properties"]}
        try:
            simplified = simplify_feature({"type": "Feature", "properties": props, "geometry": feat["geometry"]}, tolerance)
            features.append(simplified)
        except Exception as e:
            print(f"  略過 feature {i}: {e}")
        if (i + 1) % 50 == 0 or (i + 1) == total:
            print(f"  進度 {i+1}/{total}", end="\r")

    print()
    out_data = {"type": "FeatureCollection", "features": features}
    js_content = f"var {js_var} = {json.dumps(out_data, ensure_ascii=False, separators=(',', ':'))};"

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(js_content)

    size_kb = os.path.getsize(out_path) / 1024
    print(f"  輸出 {os.path.basename(out_path)}  {size_kb:.0f} KB，{len(features)} 個 features")


if __name__ == "__main__":
    process(COUNTY_IN, COUNTY_OUT, "COUNTY_DATA", COUNTY_TOL,
            ["COUNTYID", "COUNTYNAME", "COUNTYENG"])
    process(TOWN_IN,   TOWN_OUT,   "TOWN_DATA",   TOWN_TOL,
            ["COUNTYID", "COUNTYNAME", "TOWNID", "TOWNNAME", "TOWNENG"])
    print("\n完成！請重新整理瀏覽器頁面。")
