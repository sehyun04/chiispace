"""앱 아이콘을 얼굴 그림에서 굽는다 — 치이카와·하치와레·우사기 셋이 한 장에 모인 것.

    python scripts/make-icon.py            # src-tauri/icons 의 png·ico·icns 를 다시 만든다
    python scripts/make-icon.py --preview  # 굽지 않고 미리 보기 한 장만(icon-preview.png)

그림을 따로 그리지 않고 `ui/assets/faces/` 의 얼굴을 겹쳐 앉힌다. 칸 머리줄·옆칸에 서는 얼굴과 같은 그림이어야
작업 표시줄의 아이콘과 앱 안의 캐릭터가 같은 아이로 보인다. 고친 뒤에는 exe 를 다시 구워야 바뀐다 —
Windows 아이콘은 빌드 때 exe 안에 박힌다(tauri-build).
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
FACES = ROOT / "ui" / "assets" / "faces"
ICONS = ROOT / "src-tauri" / "icons"
SIZE = 1024


def face(slug: str) -> Image.Image:
    """투명한 가장자리를 걷어 낸 얼굴. 그림마다 여백이 달라 그대로 겹치면 크기가 들쭉날쭉하다."""
    im = Image.open(FACES / f"{slug}.png").convert("RGBA")
    alpha = im.getchannel("A").point(lambda a: 255 if a > 16 else 0)
    return im.crop(alpha.getbbox())


def fit(im: Image.Image, height: int) -> Image.Image:
    w, h = im.size
    return im.resize((round(w * height / h), height), Image.LANCZOS)


def compose() -> Image.Image:
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    # 하치와레·우사기를 위에 나란히, 치이카와를 그 사이 앞 아래에 세운다. 셋을 한 줄로 겹치면 가운데가 양옆의
    # 눈·입을 가려 작은 크기에서 누가 누군지 안 읽힌다. 우사기는 귀가 길어 같은 키로 맞추면 얼굴이 작아지므로 더 크게 준다.
    hachi = fit(face("hachiware"), 500)
    usagi = fit(face("usagi"), 600)
    chii = fit(face("chiikawa"), 440)
    canvas.alpha_composite(hachi, (8, 700 - hachi.height))
    canvas.alpha_composite(usagi, (SIZE - usagi.width - 8, 700 - usagi.height))
    canvas.alpha_composite(chii, ((SIZE - chii.width) // 2, SIZE - chii.height - 8))
    return canvas


def main() -> None:
    icon = compose()
    if "--preview" in sys.argv:
        out = ROOT / "icon-preview.png"
        icon.save(out)
        print(out)
        return
    for name, px in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 512)]:
        icon.resize((px, px), Image.LANCZOS).save(ICONS / name)
    # Windows 는 자리마다 다른 크기를 집는다(작업 표시줄 32, 탐색기 48·256 …). 한 장을 줄여 넣으면 작은 자리가 뭉개진다.
    icon.save(ICONS / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    icon.save(ICONS / "icon.icns")
    print("icons:", ", ".join(sorted(p.name for p in ICONS.iterdir())))


if __name__ == "__main__":
    main()
