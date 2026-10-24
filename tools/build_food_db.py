"""식약처 음식 영양성분 원본(_raw/page*.json) → 앱용 data/foods.json
원본: data.go.kr 전국통합식품영양성분정보(음식)표준데이터 (15100070)
실행: python -I tools/build_food_db.py
"""
import glob
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ORIGIN = {
    '가정식': '가정식',
    '외식(프랜차이즈': '브랜드',
    '외식': '외식',
    '급식': '급식',
}


def origin_short(s):
    for key, val in ORIGIN.items():
        if key in s:
            return val
    return '기타'


def num(s):
    m = re.match(r'\s*([\d.]+)', s or '')
    return float(m.group(1)) if m else 0.0


def main():
    rows = []
    for path in sorted(glob.glob(os.path.join(ROOT, '_raw', 'page*.json'))):
        with open(path, encoding='utf-8') as f:
            rows += json.load(f)

    out, seen = [], set()
    for r in rows:
        name = (r.get('FOOD_NM') or '').strip()
        kcal = num(r.get('ENERC'))
        if not name:
            continue
        unit = 'ml' if 'ml' in (r.get('NUT_CON_SRTR_QUA') or '') else 'g'
        serving = num(r.get('FOOD_SIZE'))
        brand = r.get('REST_NM') or ''
        brand = '' if brand == '해당없음' else brand
        rec = [name, brand, round(kcal, 1), unit, round(serving, 1), origin_short(r.get('FOOD_ORIGIN_NM') or '')]
        key = tuple(rec)
        if key in seen:
            continue
        seen.add(key)
        out.append(rec)

    meta = {
        'source': '식품의약품안전처 전국통합식품영양성분정보(음식)표준데이터 (data.go.kr 15100070)',
        'basis': max((r.get('CRTR_YMD') or '') for r in rows),
        'cols': ['name', 'brand', 'kcal_per_100', 'unit', 'serving', 'origin'],
    }
    os.makedirs(os.path.join(ROOT, 'data'), exist_ok=True)
    dst = os.path.join(ROOT, 'data', 'foods.json')
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump({'meta': meta, 'rows': out}, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(out)}개 → {dst} ({os.path.getsize(dst) / 1024:.0f} KB)')


if __name__ == '__main__':
    main()
