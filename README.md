# Real-Debrid Downloader GUI

Kleine Desktop-App mit GUI (Tkinter), um mehrere Links (z. B. 20+) einzufuegen,
ueber Real-Debrid zu unrestricten und direkt auf deinen PC zu laden.

## Features

- Mehrere Links auf einmal (ein Link pro Zeile)
- DLC Import (`.dlc`) ueber dcrypt.it inklusive Paket-Gruppierung
- DLC Drag-and-Drop: `.dlc` direkt in den Links-Bereich ziehen
- Nutzt die Real-Debrid API (`/unrestrict/link`)
- Download-Status pro Link
- Paket-Ansicht: Paket ist aufklappbar, darunter alle Einzel-Links
- Laufende Pakete koennen per Rechtsklick direkt abgebrochen/entfernt werden
- Download-Speed pro Link und gesamt
- Gesamt-Fortschritt
- Download-Ordner und Paketname waehlbar
- Einstellbare Parallel-Downloads (z. B. 20 gleichzeitig)
- Parallel-Wert kann waehrend laufender Downloads live angepasst werden
- Retry-Counter pro Link in der Tabelle
- Automatisches Entpacken nach dem Download
- Hybrid-Entpacken: entpackt sofort, sobald ein Archivsatz komplett ist
- Optionales Auto-Cleanup: Archivteile nach erfolgreichem Entpacken loeschen
- Speed-Limit (global oder pro Download), live aenderbar
- Linklisten als `.txt` speichern/laden
- DLC-Dateien als Paketliste importieren (`DLC import`)
- `Entpacken nach` + optional `Unterordner erstellen (Paketname)` wie bei JDownloader
- `Settings` (JDownloader-Style):
  - Nach erfolgreichem Entpacken: keine / Papierkorb / unwiderruflich loeschen
  - Bei Konflikten: ueberschreiben / ueberspringen / umbenennen
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
6. Optional `Hybrid-Entpacken` und `Cleanup` setzen
7. Parallel-Wert setzen (z. B. 20)
8. Optional Speed-Limit setzen (KB/s, Modus `global` oder `per_download`)
9. Links einfuegen oder per `Links laden` / `DLC import` importieren
10. `Download starten` klicken

Wenn du 20 Links einfuegst, werden sie als ein Paket behandelt. Downloads landen in einem Paketordner. Beim Entpacken kann derselbe Paketname automatisch als Unterordner genutzt werden.

Bei DLC-Import mit vielen Paketen setzt die App automatisch Paketmarker (`# package: ...`) und verarbeitet die Pakete in einer Queue.

## Auto-Update (GitHub)

1. Standard-Repo ist bereits gesetzt: `Sucukdeluxe/real-debrid-downloader`
2. Optional kannst du es in der App mit `GitHub Repo (owner/name)` ueberschreiben
3. Klicke `Update suchen` oder aktiviere `Beim Start auf Updates pruefen`
4. In der .exe wird ein neues Release heruntergeladen und beim Neustart installiert

Hinweis: Beim Python-Skript gibt es nur einen Release-Hinweis, kein Self-Replace.

## Release Build (.exe)

```bash
./build_exe.ps1 -Version 1.1.0
```

Danach liegt die App unter `dist/Real-Debrid-Downloader/`.

## GitHub Release Workflow

- Workflow-Datei: `.github/workflows/release.yml`
- Bei Tag-Push wie `v1.0.1` wird automatisch eine Windows-EXE gebaut
- Release-Asset fuer Auto-Update: `Real-Debrid-Downloader-win64.zip`
- Zusaetzlich wird ein Installer gebaut: `Real-Debrid-Downloader-Setup-<version>.exe`
- Installer legt automatisch eine Desktop-Verknuepfung an

## Auto-Installer

- Im GitHub Release findest du direkt die Setup-Datei (`...Setup-<version>.exe`)
- Setup installiert die App unter `Programme/Real-Debrid Downloader`
- Setup erstellt automatisch eine Desktop-Verknuepfung mit App-Icon

## App-Icon

- Das Projekt nutzt `assets/app_icon.png` (aus deinem aktuellen Downloads-Icon)
- Beim Build wird automatisch `assets/app_icon.ico` erzeugt

Beispiel:

```bash
git tag v1.0.1
git push origin v1.0.1
```

Hinweis: Die App kann nur Links laden, die von Real-Debrid unterstuetzt werden.
