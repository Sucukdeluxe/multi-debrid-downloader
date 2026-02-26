# Real-Debrid Downloader GUI

Kleine Desktop-App mit GUI (Tkinter), um mehrere Links (z. B. 20+) einzufuegen,
ueber Real-Debrid zu unrestricten und direkt auf deinen PC zu laden.

## Features

- Mehrere Links auf einmal (ein Link pro Zeile)
- Nutzt die Real-Debrid API (`/unrestrict/link`)
- Download-Status pro Link
- Download-Speed pro Link und gesamt
- Gesamt-Fortschritt
- Download-Ordner und Paketname waehlbar
- Einstellbare Parallel-Downloads (z. B. 20 gleichzeitig)
- Automatisches Entpacken nach dem Download
- `Entpacken nach` + optional `Unterordner erstellen (Paketname)` wie bei JDownloader
- ZIP-Passwort-Check mit `serienfans.org` und `serienjunkies.net`
- Multi-Part-RAR wird ueber `part1` entpackt (nur wenn alle Parts vorhanden sind)
- Auto-Update Check ueber GitHub Releases (fuer .exe)
- Optionales lokales Speichern vom API Token

## Voraussetzung

- Python 3.10+
- Optional, aber empfohlen: 7-Zip im PATH fuer RAR/7Z-Entpackung
- Alternative fuer RAR: WinRAR `UnRAR.exe` (wird automatisch erkannt)

## Installation

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## Start

```bash
python real_debrid_downloader_gui.py
```

## Nutzung

1. API Token von Real-Debrid eintragen (`https://real-debrid.com/apitoken`)
2. Download-Ordner waehlen
3. Optional Paketname setzen (sonst wird automatisch einer erzeugt)
4. Optional Entpack-Ordner waehlen (`Entpacken nach`)
5. Optional `Unterordner erstellen (Paketname)` aktiv lassen
6. Parallel-Wert setzen (z. B. 20)
7. Links in das Textfeld eintragen (pro Zeile ein Link)
8. `Download starten` klicken

Wenn du 20 Links einfuegst, werden sie als ein Paket behandelt. Downloads landen in einem Paketordner. Beim Entpacken kann derselbe Paketname automatisch als Unterordner genutzt werden.

## Auto-Update (GitHub)

1. Standard-Repo ist bereits gesetzt: `Sucukdeluxe/real-debrid-downloader`
2. Optional kannst du es in der App mit `GitHub Repo (owner/name)` ueberschreiben
3. Klicke `Update suchen` oder aktiviere `Beim Start auf Updates pruefen`
4. In der .exe wird ein neues Release heruntergeladen und beim Neustart installiert

Hinweis: Beim Python-Skript gibt es nur einen Release-Hinweis, kein Self-Replace.

## Release Build (.exe)

```bash
pip install pyinstaller
pyinstaller --noconfirm --onefile --windowed --name "Real-Debrid-Downloader" real_debrid_downloader_gui.py
```

Danach liegt die EXE in `dist/`.

## GitHub Release Workflow

- Workflow-Datei: `.github/workflows/release.yml`
- Bei Tag-Push wie `v1.0.1` wird automatisch eine Windows-EXE gebaut
- Release-Asset fuer Auto-Update: `Real-Debrid-Downloader-win64.zip`

Beispiel:

```bash
git tag v1.0.1
git push origin v1.0.1
```

Hinweis: Die App kann nur Links laden, die von Real-Debrid unterstuetzt werden.
