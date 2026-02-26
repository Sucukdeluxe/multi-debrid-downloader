from pathlib import Path


def main() -> int:
    project_root = Path(__file__).resolve().parents[1]
    png_path = project_root / "assets" / "app_icon.png"
    ico_path = project_root / "assets" / "app_icon.ico"

    if not png_path.exists():
        print(f"Icon PNG not found: {png_path}")
        return 1

    try:
        from PIL import Image
    except ImportError:
        print("Pillow missing. Install with: pip install pillow")
        return 1

    with Image.open(png_path) as image:
        image = image.convert("RGBA")
        sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
        image.save(ico_path, format="ICO", sizes=sizes)

    print(f"Wrote icon: {ico_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
