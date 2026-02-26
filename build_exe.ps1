python -m pip install --upgrade pip
pip install -r requirements.txt
pip install pyinstaller
pyinstaller --noconfirm --onefile --windowed --name "Real-Debrid-Downloader" real_debrid_downloader_gui.py

Write-Host "Build fertig: dist/Real-Debrid-Downloader.exe"
