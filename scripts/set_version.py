import re
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python scripts/set_version.py <version>")
        return 1

    version = sys.argv[1].strip().lstrip("v")
    if not re.fullmatch(r"\d+(?:\.\d+){1,3}", version):
        print(f"Invalid version: {version}")
        return 1

    target = Path(__file__).resolve().parents[1] / "real_debrid_downloader_gui.py"
    content = target.read_text(encoding="utf-8")
    updated, count = re.subn(
        r'^APP_VERSION\s*=\s*"[^"]+"\s*$',
        f'APP_VERSION = "{version}"',
        content,
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        print("APP_VERSION marker not found")
        return 1

    target.write_text(updated, encoding="utf-8")
    print(f"Set APP_VERSION to {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
