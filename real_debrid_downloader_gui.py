import json
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import webbrowser
import zipfile
from collections import deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from time import monotonic, sleep
from urllib.parse import unquote, urlparse

import requests
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

try:
    import pyzipper
except ImportError:
    pyzipper = None

API_BASE_URL = "https://api.real-debrid.com/rest/1.0"
CONFIG_FILE = Path(__file__).with_name("rd_downloader_config.json")
CHUNK_SIZE = 1024 * 512
APP_NAME = "Real-Debrid Downloader GUI"
APP_VERSION = "1.0.9"
DEFAULT_UPDATE_REPO = "Sucukdeluxe/real-debrid-downloader"
DEFAULT_RELEASE_ASSET = "Real-Debrid-Downloader-win64.zip"
REQUEST_RETRIES = 3
RETRY_BACKOFF_SECONDS = 1.2
RETRY_HTTP_STATUS = {408, 429, 500, 502, 503, 504}
INVALID_FILENAME_CHARS = '<>:"/\\|?*'
ARCHIVE_PASSWORDS = ("serienfans.org", "serienjunkies.net")
RAR_PART_RE = re.compile(r"\.part(\d+)\.rar$", re.IGNORECASE)
SEVEN_ZIP_CANDIDATES = (
    "7z",
    "7za",
    r"C:\Program Files\7-Zip\7z.exe",
    r"C:\Program Files (x86)\7-Zip\7z.exe",
)
UNRAR_CANDIDATES = (
    "unrar",
    "UnRAR.exe",
    r"C:\Program Files\WinRAR\UnRAR.exe",
    r"C:\Program Files (x86)\WinRAR\UnRAR.exe",
)


@dataclass
class ReleaseInfo:
    version: str
    tag: str
    asset_name: str
    asset_url: str
    html_url: str


@dataclass
class ExtractJob:
    key: str
    archive_path: Path
    source_files: list[Path]


def filename_from_url(url: str) -> str:
    path = urlparse(url).path
    if not path:
        return ""
    return unquote(path.rsplit("/", 1)[-1]).strip()


def _clean_package_candidate(name: str) -> tuple[str, int | None]:
    value = name
    value = re.sub(r"\.part\d+$", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\.r\d+$", "", value, flags=re.IGNORECASE)
    value = re.sub(r"[_\-]+", ".", value)
    value = re.sub(r"\.+", ".", value).strip(" .")
    if not value:
        return "", None

    season: int | None = None
    season_match = re.search(r"(?i)\bS(\d{1,2})E\d{1,3}\b", value)
    if season_match:
        season = int(season_match.group(1))

    for token_pattern in (
        r"(?i)\bS\d{1,2}E\d{1,3}\b.*$",
        r"(?i)\bS\d{1,2}\b.*$",
        r"(?i)\bStaffel\s*\d{1,2}\b.*$",
        r"(?i)\b(480p|720p|1080p|2160p|x264|x265|h264|h265|web[-_. ]?dl|web[-_. ]?rip|bluray|bdrip|german|dl|dd\d(?:\.\d)?)\b.*$",
    ):
        value = re.sub(token_pattern, "", value).strip(" .")

    tokens = [part for part in re.split(r"[._ ]+", value) if part]
    if not tokens:
        return "", season

    cleaned_tokens: list[str] = []
    for token in tokens:
        lower = token.lower()
        if re.fullmatch(r"\d{3,4}p", lower):
            continue
        if lower in {
            "web",
            "webrip",
            "webdl",
            "bluray",
            "bdrip",
            "german",
            "dl",
            "dd",
            "x264",
            "x265",
            "h264",
            "h265",
            "ac3",
            "dts",
            "aac",
        }:
            continue
        cleaned_tokens.append(token)

    if not cleaned_tokens:
        return "", season

    title = " ".join(cleaned_tokens)
    title = re.sub(r"\s+", " ", title).strip()
    title = title.title()
    return title, season


def infer_package_name_from_links(links: list[str]) -> str:
    cleaned_names: list[str] = []
    season_votes: dict[int, int] = {}

    for link in links:
        filename = filename_from_url(link)
        if not filename:
            continue

        base = filename
        lower_name = base.lower()
        for ext in (".rar", ".zip", ".7z"):
            if lower_name.endswith(ext):
                base = base[: -len(ext)]
                break

        title, season = _clean_package_candidate(base)
        if title:
            cleaned_names.append(title)
        if season is not None:
            season_votes[season] = season_votes.get(season, 0) + 1

    if not cleaned_names:
        return ""

    title_counts: dict[str, int] = {}
    for title in cleaned_names:
        title_counts[title] = title_counts.get(title, 0) + 1

    best_title = sorted(title_counts.items(), key=lambda item: (-item[1], len(item[0])))[0][0]
    if season_votes:
        best_season = sorted(season_votes.items(), key=lambda item: (-item[1], item[0]))[0][0]
        return f"{best_title} S{best_season:02d}"
    return best_title


def sanitize_filename(name: str) -> str:
    cleaned = "".join("_" if ch in INVALID_FILENAME_CHARS or ord(ch) < 32 else ch for ch in name)
    cleaned = cleaned.strip().strip(".")
    return cleaned or "download.bin"


def next_available_path(path: Path) -> Path:
    if not path.exists():
        return path

    stem = path.stem
    suffix = path.suffix
    index = 1
    while True:
        candidate = path.with_name(f"{stem} ({index}){suffix}")
        if not candidate.exists():
            return candidate
        index += 1


def parse_error_message(response: requests.Response) -> str:
    try:
        data = response.json()
        if isinstance(data, dict):
            error = data.get("error") or data.get("message")
            if error:
                return str(error)
            if "error_code" in data:
                return f"API error code: {data['error_code']}"
    except ValueError:
        pass

    text = response.text.strip()
    if text:
        return text
    return f"HTTP {response.status_code}"


def should_retry_status(status_code: int) -> bool:
    return status_code in RETRY_HTTP_STATUS


def retry_sleep(attempt: int) -> None:
    sleep(RETRY_BACKOFF_SECONDS * max(attempt, 1))


def human_size(num_bytes: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(num_bytes)
    for unit in units:
        if size < 1024.0 or unit == units[-1]:
            return f"{size:.1f} {unit}"
        size /= 1024.0
    return f"{num_bytes} B"


def normalize_version(value: str) -> str:
    version = value.strip().lower()
    if version.startswith("v"):
        version = version[1:]
    return version


def version_key(value: str) -> tuple[int, ...]:
    normalized = normalize_version(value)
    parts = [part for part in re.split(r"[^0-9]+", normalized) if part]
    if not parts:
        return (0,)
    return tuple(int(part) for part in parts)


def is_newer_version(candidate: str, current: str) -> bool:
    return version_key(candidate) > version_key(current)


def fetch_latest_release(session: requests.Session, repo: str, preferred_asset: str) -> ReleaseInfo:
    safe_repo = repo.strip().strip("/")
    if not safe_repo or "/" not in safe_repo:
        raise RuntimeError("Update-Repo muss im Format owner/name sein")

    response: requests.Response | None = None
    last_error: Exception | None = None
    for attempt in range(1, REQUEST_RETRIES + 1):
        try:
            response = session.get(f"https://api.github.com/repos/{safe_repo}/releases/latest", timeout=25)
        except requests.RequestException as exc:
            last_error = exc
            if attempt < REQUEST_RETRIES:
                retry_sleep(attempt)
                continue
            raise RuntimeError(f"GitHub Anfrage fehlgeschlagen: {exc}") from exc

        if response.ok:
            break

        if should_retry_status(response.status_code) and attempt < REQUEST_RETRIES:
            retry_sleep(attempt)
            continue

        raise RuntimeError(parse_error_message(response))

    if response is None:
        raise RuntimeError(f"GitHub Anfrage fehlgeschlagen: {last_error}")

    payload = response.json()
    assets = payload.get("assets") or []
    if not assets:
        raise RuntimeError("Release hat keine Dateien")

    chosen = None
    for asset in assets:
        if str(asset.get("name", "")).strip() == preferred_asset:
            chosen = asset
            break

    if chosen is None:
        raise RuntimeError(f"Release-Asset '{preferred_asset}' nicht gefunden")

    return ReleaseInfo(
        version=normalize_version(str(payload.get("tag_name", "0.0.0"))),
        tag=str(payload.get("tag_name", "")),
        asset_name=str(chosen.get("name", "")),
        asset_url=str(chosen.get("browser_download_url", "")),
        html_url=str(payload.get("html_url", "")),
    )


def find_executable(candidates: tuple[str, ...]) -> str | None:
    for candidate in candidates:
        candidate_path = Path(candidate)
        if candidate_path.is_file():
            return str(candidate_path)

        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    return None


def find_7zip_executable() -> str | None:
    return find_executable(SEVEN_ZIP_CANDIDATES)


def find_unrar_executable() -> str | None:
    return find_executable(UNRAR_CANDIDATES)


def merge_directory(source_dir: Path, destination_dir: Path) -> None:
    destination_dir.mkdir(parents=True, exist_ok=True)
    for item in source_dir.iterdir():
        target = destination_dir / item.name
        if target.exists():
            target = next_available_path(target)
        shutil.move(str(item), str(target))


def hidden_subprocess_kwargs() -> dict:
    if not sys.platform.startswith("win"):
        return {}

    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = 0
    return {
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0),
        "startupinfo": startup,
    }


class RealDebridClient:
    def __init__(self, token: str):
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "User-Agent": f"RD-GUI-Downloader/{APP_VERSION}",
            }
        )

    def unrestrict_link(self, link: str) -> tuple[str, str, int]:
        response: requests.Response | None = None
        retries_used = 0
        for attempt in range(1, REQUEST_RETRIES + 1):
            try:
                response = self.session.post(
                    f"{API_BASE_URL}/unrestrict/link",
                    data={"link": link},
                    timeout=45,
                )
            except requests.RequestException as exc:
                if attempt < REQUEST_RETRIES:
                    retries_used += 1
                    retry_sleep(attempt)
                    continue
                raise RuntimeError(f"Real-Debrid Anfrage fehlgeschlagen: {exc}") from exc

            if response.ok:
                break

            if should_retry_status(response.status_code) and attempt < REQUEST_RETRIES:
                retries_used += 1
                retry_sleep(attempt)
                continue

            raise RuntimeError(parse_error_message(response))

        if response is None:
            raise RuntimeError("Real-Debrid Anfrage fehlgeschlagen")

        payload = response.json()
        download_url = payload.get("download") or payload.get("link")
        if not download_url:
            raise RuntimeError("Kein direkter Download-Link in Real-Debrid Antwort gefunden")

        filename = payload.get("filename") or "download.bin"
        return filename, download_url, retries_used


class DownloaderApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"{APP_NAME} v{APP_VERSION}")
        self.geometry("1180x780")
        self.minsize(980, 680)

        self.token_var = tk.StringVar()
        self.output_dir_var = tk.StringVar(value=str(Path.home() / "Downloads" / "RealDebrid"))
        self.package_name_var = tk.StringVar(value="")
        self.auto_extract_var = tk.BooleanVar(value=True)
        self.extract_dir_var = tk.StringVar(value=str(Path.home() / "Downloads" / "RealDebrid" / "_entpackt"))
        self.create_extract_subfolder_var = tk.BooleanVar(value=True)
        self.hybrid_extract_var = tk.BooleanVar(value=True)
        self.cleanup_after_extract_var = tk.BooleanVar(value=False)
        self.max_parallel_var = tk.IntVar(value=4)
        self.speed_limit_kbps_var = tk.IntVar(value=0)
        self.speed_limit_mode_var = tk.StringVar(value="global")
        self.update_repo_var = tk.StringVar(value=DEFAULT_UPDATE_REPO)
        self.auto_update_check_var = tk.BooleanVar(value=True)
        self.show_token_var = tk.BooleanVar(value=False)
        self.remember_token_var = tk.BooleanVar(value=True)
        self.status_var = tk.StringVar(value="Bereit")
        self.speed_var = tk.StringVar(value="Geschwindigkeit: 0 B/s")
        self.overall_progress_var = tk.DoubleVar(value=0.0)

        self.worker_thread: threading.Thread | None = None
        self.seven_zip_path = find_7zip_executable()
        self.unrar_path = find_unrar_executable()
        self.stop_event = threading.Event()
        self.ui_queue: queue.Queue = queue.Queue()
        self.row_map: dict[int, str] = {}
        self.package_row_id: str | None = None
        self.speed_events: deque[tuple[float, int]] = deque()
        self.parallel_limit_lock = threading.Lock()
        self.current_parallel_limit = 4
        self.speed_limit_lock = threading.Lock()
        self.current_speed_limit_kbps = 0
        self.current_speed_limit_mode = "global"
        self.global_throttle_window_start = monotonic()
        self.global_throttle_bytes = 0
        self.path_lock = threading.Lock()
        self.reserved_target_keys: set[str] = set()
        self.update_lock = threading.Lock()
        self.update_check_running = False
        self.update_download_running = False
        self.http_session = requests.Session()
        self.http_session.headers.update({"User-Agent": f"RD-GUI-Downloader/{APP_VERSION}"})

        self._build_ui()
        self._load_config()
        self.max_parallel_var.trace_add("write", self._on_parallel_spinbox_change)
        self.speed_limit_kbps_var.trace_add("write", self._on_speed_limit_change)
        self.speed_limit_mode_var.trace_add("write", self._on_speed_mode_change)
        self._sync_parallel_limit(self.max_parallel_var.get())
        self._sync_speed_limit(self.speed_limit_kbps_var.get(), self.speed_limit_mode_var.get())
        self.after(100, self._process_ui_queue)
        self.after(1500, self._auto_check_updates)

    def destroy(self) -> None:
        try:
            self.http_session.close()
        except Exception:
            pass
        super().destroy()

    def _build_ui(self) -> None:
        root = ttk.Frame(self, padding=12)
        root.pack(fill="both", expand=True)

        root.columnconfigure(0, weight=1)
        root.rowconfigure(2, weight=3)
        root.rowconfigure(4, weight=2)

        token_frame = ttk.LabelFrame(root, text="Authentifizierung", padding=10)
        token_frame.grid(row=0, column=0, sticky="ew")
        token_frame.columnconfigure(1, weight=1)

        ttk.Label(token_frame, text="Real-Debrid API Token:").grid(row=0, column=0, sticky="w", padx=(0, 8))
        self.token_entry = ttk.Entry(token_frame, textvariable=self.token_var, show="*", width=80)
        self.token_entry.grid(row=0, column=1, sticky="ew", padx=(0, 8))

        ttk.Checkbutton(
            token_frame,
            text="Token anzeigen",
            variable=self.show_token_var,
            command=self._toggle_token_visibility,
        ).grid(row=0, column=2, sticky="w")

        ttk.Checkbutton(
            token_frame,
            text="Token lokal speichern",
            variable=self.remember_token_var,
        ).grid(row=1, column=1, sticky="w", pady=(8, 0))

        ttk.Label(token_frame, text="GitHub Repo (owner/name):").grid(row=2, column=0, sticky="w", padx=(0, 8), pady=(8, 0))
        ttk.Entry(token_frame, textvariable=self.update_repo_var).grid(row=2, column=1, sticky="ew", padx=(0, 8), pady=(8, 0))
        ttk.Button(token_frame, text="Update suchen", command=self._manual_check_updates).grid(row=2, column=2, sticky="w", pady=(8, 0))

        ttk.Checkbutton(
            token_frame,
            text="Beim Start auf Updates pruefen",
            variable=self.auto_update_check_var,
        ).grid(row=3, column=1, sticky="w", pady=(6, 0))

        output_frame = ttk.LabelFrame(root, text="Paket / Zielordner", padding=10)
        output_frame.grid(row=1, column=0, sticky="ew", pady=(10, 0))
        output_frame.columnconfigure(1, weight=1)

        ttk.Label(output_frame, text="Download-Ordner:").grid(row=0, column=0, sticky="w", padx=(0, 8))
        ttk.Entry(output_frame, textvariable=self.output_dir_var).grid(row=0, column=1, sticky="ew", padx=(0, 8))
        ttk.Button(output_frame, text="Ordner waehlen", command=self._browse_output_dir).grid(row=0, column=2)

        ttk.Label(output_frame, text="Paketname (optional):").grid(row=1, column=0, sticky="w", padx=(0, 8), pady=(8, 0))
        ttk.Entry(output_frame, textvariable=self.package_name_var).grid(
            row=1,
            column=1,
            columnspan=2,
            sticky="ew",
            pady=(8, 0),
        )

        ttk.Checkbutton(
            output_frame,
            text="Nach Download automatisch entpacken",
            variable=self.auto_extract_var,
        ).grid(row=2, column=0, columnspan=3, sticky="w", pady=(8, 0))

        ttk.Label(output_frame, text="Entpacken nach:").grid(row=3, column=0, sticky="w", padx=(0, 8), pady=(8, 0))
        ttk.Entry(output_frame, textvariable=self.extract_dir_var).grid(row=3, column=1, sticky="ew", padx=(0, 8), pady=(8, 0))
        ttk.Button(output_frame, text="Ordner waehlen", command=self._browse_extract_dir).grid(row=3, column=2, pady=(8, 0))

        ttk.Checkbutton(
            output_frame,
            text="Unterordner erstellen (Paketname)",
            variable=self.create_extract_subfolder_var,
        ).grid(row=4, column=0, columnspan=3, sticky="w", pady=(6, 0))

        ttk.Checkbutton(
            output_frame,
            text="Hybrid-Entpacken (sobald Parts komplett)",
            variable=self.hybrid_extract_var,
        ).grid(row=5, column=0, columnspan=3, sticky="w", pady=(6, 0))

        ttk.Checkbutton(
            output_frame,
            text="Archive nach erfolgreichem Entpacken loeschen",
            variable=self.cleanup_after_extract_var,
        ).grid(row=6, column=0, columnspan=3, sticky="w", pady=(6, 0))

        ttk.Label(
            output_frame,
            text="Auto-Passwoerter: serienfans.org, serienjunkies.net",
        ).grid(row=7, column=0, columnspan=3, sticky="w", pady=(6, 0))

        links_frame = ttk.LabelFrame(root, text="Links (ein Link pro Zeile)", padding=10)
        links_frame.grid(row=2, column=0, sticky="nsew", pady=(10, 0))
        links_frame.columnconfigure(0, weight=1)
        links_frame.rowconfigure(0, weight=1)
        self.links_text = tk.Text(links_frame, height=14, wrap="none")
        self.links_text.grid(row=0, column=0, sticky="nsew")
        links_scroll = ttk.Scrollbar(links_frame, orient="vertical", command=self.links_text.yview)
        links_scroll.grid(row=0, column=1, sticky="ns")
        self.links_text.configure(yscrollcommand=links_scroll.set)

        actions_frame = ttk.Frame(root)
        actions_frame.grid(row=3, column=0, sticky="ew", pady=(10, 0))

        self.start_button = ttk.Button(actions_frame, text="Download starten", command=self.start_downloads)
        self.start_button.pack(side="left")

        self.stop_button = ttk.Button(actions_frame, text="Stop", command=self.stop_downloads, state="disabled")
        self.stop_button.pack(side="left", padx=(8, 0))

        ttk.Button(actions_frame, text="Links leeren", command=self._clear_all_lists).pack(side="left", padx=(8, 0))
        ttk.Button(actions_frame, text="Links laden", command=self._load_links_from_file).pack(side="left", padx=(8, 0))
        ttk.Button(actions_frame, text="Links speichern", command=self._save_links_to_file).pack(side="left", padx=(8, 0))

        ttk.Label(actions_frame, text="Parallel:").pack(side="left", padx=(18, 6))
        ttk.Spinbox(actions_frame, from_=1, to=50, width=5, textvariable=self.max_parallel_var).pack(side="left")

        ttk.Label(actions_frame, text="Speed-Limit:").pack(side="left", padx=(18, 6))
        ttk.Spinbox(actions_frame, from_=0, to=500000, width=8, textvariable=self.speed_limit_kbps_var).pack(side="left")
        ttk.Label(actions_frame, text="KB/s").pack(side="left", padx=(4, 8))
        speed_mode_box = ttk.Combobox(
            actions_frame,
            textvariable=self.speed_limit_mode_var,
            values=("global", "per_download"),
            width=12,
            state="readonly",
        )
        speed_mode_box.pack(side="left")

        table_frame = ttk.LabelFrame(root, text="Fortschritt pro Link", padding=10)
        table_frame.grid(row=4, column=0, sticky="nsew", pady=(10, 0))
        table_frame.columnconfigure(0, weight=1)
        table_frame.rowconfigure(0, weight=1)

        columns = ("file", "status", "progress", "speed", "retries")
        self.table = ttk.Treeview(table_frame, columns=columns, show="tree headings")
        self.table.heading("#0", text="Paket / Link")
        self.table.heading("file", text="Datei")
        self.table.heading("status", text="Status")
        self.table.heading("progress", text="Progress")
        self.table.heading("speed", text="Speed")
        self.table.heading("retries", text="Retries")

        self.table.column("#0", width=400, anchor="w")
        self.table.column("file", width=250, anchor="w")
        self.table.column("status", width=250, anchor="w")
        self.table.column("progress", width=90, anchor="center")
        self.table.column("speed", width=90, anchor="center")
        self.table.column("retries", width=80, anchor="center")

        self.table.grid(row=0, column=0, sticky="nsew")
        table_scroll = ttk.Scrollbar(table_frame, orient="vertical", command=self.table.yview)
        table_scroll.grid(row=0, column=1, sticky="ns")
        self.table.configure(yscrollcommand=table_scroll.set)
        self.table.bind("<Delete>", self._on_table_delete_key)
        self.table.bind("<Button-3>", self._on_table_right_click)

        self.table_context_menu = tk.Menu(self, tearoff=0)
        self.table_context_menu.add_command(label="Aus Fortschritt loeschen", command=self._remove_selected_progress_rows)
        self.table_context_menu.add_command(label="Fortschritt komplett leeren", command=self._clear_progress_only)
        self.table_context_menu.add_separator()
        self.table_context_menu.add_command(label="Links komplett leeren", command=self._clear_links)
        self.table_context_menu.add_command(label="Alles leeren", command=self._clear_all_lists)

        footer = ttk.Frame(root)
        footer.grid(row=5, column=0, sticky="ew", pady=(10, 0))
        footer.columnconfigure(0, weight=1)

        ttk.Progressbar(
            footer,
            variable=self.overall_progress_var,
            maximum=100,
            mode="determinate",
        ).grid(row=0, column=0, sticky="ew")
        ttk.Label(footer, textvariable=self.status_var).grid(row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Label(footer, textvariable=self.speed_var).grid(row=2, column=0, sticky="w", pady=(4, 0))

    def _toggle_token_visibility(self) -> None:
        self.token_entry.configure(show="" if self.show_token_var.get() else "*")

    def _browse_output_dir(self) -> None:
        selected = filedialog.askdirectory(initialdir=self.output_dir_var.get() or str(Path.home()))
        if selected:
            self.output_dir_var.set(selected)

    def _browse_extract_dir(self) -> None:
        selected = filedialog.askdirectory(initialdir=self.extract_dir_var.get() or self.output_dir_var.get() or str(Path.home()))
        if selected:
            self.extract_dir_var.set(selected)

    def _clear_links(self) -> None:
        self.links_text.delete("1.0", "end")

    def _clear_progress_only(self) -> None:
        if self.worker_thread and self.worker_thread.is_alive():
            messagebox.showinfo("Hinweis", "Fortschritt kann waehrend Downloads nicht geloescht werden")
            return
        self._clear_progress_view()
        self.speed_events.clear()
        self.speed_var.set("Geschwindigkeit: 0 B/s")
        self.status_var.set("Bereit")
        self.overall_progress_var.set(0.0)

    def _clear_all_lists(self) -> None:
        self._clear_links()
        self._clear_progress_only()

    def _clear_progress_view(self) -> None:
        self.table.delete(*self.table.get_children())
        self.row_map.clear()
        self.package_row_id = None

    def _set_links_text_lines(self, lines: list[str]) -> None:
        content = "\n".join(line for line in lines if line.strip())
        if content:
            content += "\n"
        self.links_text.delete("1.0", "end")
        self.links_text.insert("1.0", content)

    def _on_table_delete_key(self, _event: tk.Event) -> str:
        self._remove_selected_progress_rows()
        return "break"

    def _on_table_right_click(self, event: tk.Event) -> None:
        row_id = self.table.identify_row(event.y)
        if row_id:
            if row_id not in self.table.selection():
                self.table.selection_set(row_id)
        else:
            self.table.selection_remove(self.table.selection())
        try:
            self.table_context_menu.tk_popup(event.x_root, event.y_root)
        finally:
            self.table_context_menu.grab_release()

    def _remove_selected_progress_rows(self) -> None:
        if self.worker_thread and self.worker_thread.is_alive():
            messagebox.showinfo("Hinweis", "Loeschen aus dem Fortschritt nur im Leerlauf moeglich")
            return

        selected = list(self.table.selection())
        if not selected:
            return

        if self.package_row_id and self.package_row_id in selected:
            self._clear_all_lists()
            return

        links_to_remove: list[str] = []
        row_ids_to_remove = set(selected)
        for row_id in selected:
            if self.package_row_id and self.table.parent(row_id) == self.package_row_id:
                link_text = str(self.table.item(row_id, "text")).strip()
                if link_text:
                    links_to_remove.append(link_text)

        for row_id in row_ids_to_remove:
            if self.table.exists(row_id):
                self.table.delete(row_id)

        if links_to_remove:
            lines = [line.strip() for line in self.links_text.get("1.0", "end").splitlines() if line.strip()]
            for link in links_to_remove:
                if link in lines:
                    lines.remove(link)
            self._set_links_text_lines(lines)

        for index, mapped_row_id in list(self.row_map.items()):
            if mapped_row_id in row_ids_to_remove:
                self.row_map.pop(index, None)

        if self.package_row_id and self.table.exists(self.package_row_id):
            if not self.table.get_children(self.package_row_id):
                self.table.delete(self.package_row_id)
                self.package_row_id = None

    def _load_links_from_file(self) -> None:
        file_path = filedialog.askopenfilename(
            title="Linkliste laden",
            filetypes=(("Textdatei", "*.txt"), ("Alle Dateien", "*.*")),
        )
        if not file_path:
            return

        path = Path(file_path)
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            text = path.read_text(encoding="latin-1")
        except Exception as exc:
            messagebox.showerror("Fehler", f"Konnte Linkliste nicht laden: {exc}")
            return

        self.links_text.delete("1.0", "end")
        self.links_text.insert("1.0", text)

        if not self.package_name_var.get().strip():
            inferred = sanitize_filename(path.stem)
            if inferred:
                self.package_name_var.set(inferred)

    def _save_links_to_file(self) -> None:
        raw_links = self.links_text.get("1.0", "end")
        links = [line.strip() for line in raw_links.splitlines() if line.strip()]
        if not links:
            messagebox.showerror("Fehler", "Es sind keine Links zum Speichern vorhanden")
            return

        default_name = sanitize_filename(self.package_name_var.get().strip() or "linkliste") + ".txt"
        file_path = filedialog.asksaveasfilename(
            title="Linkliste speichern",
            defaultextension=".txt",
            initialfile=default_name,
            filetypes=(("Textdatei", "*.txt"), ("Alle Dateien", "*.*")),
        )
        if not file_path:
            return

        try:
            Path(file_path).write_text("\n".join(links) + "\n", encoding="utf-8")
        except Exception as exc:
            messagebox.showerror("Fehler", f"Konnte Linkliste nicht speichern: {exc}")

    @staticmethod
    def _normalize_parallel_value(value: int) -> int:
        return max(1, min(int(value), 50))

    @staticmethod
    def _normalize_speed_limit_value(value: int) -> int:
        return max(0, min(int(value), 500000))

    @staticmethod
    def _normalize_speed_mode(value: str) -> str:
        mode = str(value or "global").strip().lower()
        return mode if mode in {"global", "per_download"} else "global"

    def _sync_parallel_limit(self, value: int) -> None:
        normalized = self._normalize_parallel_value(value)
        with self.parallel_limit_lock:
            self.current_parallel_limit = normalized

    def _sync_speed_limit(self, kbps: int, mode: str) -> None:
        normalized_kbps = self._normalize_speed_limit_value(kbps)
        normalized_mode = self._normalize_speed_mode(mode)
        with self.speed_limit_lock:
            self.current_speed_limit_kbps = normalized_kbps
            self.current_speed_limit_mode = normalized_mode
            self.global_throttle_window_start = monotonic()
            self.global_throttle_bytes = 0

    def _active_speed_limit(self) -> tuple[int, str]:
        with self.speed_limit_lock:
            return self.current_speed_limit_kbps, self.current_speed_limit_mode

    def _active_parallel_limit(self, total_links: int) -> int:
        with self.parallel_limit_lock:
            current = self.current_parallel_limit
        return max(1, min(current, 50, max(total_links, 1)))

    def _on_parallel_spinbox_change(self, *_: object) -> None:
        try:
            raw_value = int(self.max_parallel_var.get())
        except Exception:
            return

        normalized = self._normalize_parallel_value(raw_value)
        if raw_value != normalized:
            self.max_parallel_var.set(normalized)
            return

        self._sync_parallel_limit(normalized)
        if self.worker_thread and self.worker_thread.is_alive():
            self._queue_status(f"Parallel live angepasst: {normalized}")

    def _on_speed_limit_change(self, *_: object) -> None:
        try:
            raw_value = int(self.speed_limit_kbps_var.get())
        except Exception:
            return

        normalized = self._normalize_speed_limit_value(raw_value)
        if raw_value != normalized:
            self.speed_limit_kbps_var.set(normalized)
            return

        mode = self._normalize_speed_mode(self.speed_limit_mode_var.get())
        self._sync_speed_limit(normalized, mode)
        if self.worker_thread and self.worker_thread.is_alive():
            self._queue_status(f"Speed-Limit live angepasst: {normalized} KB/s ({mode})")

    def _on_speed_mode_change(self, *_: object) -> None:
        mode = self._normalize_speed_mode(self.speed_limit_mode_var.get())
        if mode != self.speed_limit_mode_var.get():
            self.speed_limit_mode_var.set(mode)
            return

        kbps = self._normalize_speed_limit_value(self.speed_limit_kbps_var.get())
        self._sync_speed_limit(kbps, mode)
        if self.worker_thread and self.worker_thread.is_alive():
            self._queue_status(f"Speed-Modus live angepasst: {mode}")

    def _auto_check_updates(self) -> None:
        if self.auto_update_check_var.get():
            self._start_update_check(manual=False)

    def _manual_check_updates(self) -> None:
        self._start_update_check(manual=True)

    def _start_update_check(self, manual: bool) -> None:
        repo = self.update_repo_var.get().strip()
        with self.update_lock:
            if self.update_check_running:
                if manual:
                    messagebox.showinfo("Update", "Update-Pruefung laeuft bereits")
                return
            self.update_check_running = True

        thread = threading.Thread(target=self._update_check_worker, args=(repo, manual), daemon=True)
        thread.start()

    def _update_check_worker(self, repo: str, manual: bool) -> None:
        if not repo:
            if manual:
                self.ui_queue.put(("update_error", "Bitte zuerst GitHub Repo (owner/name) eintragen"))
            self.ui_queue.put(("update_done",))
            return

        try:
            release = fetch_latest_release(self.http_session, repo, DEFAULT_RELEASE_ASSET)
            if not release.asset_url:
                raise RuntimeError("Release Asset ohne Download-URL")

            if is_newer_version(release.version, APP_VERSION):
                self.ui_queue.put(("update_available", release, manual))
            elif manual:
                self.ui_queue.put(("update_none", release.version))
        except Exception as exc:
            if manual:
                self.ui_queue.put(("update_error", str(exc)))
        finally:
            self.ui_queue.put(("update_done",))

    def _start_update_download(self, release: ReleaseInfo) -> None:
        with self.update_lock:
            if self.update_download_running:
                self.ui_queue.put(("update_error", "Update-Download laeuft bereits"))
                return
            self.update_download_running = True
        thread = threading.Thread(target=self._update_download_worker, args=(release,), daemon=True)
        thread.start()

    def _update_download_worker(self, release: ReleaseInfo) -> None:
        try:
            self.ui_queue.put(("status", f"Lade Update {release.tag or release.version} ..."))
            with tempfile.TemporaryDirectory(prefix="rd_updater_") as tmp_dir:
                zip_path = Path(tmp_dir) / release.asset_name
                self._download_update_file(release.asset_url, zip_path)
                self.ui_queue.put(("status", "Update heruntergeladen, installiere ..."))
                self._install_update_from_zip(zip_path)
        except Exception as exc:
            self.ui_queue.put(("update_error", f"Update fehlgeschlagen: {exc}"))
        finally:
            self.ui_queue.put(("update_download_done",))

    def _download_update_file(self, url: str, destination: Path) -> None:
        last_error: Exception | None = None
        for attempt in range(1, REQUEST_RETRIES + 1):
            response: requests.Response | None = None
            try:
                response = self.http_session.get(url, stream=True, timeout=(25, 300))
            except requests.RequestException as exc:
                last_error = exc
                if attempt < REQUEST_RETRIES:
                    retry_sleep(attempt)
                    continue
                raise RuntimeError(f"Update Download fehlgeschlagen: {exc}") from exc

            if not response.ok:
                error_text = parse_error_message(response)
                if should_retry_status(response.status_code) and attempt < REQUEST_RETRIES:
                    response.close()
                    retry_sleep(attempt)
                    continue
                response.close()
                raise RuntimeError(error_text)

            total_size = int(response.headers.get("content-length", "0") or 0)
            downloaded = 0
            last_percent = -1
            try:
                with response, destination.open("wb") as out_file:
                    for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
                        if not chunk:
                            continue
                        out_file.write(chunk)
                        downloaded += len(chunk)
                        if total_size > 0:
                            percent = int((downloaded * 100) / total_size)
                            if percent != last_percent:
                                last_percent = percent
                                self.ui_queue.put(("status", f"Update Download: {percent}%"))
                return
            except requests.RequestException as exc:
                last_error = exc
                destination.unlink(missing_ok=True)
                if attempt < REQUEST_RETRIES:
                    retry_sleep(attempt)
                    continue
                raise RuntimeError(f"Update Download fehlgeschlagen: {exc}") from exc

        raise RuntimeError(f"Update Download fehlgeschlagen: {last_error}")

    def _install_update_from_zip(self, zip_path: Path) -> None:
        if not getattr(sys, "frozen", False):
            self.ui_queue.put(("update_error", "Auto-Install geht nur in der .exe. Bitte lokal neu builden."))
            return

        current_exe = Path(sys.executable).resolve()
        app_dir = current_exe.parent
        staging_dir = app_dir / "_update_staging"
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        staging_dir.mkdir(parents=True, exist_ok=True)

        with zipfile.ZipFile(zip_path, "r") as archive:
            archive.extractall(staging_dir)

        inner_items = list(staging_dir.iterdir())
        source_dir = staging_dir
        if len(inner_items) == 1 and inner_items[0].is_dir():
            source_dir = inner_items[0]

        update_script = app_dir / "apply_update.cmd"
        script_content = self._build_update_script(source_dir, staging_dir, app_dir, current_exe.name)
        update_script.write_text(script_content, encoding="utf-8")

        subprocess.Popen([str(update_script)], cwd=str(app_dir), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.after(250, self.destroy)

    @staticmethod
    def _build_update_script(source_dir: Path, staging_dir: Path, app_dir: Path, exe_name: str) -> str:
        source_escaped = str(source_dir)
        staging_escaped = str(staging_dir)
        app_dir_escaped = str(app_dir)
        exe_escaped = str(app_dir / exe_name)
        return (
            "@echo off\n"
            "setlocal\n"
            "timeout /t 2 /nobreak >nul\n"
            f"xcopy /E /I /Y \"{source_escaped}\\*\" \"{app_dir_escaped}\\\" >nul\n"
            f"start \"\" \"{exe_escaped}\"\n"
            f"rmdir /S /Q \"{staging_escaped}\" >nul 2>nul\n"
            "del /Q \"%~f0\"\n"
        )

    def _load_config(self) -> None:
        if not CONFIG_FILE.exists():
            return

        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            return

        self.output_dir_var.set(data.get("output_dir", self.output_dir_var.get()))
        self.package_name_var.set(data.get("package_name", ""))
        self.auto_extract_var.set(bool(data.get("auto_extract", True)))
        self.extract_dir_var.set(data.get("extract_dir", self.extract_dir_var.get()))
        self.create_extract_subfolder_var.set(bool(data.get("create_extract_subfolder", True)))
        self.hybrid_extract_var.set(bool(data.get("hybrid_extract", True)))
        self.cleanup_after_extract_var.set(bool(data.get("cleanup_after_extract", False)))
        try:
            max_parallel = int(data.get("max_parallel", self.max_parallel_var.get()))
        except Exception:
            max_parallel = self.max_parallel_var.get()
        self.max_parallel_var.set(max(1, min(max_parallel, 50)))

        try:
            speed_limit = int(data.get("speed_limit_kbps", self.speed_limit_kbps_var.get()))
        except Exception:
            speed_limit = self.speed_limit_kbps_var.get()
        self.speed_limit_kbps_var.set(self._normalize_speed_limit_value(speed_limit))
        self.speed_limit_mode_var.set(self._normalize_speed_mode(str(data.get("speed_limit_mode", "global"))))

        update_repo = str(data.get("update_repo", DEFAULT_UPDATE_REPO)).strip() or DEFAULT_UPDATE_REPO
        self.update_repo_var.set(update_repo)
        self.auto_update_check_var.set(bool(data.get("auto_update_check", True)))
        remember_token = bool(data.get("remember_token", True))
        self.remember_token_var.set(remember_token)
        if remember_token:
            self.token_var.set(data.get("token", ""))

    def _save_config(self) -> None:
        token = self.token_var.get().strip() if self.remember_token_var.get() else ""
        data = {
            "token": token,
            "remember_token": self.remember_token_var.get(),
            "output_dir": self.output_dir_var.get().strip(),
            "package_name": self.package_name_var.get().strip(),
            "auto_extract": self.auto_extract_var.get(),
            "extract_dir": self.extract_dir_var.get().strip(),
            "create_extract_subfolder": self.create_extract_subfolder_var.get(),
            "hybrid_extract": self.hybrid_extract_var.get(),
            "cleanup_after_extract": self.cleanup_after_extract_var.get(),
            "max_parallel": self.max_parallel_var.get(),
            "speed_limit_kbps": self.speed_limit_kbps_var.get(),
            "speed_limit_mode": self.speed_limit_mode_var.get(),
            "update_repo": self.update_repo_var.get().strip(),
            "auto_update_check": self.auto_update_check_var.get(),
        }
        CONFIG_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")

    @staticmethod
    def _path_key(path: Path) -> str:
        return str(path).lower()

    def _reserve_download_target(self, package_dir: Path, filename: str) -> Path:
        base_path = package_dir / sanitize_filename(filename)
        with self.path_lock:
            candidate = base_path
            index = 1
            while candidate.exists() or self._path_key(candidate) in self.reserved_target_keys:
                candidate = base_path.with_name(f"{base_path.stem} ({index}){base_path.suffix}")
                index += 1

            self.reserved_target_keys.add(self._path_key(candidate))
            return candidate

    def _release_reserved_target(self, target_path: Path) -> None:
        with self.path_lock:
            self.reserved_target_keys.discard(self._path_key(target_path))

    def start_downloads(self) -> None:
        if self.worker_thread and self.worker_thread.is_alive():
            return

        token = self.token_var.get().strip()
        if not token:
            messagebox.showerror("Fehler", "Bitte deinen Real-Debrid API Token eintragen")
            return

        output_dir_raw = self.output_dir_var.get().strip()
        if not output_dir_raw:
            messagebox.showerror("Fehler", "Bitte einen Zielordner auswaehlen")
            return
        output_dir = Path(output_dir_raw)

        raw_links = self.links_text.get("1.0", "end")
        links = [line.strip() for line in raw_links.splitlines() if line.strip()]
        if not links:
            messagebox.showerror("Fehler", "Bitte mindestens einen Link eintragen")
            return

        try:
            parallel_raw = int(self.max_parallel_var.get())
        except Exception:
            parallel_raw = 4
        max_parallel = min(self._normalize_parallel_value(parallel_raw), len(links))
        self.max_parallel_var.set(max_parallel)
        self._sync_parallel_limit(max_parallel)

        speed_limit = self._normalize_speed_limit_value(self.speed_limit_kbps_var.get())
        speed_mode = self._normalize_speed_mode(self.speed_limit_mode_var.get())
        self.speed_limit_kbps_var.set(speed_limit)
        self.speed_limit_mode_var.set(speed_mode)
        self._sync_speed_limit(speed_limit, speed_mode)

        detected_package = infer_package_name_from_links(links)
        package_name_raw = self.package_name_var.get().strip() or detected_package or f"Paket-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        package_name = sanitize_filename(package_name_raw)
        if not self.package_name_var.get().strip() and detected_package:
            self.package_name_var.set(package_name)
        package_dir = next_available_path(output_dir / package_name)

        extract_target_dir: Path | None = None
        hybrid_extract = False
        cleanup_after_extract = False
        if self.auto_extract_var.get():
            extract_root_raw = self.extract_dir_var.get().strip()
            extract_root = Path(extract_root_raw) if extract_root_raw else (output_dir / "_entpackt")
            if self.create_extract_subfolder_var.get():
                extract_target_dir = next_available_path(extract_root / package_dir.name)
            else:
                extract_target_dir = extract_root
            hybrid_extract = bool(self.hybrid_extract_var.get())
            cleanup_after_extract = bool(self.cleanup_after_extract_var.get())

        try:
            output_dir.mkdir(parents=True, exist_ok=True)
            package_dir.mkdir(parents=True, exist_ok=True)
            if extract_target_dir:
                extract_target_dir.mkdir(parents=True, exist_ok=True)
            self._save_config()
        except Exception as exc:
            messagebox.showerror("Fehler", f"Konnte Zielordner nicht verwenden: {exc}")
            return

        self.table.delete(*self.table.get_children())
        self.row_map.clear()
        self.package_row_id = "package-row"
        with self.path_lock:
            self.reserved_target_keys.clear()
        with self.speed_limit_lock:
            self.global_throttle_window_start = monotonic()
            self.global_throttle_bytes = 0
        self.speed_events.clear()
        self.speed_var.set("Geschwindigkeit: 0 B/s")

        self.table.insert(
            "",
            "end",
            iid=self.package_row_id,
            text=package_dir.name,
            values=("-", "Wartet", f"0/{len(links)}", "0 B/s", "0"),
            open=True,
        )
        for index, link in enumerate(links, start=1):
            row_id = f"row-{index}"
            self.row_map[index] = row_id
            self.table.insert(
                self.package_row_id,
                "end",
                iid=row_id,
                text=link,
                values=("-", "Wartet", "0%", "0 B/s", "0"),
            )

        self.overall_progress_var.set(0.0)
        self.status_var.set(
            f"Starte Paket '{package_dir.name}' mit {len(links)} Link(s), parallel: {max_parallel}"
        )
        self.stop_event.clear()
        self.start_button.configure(state="disabled")
        self.stop_button.configure(state="normal")

        self.worker_thread = threading.Thread(
            target=self._download_worker,
            args=(token, package_dir, links, extract_target_dir, max_parallel, hybrid_extract, cleanup_after_extract),
            daemon=True,
        )
        self.worker_thread.start()

    def stop_downloads(self) -> None:
        if self.worker_thread and self.worker_thread.is_alive():
            self.stop_event.set()
            self.status_var.set("Stop angefordert...")

    def _download_worker(
        self,
        token: str,
        package_dir: Path,
        links: list[str],
        extract_target_dir: Path | None,
        initial_parallel: int,
        hybrid_extract: bool,
        cleanup_after_extract: bool,
    ) -> None:
        self._sync_parallel_limit(initial_parallel)
        total = len(links)
        processed = 0
        success = 0
        failed = 0
        extracted = 0
        downloaded_files: list[Path] = []
        extracted_job_keys: set[str] = set()

        pending_links: deque[tuple[int, str]] = deque((index, link) for index, link in enumerate(links, start=1))
        running_futures: dict = {}
        with ThreadPoolExecutor(max_workers=max(1, min(50, total))) as executor:
            while (pending_links or running_futures) and not self.stop_event.is_set():
                desired_parallel = self._active_parallel_limit(total)

                while pending_links and len(running_futures) < desired_parallel and not self.stop_event.is_set():
                    index, link = pending_links.popleft()
                    future = executor.submit(self._download_single_link, token, package_dir, index, link)
                    running_futures[future] = index

                if not running_futures:
                    sleep(0.1)
                    continue

                done, _ = wait(tuple(running_futures.keys()), timeout=0.3, return_when=FIRST_COMPLETED)
                if not done:
                    continue

                for future in done:
                    index = running_futures.pop(future)
                    if self.stop_event.is_set():
                        break

                    try:
                        target_path = future.result()
                        if target_path is not None:
                            downloaded_files.append(target_path)
                            success += 1
                            if extract_target_dir and hybrid_extract:
                                add_extracted, add_failed = self._extract_ready_archives(
                                    downloaded_files,
                                    extract_target_dir,
                                    extracted_job_keys,
                                    strict_complete=False,
                                    cleanup_after_extract=cleanup_after_extract,
                                )
                                extracted += add_extracted
                                failed += add_failed
                        else:
                            failed += 1
                    except InterruptedError:
                        self._queue_row(index, status="Gestoppt", progress="-", speed="0 B/s", retries="-")
                        self.stop_event.set()
                        break
                    except Exception as exc:
                        self._queue_row(index, status=f"Fehler: {exc}", progress="-", speed="0 B/s", retries="-")
                        failed += 1
                    finally:
                        processed += 1
                        self._queue_overall(processed, total)
                        self._queue_package(
                            status=f"Laufend: {success} ok, {failed} fehler",
                            progress=f"{processed}/{total}",
                        )

            if self.stop_event.is_set():
                for pending_future in running_futures:
                    pending_future.cancel()

        extract_failed = 0
        if not self.stop_event.is_set() and extract_target_dir and downloaded_files:
            self._queue_status("Downloads fertig, starte Entpacken...")
            try:
                add_extracted, extract_failed = self._extract_ready_archives(
                    downloaded_files,
                    extract_target_dir,
                    extracted_job_keys,
                    strict_complete=True,
                    cleanup_after_extract=cleanup_after_extract,
                )
                extracted += add_extracted
                failed += extract_failed
            except InterruptedError:
                self.stop_event.set()

        if self.stop_event.is_set():
            self._queue_status(f"Gestoppt. Fertig: {success}, Fehler: {failed}")
            self._queue_package(status="Gestoppt", progress=f"{processed}/{total}")
        else:
            self._queue_overall(processed, total)
            if extract_target_dir:
                self._queue_status(
                    f"Abgeschlossen. Fertig: {success}, Fehler: {failed}, Entpackt: {extracted}. Ziel: {extract_target_dir}"
                )
                self._queue_package(status=f"Fertig: {success} ok, {failed} fehler, {extracted} entpackt", progress=f"{processed}/{total}")
            else:
                self._queue_status(f"Abgeschlossen. Fertig: {success}, Fehler: {failed}")
                self._queue_package(status=f"Fertig: {success} ok, {failed} fehler", progress=f"{processed}/{total}")

        self.ui_queue.put(("controls", False))

    def _download_single_link(self, token: str, package_dir: Path, index: int, link: str) -> Path | None:
        if self.stop_event.is_set():
            raise InterruptedError("Download wurde gestoppt")

        client = RealDebridClient(token)
        target_path: Path | None = None
        try:
            self._queue_row(index, status="Link wird via Real-Debrid umgewandelt", progress="0%", speed="0 B/s", retries="0")
            filename, direct_url, unrestrict_retries = client.unrestrict_link(link)
            target_path = self._reserve_download_target(package_dir, filename)

            self._queue_row(
                index,
                file=target_path.name,
                status="Download laeuft",
                progress="0%",
                speed="0 B/s",
                retries=str(unrestrict_retries),
            )
            download_retries = self._stream_download(client.session, direct_url, target_path, index)
            total_retries = unrestrict_retries + download_retries
            self._queue_row(
                index,
                status=f"Fertig ({human_size(target_path.stat().st_size)})",
                progress="100%",
                speed="0 B/s",
                retries=str(total_retries),
            )
            return target_path
        finally:
            client.session.close()
            if target_path is not None:
                self._release_reserved_target(target_path)

    def _extract_ready_archives(
        self,
        downloaded_files: list[Path],
        extract_target_dir: Path,
        extracted_job_keys: set[str],
        strict_complete: bool,
        cleanup_after_extract: bool,
    ) -> tuple[int, int]:
        jobs, skipped_reason_count = self._collect_extract_jobs(downloaded_files, strict_complete)
        pending_jobs = [job for job in jobs if job.key not in extracted_job_keys]
        if not pending_jobs:
            return 0, skipped_reason_count

        has_rar = any(job.archive_path.suffix.lower() == ".rar" for job in pending_jobs)
        has_7z = any(job.archive_path.suffix.lower() == ".7z" for job in pending_jobs)

        if has_7z and not self.seven_zip_path:
            self._queue_status("7Z gefunden, aber 7-Zip fehlt. Bitte 7-Zip installieren.")
            return 0, len([job for job in pending_jobs if job.archive_path.suffix.lower() == ".7z"]) + skipped_reason_count

        if has_rar and not (self.seven_zip_path or self.unrar_path):
            self._queue_status("RAR gefunden, aber weder 7-Zip noch WinRAR UnRAR.exe gefunden.")
            return 0, len([job for job in pending_jobs if job.archive_path.suffix.lower() == ".rar"]) + skipped_reason_count

        extracted = 0
        failed = skipped_reason_count
        for job in pending_jobs:
            if self.stop_event.is_set():
                raise InterruptedError("Entpacken wurde gestoppt")

            self._queue_status(f"Entpacke {job.archive_path.name} ...")
            try:
                used_password = self._extract_archive(job.archive_path, extract_target_dir)
                extracted_job_keys.add(job.key)
                if cleanup_after_extract:
                    self._cleanup_archive_sources(job.source_files)
                if used_password:
                    self._queue_status(f"Entpackt: {job.archive_path.name} (Passwort: {used_password})")
                else:
                    self._queue_status(f"Entpackt: {job.archive_path.name}")
                extracted += 1
            except Exception as exc:
                failed += 1
                self._queue_status(f"Entpack-Fehler bei {job.archive_path.name}: {exc}")

        return extracted, failed

    def _cleanup_archive_sources(self, source_files: list[Path]) -> None:
        deleted = 0
        for file_path in source_files:
            try:
                if file_path.exists():
                    file_path.unlink(missing_ok=True)
                    deleted += 1
            except Exception:
                continue
        if deleted:
            self._queue_status(f"Cleanup: {deleted} Archivdatei(en) geloescht")

    def _collect_extract_jobs(self, downloaded_files: list[Path], strict_complete: bool) -> tuple[list[ExtractJob], int]:
        jobs: list[ExtractJob] = []
        rar_groups: dict[str, dict[int, Path]] = {}
        skipped = 0

        for file_path in downloaded_files:
            suffix = file_path.suffix.lower()
            name_lower = file_path.name.lower()

            if suffix in {".zip", ".7z"}:
                jobs.append(
                    ExtractJob(
                        key=f"single:{name_lower}",
                        archive_path=file_path,
                        source_files=[file_path],
                    )
                )
                continue

            if suffix != ".rar":
                continue

            match = RAR_PART_RE.search(name_lower)
            if not match:
                jobs.append(
                    ExtractJob(
                        key=f"single:{name_lower}",
                        archive_path=file_path,
                        source_files=[file_path],
                    )
                )
                continue

            part_number = int(match.group(1))
            base_name = name_lower[: match.start()]
            group = rar_groups.setdefault(base_name, {})
            group[part_number] = file_path

        for base_name, parts in rar_groups.items():
            if 1 not in parts:
                if strict_complete:
                    skipped += 1
                    self._queue_status(f"Uebersprungen (kein Part1): {base_name}")
                continue

            max_part = max(parts)
            missing_parts = [part for part in range(1, max_part + 1) if part not in parts]
            if missing_parts:
                if strict_complete:
                    skipped += 1
                    missing_text = ", ".join(str(part) for part in missing_parts[:8])
                    self._queue_status(f"Uebersprungen (fehlende Parts {missing_text}): {parts[1].name}")
                continue

            source_files = [parts[part] for part in sorted(parts)]
            jobs.append(
                ExtractJob(
                    key=f"rar:{base_name}",
                    archive_path=parts[1],
                    source_files=source_files,
                )
            )

        return jobs, skipped

    def _extract_archive(self, archive_path: Path, extract_target_dir: Path) -> str | None:
        suffix = archive_path.suffix.lower()

        if suffix == ".zip":
            return self._extract_zip_archive(archive_path, extract_target_dir)

        if suffix == ".rar":
            if self.seven_zip_path:
                return self._extract_with_7zip(archive_path, extract_target_dir)
            return self._extract_with_unrar(archive_path, extract_target_dir)

        if suffix == ".7z":
            return self._extract_with_7zip(archive_path, extract_target_dir)

        raise RuntimeError("Archivformat wird nicht unterstuetzt")

    def _extract_zip_archive(self, archive_path: Path, extract_target_dir: Path) -> str | None:
        last_error: Exception | None = None
        for password in (None, *ARCHIVE_PASSWORDS):
            if self.stop_event.is_set():
                raise InterruptedError("Entpacken wurde gestoppt")

            try:
                with tempfile.TemporaryDirectory(prefix="rd_zip_extract_") as temp_dir:
                    temp_path = Path(temp_dir)

                    if pyzipper is not None:
                        with pyzipper.AESZipFile(archive_path) as archive:
                            if password:
                                archive.setpassword(password.encode("utf-8"))
                            archive.extractall(path=temp_path)
                    else:
                        with zipfile.ZipFile(archive_path) as archive:
                            archive.extractall(path=temp_path, pwd=password.encode("utf-8") if password else None)

                    merge_directory(temp_path, extract_target_dir)
                    return password

            except zipfile.BadZipFile as exc:
                raise RuntimeError("ZIP-Datei ist defekt oder ungueltig") from exc
            except NotImplementedError as exc:
                if self.seven_zip_path:
                    return self._extract_with_7zip(archive_path, extract_target_dir)
                last_error = exc
                continue
            except Exception as exc:
                last_error = exc
                if self._looks_like_password_error(str(exc)):
                    continue

        raise RuntimeError("Kein passendes ZIP-Passwort gefunden") from last_error

    def _extract_with_7zip(self, archive_path: Path, extract_target_dir: Path) -> str | None:
        if not self.seven_zip_path:
            raise RuntimeError("Fuer 7Z wird 7-Zip (7z.exe) benoetigt")

        last_output = ""
        for password in (*ARCHIVE_PASSWORDS, None):
            if self.stop_event.is_set():
                raise InterruptedError("Entpacken wurde gestoppt")

            with tempfile.TemporaryDirectory(prefix="rd_7z_extract_") as temp_dir:
                command = [self.seven_zip_path, "x", "-y", f"-o{temp_dir}"]
                command.append(f"-p{password}" if password else "-p")
                command.append(str(archive_path))

                try:
                    result = subprocess.run(
                        command,
                        capture_output=True,
                        text=True,
                        timeout=1800,
                        **hidden_subprocess_kwargs(),
                    )
                except subprocess.TimeoutExpired as exc:
                    raise RuntimeError("Entpacken hat zu lange gedauert") from exc

                if result.returncode == 0:
                    merge_directory(Path(temp_dir), extract_target_dir)
                    return password

                output = f"{result.stdout}\n{result.stderr}".strip()
                last_output = output
                if self._looks_like_7zip_password_error(output):
                    continue

        raise RuntimeError(last_output or "Kein passendes Archiv-Passwort gefunden")

    def _extract_with_unrar(self, archive_path: Path, extract_target_dir: Path) -> str | None:
        if not self.unrar_path:
            raise RuntimeError("Fuer RAR wird WinRAR UnRAR.exe oder 7-Zip benoetigt")

        last_output = ""
        for password in (*ARCHIVE_PASSWORDS, None):
            if self.stop_event.is_set():
                raise InterruptedError("Entpacken wurde gestoppt")

            with tempfile.TemporaryDirectory(prefix="rd_unrar_extract_") as temp_dir:
                command = [self.unrar_path, "x", "-y", "-o+"]
                command.append(f"-p{password}" if password else "-p-")
                command.extend([str(archive_path), f"{temp_dir}\\"])

                try:
                    result = subprocess.run(
                        command,
                        capture_output=True,
                        text=True,
                        timeout=1800,
                        **hidden_subprocess_kwargs(),
                    )
                except subprocess.TimeoutExpired as exc:
                    raise RuntimeError("Entpacken hat zu lange gedauert") from exc

                if result.returncode == 0:
                    merge_directory(Path(temp_dir), extract_target_dir)
                    return password

                output = f"{result.stdout}\n{result.stderr}".strip()
                last_output = output
                if self._looks_like_unrar_password_error(output):
                    continue

        raise RuntimeError(last_output or "Kein passendes RAR-Passwort gefunden")

    @staticmethod
    def _looks_like_password_error(message: str) -> bool:
        lower = message.lower()
        markers = (
            "password",
            "passwort",
            "encrypted",
            "decrypt",
            "bad crc",
            "wrong key",
        )
        return any(marker in lower for marker in markers)

    @staticmethod
    def _looks_like_7zip_password_error(message: str) -> bool:
        lower = message.lower()
        markers = (
            "wrong password",
            "can not open encrypted archive",
            "data error in encrypted file",
            "headers error",
        )
        return any(marker in lower for marker in markers)

    @staticmethod
    def _looks_like_unrar_password_error(message: str) -> bool:
        lower = message.lower()
        markers = (
            "wrong password",
            "incorrect password",
            "checksum error",
            "encrypted",
        )
        return any(marker in lower for marker in markers)

    def _apply_speed_limit(self, chunk_size: int, local_window: dict[str, float]) -> None:
        limit_kbps, mode = self._active_speed_limit()
        if limit_kbps <= 0:
            return

        limit_bps = float(limit_kbps) * 1024.0
        if limit_bps <= 0:
            return

        if mode == "per_download":
            now = monotonic()
            local_window["bytes"] = local_window.get("bytes", 0.0) + float(chunk_size)
            start = local_window.get("start", now)
            elapsed = now - start
            expected = local_window["bytes"] / limit_bps
            delay = expected - elapsed
            if delay > 0:
                sleep(delay)
            if elapsed > 1.5:
                local_window["start"] = monotonic()
                local_window["bytes"] = 0.0
            return

        with self.speed_limit_lock:
            now = monotonic()
            if now - self.global_throttle_window_start > 1.5:
                self.global_throttle_window_start = now
                self.global_throttle_bytes = 0

            self.global_throttle_bytes += chunk_size
            elapsed = now - self.global_throttle_window_start
            expected = self.global_throttle_bytes / limit_bps
            delay = expected - elapsed

        if delay > 0:
            sleep(delay)

    def _stream_download(
        self,
        session: requests.Session,
        url: str,
        target_path: Path,
        row_index: int,
    ) -> int:
        last_error: Exception | None = None
        for attempt in range(1, REQUEST_RETRIES + 1):
            response: requests.Response | None = None
            try:
                response = session.get(url, stream=True, timeout=(25, 300))
            except requests.RequestException as exc:
                last_error = exc
                if attempt < REQUEST_RETRIES:
                    self._queue_row(
                        row_index,
                        status=f"Verbindungsfehler, retry {attempt + 1}/{REQUEST_RETRIES}",
                        speed="0 B/s",
                        retries=str(attempt),
                    )
                    retry_sleep(attempt)
                    continue
                raise RuntimeError(f"Download-Start fehlgeschlagen: {exc}") from exc

            if not response.ok:
                error_text = parse_error_message(response)
                if should_retry_status(response.status_code) and attempt < REQUEST_RETRIES:
                    self._queue_row(
                        row_index,
                        status=f"Serverfehler {response.status_code}, retry {attempt + 1}/{REQUEST_RETRIES}",
                        speed="0 B/s",
                        retries=str(attempt),
                    )
                    response.close()
                    retry_sleep(attempt)
                    continue
                response.close()
                raise RuntimeError(error_text)

            total_bytes = int(response.headers.get("content-length", "0") or 0)
            written = 0
            last_percent = -1
            last_reported_bucket = -1
            speed_window_start = monotonic()
            speed_window_bytes = 0
            speed_limit_window: dict[str, float] = {"start": monotonic(), "bytes": 0.0}

            try:
                with response, target_path.open("wb") as output_file:
                    for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
                        if self.stop_event.is_set():
                            raise InterruptedError("Download wurde gestoppt")

                        if not chunk:
                            continue

                        output_file.write(chunk)
                        chunk_size = len(chunk)
                        written += chunk_size
                        speed_window_bytes += chunk_size
                        self._queue_speed_bytes(chunk_size)
                        self._apply_speed_limit(chunk_size, speed_limit_window)

                        if total_bytes > 0:
                            percent = int((written * 100) / total_bytes)
                            if percent != last_percent:
                                last_percent = percent
                                self._queue_row(row_index, progress=f"{percent}%")
                        else:
                            bucket = written // (10 * 1024 * 1024)
                            if bucket != last_reported_bucket:
                                last_reported_bucket = bucket
                                self._queue_row(row_index, progress=human_size(written))

                        now = monotonic()
                        elapsed = now - speed_window_start
                        if elapsed >= 0.8:
                            speed_value = speed_window_bytes / elapsed if elapsed > 0 else 0.0
                            self._queue_row(row_index, speed=f"{human_size(int(speed_value))}/s")
                            speed_window_start = now
                            speed_window_bytes = 0

                self._queue_row(row_index, speed="0 B/s", retries=str(attempt - 1))
                return attempt - 1
            except InterruptedError:
                if target_path.exists():
                    target_path.unlink(missing_ok=True)
                raise
            except requests.RequestException as exc:
                last_error = exc
                if target_path.exists():
                    target_path.unlink(missing_ok=True)
                if attempt < REQUEST_RETRIES:
                    self._queue_row(
                        row_index,
                        status=f"Download unterbrochen, retry {attempt + 1}/{REQUEST_RETRIES}",
                        speed="0 B/s",
                        retries=str(attempt),
                    )
                    retry_sleep(attempt)
                    continue
                raise RuntimeError(f"Download fehlgeschlagen: {exc}") from exc
            except Exception:
                if target_path.exists():
                    target_path.unlink(missing_ok=True)
                raise

        raise RuntimeError(f"Download fehlgeschlagen: {last_error}")

    def _queue_row(self, row_index: int, **updates: str) -> None:
        self.ui_queue.put(("row", row_index, updates))

    def _queue_package(self, **updates: str) -> None:
        self.ui_queue.put(("package", updates))

    def _queue_status(self, message: str) -> None:
        self.ui_queue.put(("status", message))

    def _queue_overall(self, processed: int, total: int) -> None:
        self.ui_queue.put(("overall", processed, total))

    def _queue_speed_bytes(self, byte_count: int) -> None:
        self.ui_queue.put(("speed_bytes", byte_count))

    def _process_ui_queue(self) -> None:
        while True:
            try:
                event = self.ui_queue.get_nowait()
            except queue.Empty:
                break

            kind = event[0]

            if kind == "row":
                row_index = event[1]
                updates = event[2]
                row_id = self.row_map.get(row_index)
                if row_id:
                    values = list(self.table.item(row_id, "values"))
                    columns = {"file": 0, "status": 1, "progress": 2, "speed": 3, "retries": 4}
                    for key, value in updates.items():
                        column_index = columns.get(key)
                        if column_index is not None:
                            values[column_index] = value
                    self.table.item(row_id, values=values)
                    self.table.see(row_id)

            elif kind == "package":
                updates = event[1]
                if self.package_row_id and self.table.exists(self.package_row_id):
                    values = list(self.table.item(self.package_row_id, "values"))
                    columns = {"file": 0, "status": 1, "progress": 2, "speed": 3, "retries": 4}
                    for key, value in updates.items():
                        column_index = columns.get(key)
                        if column_index is not None:
                            values[column_index] = value
                    self.table.item(self.package_row_id, values=values)

            elif kind == "status":
                self.status_var.set(event[1])

            elif kind == "overall":
                processed, total = event[1], event[2]
                percent = (processed / total) * 100 if total else 0
                self.overall_progress_var.set(percent)

            elif kind == "speed_bytes":
                byte_count = int(event[1])
                now = monotonic()
                self.speed_events.append((now, byte_count))
                cutoff = now - 3.0
                while self.speed_events and self.speed_events[0][0] < cutoff:
                    self.speed_events.popleft()

                if self.speed_events:
                    first_time = self.speed_events[0][0]
                    total_bytes = sum(item[1] for item in self.speed_events)
                    span = max(now - first_time, 0.2)
                    speed = total_bytes / span
                else:
                    speed = 0.0
                speed_text = f"{human_size(int(speed))}/s"
                self.speed_var.set(f"Geschwindigkeit: {speed_text}")
                if self.package_row_id and self.table.exists(self.package_row_id):
                    values = list(self.table.item(self.package_row_id, "values"))
                    if len(values) >= 4:
                        values[3] = speed_text
                        self.table.item(self.package_row_id, values=values)

            elif kind == "update_available":
                release = event[1]
                manual = bool(event[2])
                self._handle_update_available(release, manual)

            elif kind == "update_none":
                latest = str(event[1])
                messagebox.showinfo("Update", f"Kein Update verfuegbar. Aktuell: v{APP_VERSION}, Latest: v{latest}")

            elif kind == "update_error":
                messagebox.showerror("Update", str(event[1]))

            elif kind == "update_done":
                with self.update_lock:
                    self.update_check_running = False

            elif kind == "update_download_done":
                with self.update_lock:
                    self.update_download_running = False

            elif kind == "controls":
                running = bool(event[1])
                self.start_button.configure(state="disabled" if running else "normal")
                self.stop_button.configure(state="normal" if running else "disabled")
                if not running:
                    self.speed_events.clear()
                    self.speed_var.set("Geschwindigkeit: 0 B/s")
                    if self.package_row_id and self.table.exists(self.package_row_id):
                        values = list(self.table.item(self.package_row_id, "values"))
                        if len(values) >= 4:
                            values[3] = "0 B/s"
                            self.table.item(self.package_row_id, values=values)

        self.after(100, self._process_ui_queue)

    def _handle_update_available(self, release: ReleaseInfo, manual: bool) -> None:
        if getattr(sys, "frozen", False):
            should_update = messagebox.askyesno(
                "Update verfuegbar",
                f"Neue Version v{release.version} gefunden (aktuell v{APP_VERSION}). Jetzt herunterladen und installieren?",
            )
            if should_update:
                self._start_update_download(release)
            elif manual and release.html_url:
                webbrowser.open(release.html_url)
            return

        message = (
            f"Neue Version v{release.version} gefunden (aktuell v{APP_VERSION}).\n\n"
            "Auto-Update geht nur in der .exe. Soll die Release-Seite geoeffnet werden?"
        )
        if messagebox.askyesno("Update verfuegbar", message) and release.html_url:
            webbrowser.open(release.html_url)


def main() -> None:
    app = DownloaderApp()
    app.mainloop()


if __name__ == "__main__":
    main()
