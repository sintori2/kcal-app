"""kfood.zip(안에 분류별 zip 27개) → data/<분류>/<음식>/*.jpg
원본 zip은 읽기만 하고 건드리지 않는다. 이미 푼 분류는 건너뜀.
실행: venv/Scripts/python -I extract.py <kfood.zip 경로>
"""
import io
import os
import sys
import zipfile

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
IMG = ('.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp')


def name(info):
    if info.flag_bits & 0x800:
        return info.filename
    try:
        return info.filename.encode('cp437').decode('cp949')
    except (UnicodeEncodeError, UnicodeDecodeError):
        return info.filename


def main():
    outer = zipfile.ZipFile(SRC)
    for idx, oi in enumerate(outer.infolist()):
        # 바깥 zip 이름(분류명)은 인코딩이 깨져 있어 번호로 쓰고, 음식 이름은 안쪽 폴더명을 그대로 씀
        cat = f'cat{idx:02d}'
        done = os.path.join(OUT, cat, '.done')
        if os.path.exists(done):
            print('skip', cat)
            continue
        print('extract', cat, f'{oi.file_size / 1e9:.2f}GB', flush=True)
        with outer.open(oi) as f:
            inner = zipfile.ZipFile(io.BytesIO(f.read()))
        n = 0
        for ii in inner.infolist():
            p = name(ii)
            if ii.is_dir() or not p.lower().endswith(IMG + ('.properties', '.txt', '.json', '.csv')):
                continue
            dst = os.path.join(OUT, cat, *p.split('/'))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with inner.open(ii) as src, open(dst, 'wb') as w:
                w.write(src.read())
            n += 1
        open(done, 'w').close()
        print('  files', n, flush=True)


if __name__ == '__main__':
    main()
