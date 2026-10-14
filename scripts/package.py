"""Build a standalone PhoneBoxSound.exe (no Python or Node needed on the target PC).

    npm run package        ->  release/PhoneBoxSound/PhoneBoxSound.exe  (+ release/PhoneBoxSound-win64.zip)

A folder build rather than a single file, so nothing has to be unpacked at launch (it starts in
under a second). The web app is bundled; config.json and data/ are created next to the exe.
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "web", "dist")
WORK = os.path.join(ROOT, "build")
OUT = os.path.join(ROOT, "release")


def main():
    if not os.path.exists(os.path.join(DIST, "index.html")):
        sys.exit("web/dist is missing: run `npm run build` first")
    os.makedirs(WORK, exist_ok=True)
    ico = os.path.join(WORK, "icon.ico")
    from PIL import Image
    Image.open(os.path.join(ROOT, "web", "public", "icon-512.png")).save(ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    cmd = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--windowed",
        "--name", "PhoneBoxSound", "--icon", ico,
        "--distpath", OUT, "--workpath", WORK, "--specpath", WORK,
        "--add-data", f"{DIST}{os.pathsep}web/dist",
        "--add-data", f"{os.path.join(ROOT, 'extension')}{os.pathsep}extension",
        "--paths", ROOT,
        # Windows media sessions (winrt is a namespace package PyInstaller can't see into by itself)
        "--collect-all", "winrt",
        "--collect-submodules", "pycaw", "--collect-submodules", "comtypes",
        "--hidden-import", "pystray._win32", "--hidden-import", "PIL._tkinter_finder",
        "--exclude-module", "tkinter", "--exclude-module", "pytest", "--exclude-module", "fitz", "--exclude-module", "pymupdf",
        os.path.join(ROOT, "scripts", "entry.py"),
    ]
    subprocess.run(cmd, check=True, cwd=ROOT)
    folder = os.path.join(OUT, "PhoneBoxSound")
    for name in ("LICENSE", "DISCLAIMER.md", "README.md"):       # the terms travel with the program
        shutil.copy2(os.path.join(ROOT, name), os.path.join(OUT, "PhoneBoxSound", name))
    zip_path = shutil.make_archive(os.path.join(OUT, "PhoneBoxSound-win64"), "zip", OUT, "PhoneBoxSound")
    print(f"\nBuilt {os.path.join(folder, 'PhoneBoxSound.exe')}")
    print(f"Zip for a GitHub release: {zip_path}  ({os.path.getsize(zip_path) / 1e6:.1f} MB)")
    shutil.rmtree(WORK, ignore_errors=True)


if __name__ == "__main__":
    main()
