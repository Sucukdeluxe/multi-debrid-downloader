param(
  [string]$Version = ""
)

python -m pip install --upgrade pip
pip install -r requirements.txt
pip install pyinstaller pillow

if ($Version -ne "") {
  python scripts/set_version.py $Version
}

python scripts/prepare_icon.py
pyinstaller --noconfirm --windowed --onedir --name "Real-Debrid-Downloader" --icon "assets/app_icon.ico" real_debrid_downloader_gui.py

Write-Host "Build fertig: dist/Real-Debrid-Downloader/Real-Debrid-Downloader.exe"
