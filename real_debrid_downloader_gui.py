import base64
import hashlib
import logging
import json
import html
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
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
    from tkinterdnd2 import DND_FILES, TkinterDnD
except ImportError:
    DND_FILES = None
    TkinterDnD = None

try:
    import pyzipper
except ImportError:
    pyzipper = None

try:
    from send2trash import send2trash
except ImportError:
    send2trash = None

try:
    from Cryptodome.Cipher import AES as _AES
except ImportError:
    _AES = None

try:
    import keyring
except ImportError:
    keyring = None

API_BASE_URL = "https://api.real-debrid.com/rest/1.0"
CONFIG_FILE = Path(__file__).with_name("rd_downloader_config.json")
MANIFEST_FILE = Path(__file__).with_name("rd_download_manifest.json")
LOG_FILE = Path(__file__).with_name("rd_downloader.log")
CHUNK_SIZE = 1024 * 512
APP_NAME = "Real-Debrid Downloader GUI"
APP_VERSION = "1.1.8"
DEFAULT_UPDATE_REPO = "Sucukdeluxe/real-debrid-downloader"
DEFAULT_RELEASE_ASSET = "Real-Debrid-Downloader-win64.zip"
DCRYPT_UPLOAD_URL = "https://dcrypt.it/decrypt/upload"
DLC_SERVICE_URL = "http://service.jdownloader.org/dlcrypt/service.php?srcType=dlc&destType=pylo&data={}"
DLC_AES_KEY = b"cb99b5cbc24db398"
DLC_AES_IV = b"9bc24cb995cb8db3"
REQUEST_RETRIES = 3
RETRY_BACKOFF_SECONDS = 1.2
RETRY_HTTP_STATUS = {408, 429, 500, 502, 503, 504}
INVALID_FILENAME_CHARS = '<>:"/\\|?*'
ARCHIVE_PASSWORDS = ("serienfans.org", "serienjunkies.net")
RAR_PART_RE = re.compile(r"\.part(\d+)\.rar$", re.IGNORECASE)
PACKAGE_MARKER_RE = re.compile(r"^\s*#\s*package\s*:\s*(.+?)\s*$", re.IGNORECASE)
SPEED_MODE_CHOICES = ("global", "per_download")
EXTRACT_CONFLICT_CHOICES = ("overwrite", "skip", "rename", "ask")
CLEANUP_MODE_CHOICES = ("none", "trash", "delete")
FINISHED_TASK_CLEANUP_CHOICES = ("never", "immediate", "on_start", "package_done")
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
KEYRING_SERVICE = "real_debrid_downloader"
KEYRING_USERNAME = "api_token"
SAMPLE_DIR_NAMES = {"sample", "samples"}
SAMPLE_VIDEO_EXTENSIONS = {".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v", ".ts", ".m2ts", ".webm"}
SAMPLE_TOKEN_RE = re.compile(r"(^|[._\-\s])sample([._\-\s]|$)", re.IGNORECASE)
LINK_ARTIFACT_EXTENSIONS = {".url", ".webloc", ".dlc", ".rsdf", ".ccf"}
ARCHIVE_TEMP_EXTENSIONS = {".rar", ".zip", ".7z", ".tmp", ".part"}
RAR_SPLIT_RE = re.compile(r"\.r\d{2}$", re.IGNORECASE)


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


@dataclass
class DownloadPackage:
    name: str
    links: list[str]


@dataclass
class DownloadResult:
    path: Path
    bytes_written: int


@dataclass
class PackageRunResult:
    processed: int
    success: int
    failed: int
    extracted: int
    downloaded_files: list[Path]
    extracted_job_keys: set[str]
    cancelled: bool = False
    skipped: int = 0


class PackageCancelledError(Exception):
    pass


CLEANUP_LABELS = {
    "none": "keine Archive löschen",
    "trash": "Archive in den Papierkorb verschieben, wenn möglich",
    "delete": "Archive unwiderruflich löschen",
}

FINISHED_TASK_CLEANUP_LABELS = {
    "never": "Nie",
    "immediate": "Sofort",
    "on_start": "Beim App-Start",
    "package_done": "Sobald Paket fertig ist",
}


def configure_file_logger() -> logging.Logger:
    logger = logging.getLogger("rd_downloader")
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(handler)
    return logger


LOGGER = configure_file_logger()

if TkinterDnD is not None:
    TkBase = TkinterDnD.Tk
else:
    TkBase = tk.Tk


def compact_error_text(message: str, max_len: int = 180) -> str:
    text = str(message or "").strip()
    if not text:
        return "Unbekannter Fehler"
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= max_len:
        return text
    return f"{text[: max_len - 3]}..."


def is_http_link(value: str) -> bool:
    text = value.strip()
    if not text:
        return False
    parsed = urlparse(text)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)

CONFLICT_LABELS = {
    "overwrite": "Datei überschreiben",
    "skip": "Datei überspringen",
    "rename": "neue Datei automatisch umbenennen",
    "ask": "Nachfragen (im Hintergrund: umbenennen)",
}


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
        return compact_error_text(text)
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


def merge_directory(source_dir: Path, destination_dir: Path, conflict_mode: str = "rename") -> None:
    destination_dir.mkdir(parents=True, exist_ok=True)
    for item in source_dir.iterdir():
        target = destination_dir / item.name
        if target.exists():
            if conflict_mode == "overwrite":
                if target.is_dir():
                    shutil.rmtree(target, ignore_errors=True)
                else:
                    target.unlink(missing_ok=True)
            elif conflict_mode == "skip":
                continue
            else:
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

    def unrestrict_link(self, link: str) -> tuple[str, str, int, int | None]:
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
        try:
            file_size = int(payload.get("filesize")) if payload.get("filesize") is not None else None
        except Exception:
            file_size = None
        return filename, download_url, retries_used, file_size


class DownloaderApp(TkBase):
    def __init__(self):
        super().__init__()
        self.title(f"{APP_NAME} v{APP_VERSION}")
        self.geometry("1180x920")
        self.minsize(980, 820)

        self.token_var = tk.StringVar()
        self.output_dir_var = tk.StringVar(value=str(Path.home() / "Downloads" / "RealDebrid"))
        self.package_name_var = tk.StringVar(value="")
        self.auto_extract_var = tk.BooleanVar(value=True)
        self.extract_dir_var = tk.StringVar(value=str(Path.home() / "Downloads" / "RealDebrid" / "_entpackt"))
        self.create_extract_subfolder_var = tk.BooleanVar(value=True)
        self.hybrid_extract_var = tk.BooleanVar(value=True)
        self.cleanup_mode_var = tk.StringVar(value="none")
        self.extract_conflict_mode_var = tk.StringVar(value="overwrite")
        self.remove_link_files_after_extract_var = tk.BooleanVar(value=False)
        self.remove_samples_var = tk.BooleanVar(value=False)
        self.enable_integrity_check_var = tk.BooleanVar(value=True)
        self.auto_resume_on_start_var = tk.BooleanVar(value=True)
        self.auto_reconnect_var = tk.BooleanVar(value=False)
        self.reconnect_wait_seconds_var = tk.IntVar(value=45)
        self.completed_cleanup_policy_var = tk.StringVar(value="never")
        self.max_parallel_var = tk.IntVar(value=4)
        self.speed_limit_enabled_var = tk.BooleanVar(value=False)
        self.speed_limit_kbps_var = tk.IntVar(value=0)
        self.speed_limit_mode_var = tk.StringVar(value="global")
        self.update_repo_var = tk.StringVar(value=DEFAULT_UPDATE_REPO)
        self.auto_update_check_var = tk.BooleanVar(value=True)
        self.show_token_var = tk.BooleanVar(value=False)
        self.remember_token_var = tk.BooleanVar(value=True)
        self.status_var = tk.StringVar(value="Bereit")
        self.speed_var = tk.StringVar(value="Geschwindigkeit: 0 B/s")
        self.eta_var = tk.StringVar(value="ETA: --")
        self.overall_progress_var = tk.DoubleVar(value=0.0)

        self.worker_thread: threading.Thread | None = None
        self.seven_zip_path = find_7zip_executable()
        self.unrar_path = find_unrar_executable()
        self.stop_event = threading.Event()
        self.pause_event = threading.Event()
        self.ui_queue: queue.Queue = queue.Queue()
        self.row_map: dict[int, str] = {}
        self.package_row_id: str | None = None
        self.package_contexts: list[dict] = []
        self.settings_window: tk.Toplevel | None = None
        self.speed_events: deque[tuple[float, int]] = deque()
        self.speed_events_lock = threading.Lock()
        self.parallel_limit_lock = threading.Lock()
        self.current_parallel_limit = 4
        self.speed_limit_lock = threading.Lock()
        self.current_speed_limit_kbps = 0
        self.current_speed_limit_mode = "global"
        self.global_throttle_window_start = monotonic()
        self.global_throttle_bytes = 0
        self.path_lock = threading.Lock()
        self.reserved_target_keys: set[str] = set()
        self.integrity_cache_lock = threading.Lock()
        self.integrity_cache: dict[str, dict[str, tuple[str, str]]] = {}
        self.reconnect_lock = threading.Lock()
        self.reconnect_active_until = 0.0
        self.reconnect_requested = False
        self.reconnect_reason = ""
        self.non_resumable_active = 0
        self.update_lock = threading.Lock()
        self.update_check_running = False
        self.update_download_running = False
        self.http_session = requests.Session()
        self.http_session.headers.update({"User-Agent": f"RD-GUI-Downloader/{APP_VERSION}"})
        self.manifest_lock = threading.Lock()
        self.manifest_data: dict = {}
        self.run_started_at = 0.0
        self.total_downloaded_bytes = 0
        self.tooltip_window: tk.Toplevel | None = None
        self.tooltip_label: ttk.Label | None = None
        self.tooltip_row = ""
        self.tooltip_column = ""
        self.dnd_ready = False
        self.package_cancel_lock = threading.Lock()
        self.cancelled_package_rows: set[str] = set()
        self.resume_manifest_loaded = False

        self._build_ui()
        self._load_config()
        self._on_speed_limit_enabled_toggle()
        self._restore_manifest_into_links()
        self.max_parallel_var.trace_add("write", self._on_parallel_spinbox_change)
        self.speed_limit_kbps_var.trace_add("write", self._on_speed_limit_change)
        self.speed_limit_mode_var.trace_add("write", self._on_speed_mode_change)
        self._sync_parallel_limit(self.max_parallel_var.get())
        initial_speed = self.speed_limit_kbps_var.get() if self.speed_limit_enabled_var.get() else 0
        self._sync_speed_limit(initial_speed, self.speed_limit_mode_var.get())
        self.after(100, self._process_ui_queue)
        self.after(400, self._maybe_auto_resume_on_start)
        self.after(1500, self._auto_check_updates)

    def destroy(self) -> None:
        try:
            self.http_session.close()
        except Exception:
            pass
        try:
            self._hide_status_tooltip()
        except Exception:
            pass
        super().destroy()

    def _build_ui(self) -> None:
        self._configure_modern_theme()

        root = ttk.Frame(self, style="App.TFrame", padding=(16, 14, 16, 12))
        root.pack(fill="both", expand=True)
        root.columnconfigure(0, weight=1)
        root.rowconfigure(2, weight=1)

        title_row = ttk.Frame(root, style="App.TFrame")
        title_row.grid(row=0, column=0, sticky="ew")
        title_row.columnconfigure(1, weight=1)

        ttk.Label(title_row, text="Real-Debrid Download Manager", style="HeaderTitle.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(title_row, text=f"v{APP_VERSION}", style="HeaderMeta.TLabel").grid(row=0, column=1, sticky="w", padx=(10, 0))

        metrics = ttk.Frame(title_row, style="App.TFrame")
        metrics.grid(row=0, column=2, sticky="e")
        ttk.Label(metrics, textvariable=self.speed_var, style="HeaderValue.TLabel").pack(side="right", padx=(14, 0))
        ttk.Label(metrics, textvariable=self.eta_var, style="HeaderMeta.TLabel").pack(side="right")

        control_bar = ttk.Frame(root, style="Surface.TFrame", padding=(14, 10))
        control_bar.grid(row=1, column=0, sticky="ew", pady=(10, 12))
        control_bar.columnconfigure(12, weight=1)

        self.start_button = ttk.Button(control_bar, text="Start", style="Accent.TButton", command=self.start_downloads)
        self.start_button.grid(row=0, column=0, sticky="w")
        self.pause_button = ttk.Button(control_bar, text="Pause", style="Ghost.TButton", command=self.toggle_pause_downloads, state="disabled")
        self.pause_button.grid(row=0, column=1, sticky="w", padx=(8, 0))
        self.stop_button = ttk.Button(control_bar, text="Stop", style="Ghost.TButton", command=self.stop_downloads, state="disabled")
        self.stop_button.grid(row=0, column=2, sticky="w", padx=(8, 0))
        ttk.Button(control_bar, text="Fortschritt leeren", style="Ghost.TButton", command=self._clear_progress_only).grid(
            row=0,
            column=3,
            sticky="w",
            padx=(10, 0),
        )

        ttk.Separator(control_bar, orient="vertical").grid(row=0, column=4, sticky="ns", padx=(14, 14))
        ttk.Checkbutton(
            control_bar,
            text="Speed-Limit",
            style="Surface.TCheckbutton",
            variable=self.speed_limit_enabled_var,
            command=self._on_speed_limit_enabled_toggle,
        ).grid(row=0, column=5, sticky="w")
        self.speed_limit_spin = ttk.Spinbox(control_bar, from_=0, to=500000, width=8, textvariable=self.speed_limit_kbps_var)
        self.speed_limit_spin.grid(row=0, column=6, sticky="w", padx=(8, 0))
        ttk.Label(control_bar, text="KB/s", style="Surface.TLabel").grid(row=0, column=7, sticky="w", padx=(5, 0))
        self.speed_mode_box = ttk.Combobox(
            control_bar,
            textvariable=self.speed_limit_mode_var,
            values=SPEED_MODE_CHOICES,
            width=12,
            state="readonly",
        )
        self.speed_mode_box.grid(row=0, column=8, sticky="w", padx=(8, 0))
        ttk.Button(control_bar, text="Update suchen", style="Ghost.TButton", command=self._manual_check_updates).grid(
            row=0,
            column=9,
            sticky="w",
            padx=(12, 0),
        )

        self.main_tabs = ttk.Notebook(root)
        self.main_tabs.grid(row=2, column=0, sticky="nsew")

        collector_tab = ttk.Frame(self.main_tabs, style="App.TFrame", padding=10)
        downloads_tab = ttk.Frame(self.main_tabs, style="App.TFrame", padding=10)
        settings_tab = ttk.Frame(self.main_tabs, style="App.TFrame", padding=10)
        self.main_tabs.add(collector_tab, text="Linksammler")
        self.main_tabs.add(downloads_tab, text="Downloads")
        self.main_tabs.add(settings_tab, text="Settings")

        collector_tab.columnconfigure(0, weight=1)
        collector_tab.rowconfigure(1, weight=1)

        collector_top = ttk.Frame(collector_tab, style="App.TFrame")
        collector_top.grid(row=0, column=0, sticky="ew")
        collector_top.columnconfigure(0, weight=1)
        collector_top.columnconfigure(1, weight=1)

        auth_card, auth = self._create_card(
            collector_top,
            "Authentifizierung",
            "Token, Update-Quelle und Startverhalten",
        )
        auth_card.grid(row=0, column=0, sticky="nsew", padx=(0, 8))
        auth.columnconfigure(1, weight=1)

        ttk.Label(auth, text="API Token", style="CardLabel.TLabel").grid(row=0, column=0, sticky="w", padx=(0, 8))
        self.token_entry = ttk.Entry(auth, textvariable=self.token_var, show="*")
        self.token_entry.grid(row=0, column=1, sticky="ew", padx=(0, 8))
        ttk.Checkbutton(
            auth,
            text="anzeigen",
            style="Card.TCheckbutton",
            variable=self.show_token_var,
            command=self._toggle_token_visibility,
        ).grid(row=0, column=2, sticky="w")
        ttk.Checkbutton(
            auth,
            text="Token lokal speichern",
            style="Card.TCheckbutton",
            variable=self.remember_token_var,
        ).grid(row=1, column=1, sticky="w", pady=(8, 0))
        ttk.Label(auth, text="GitHub Repo", style="CardLabel.TLabel").grid(row=2, column=0, sticky="w", padx=(0, 8), pady=(8, 0))
        ttk.Entry(auth, textvariable=self.update_repo_var).grid(row=2, column=1, sticky="ew", padx=(0, 8), pady=(8, 0))
        ttk.Checkbutton(
            auth,
            text="Beim Start auf Updates prüfen",
            style="Card.TCheckbutton",
            variable=self.auto_update_check_var,
        ).grid(row=3, column=1, sticky="w", pady=(8, 0))

        path_card, path = self._create_card(
            collector_top,
            "Paketierung & Zielpfade",
            "Ordner, Entpacken und Paketoptionen",
        )
        path_card.grid(row=0, column=1, sticky="nsew", padx=(8, 0))
        path.columnconfigure(1, weight=1)

        ttk.Label(path, text="Download-Ordner", style="CardLabel.TLabel").grid(row=0, column=0, sticky="w", padx=(0, 8))
        ttk.Entry(path, textvariable=self.output_dir_var).grid(row=0, column=1, sticky="ew", padx=(0, 8))
        ttk.Button(path, text="Wählen", style="Ghost.TButton", command=self._browse_output_dir).grid(row=0, column=2, sticky="w")
        ttk.Label(path, text="Paketname", style="CardLabel.TLabel").grid(row=1, column=0, sticky="w", padx=(0, 8), pady=(8, 0))
        ttk.Entry(path, textvariable=self.package_name_var).grid(row=1, column=1, columnspan=2, sticky="ew", pady=(8, 0))
        ttk.Label(path, text="Entpacken nach", style="CardLabel.TLabel").grid(row=2, column=0, sticky="w", padx=(0, 8), pady=(8, 0))
        ttk.Entry(path, textvariable=self.extract_dir_var).grid(row=2, column=1, sticky="ew", padx=(0, 8), pady=(8, 0))
        ttk.Button(path, text="Wählen", style="Ghost.TButton", command=self._browse_extract_dir).grid(row=2, column=2, sticky="w", pady=(8, 0))
        ttk.Checkbutton(
            path,
            text="Nach Download automatisch entpacken",
            style="Card.TCheckbutton",
            variable=self.auto_extract_var,
        ).grid(row=3, column=0, columnspan=3, sticky="w", pady=(8, 0))
        ttk.Checkbutton(
            path,
            text="Unterordner erstellen (Paketname)",
            style="Card.TCheckbutton",
            variable=self.create_extract_subfolder_var,
        ).grid(row=4, column=0, columnspan=3, sticky="w", pady=(6, 0))
        ttk.Checkbutton(
            path,
            text="Hybrid-Entpacken sobald Parts komplett",
            style="Card.TCheckbutton",
            variable=self.hybrid_extract_var,
        ).grid(row=5, column=0, columnspan=3, sticky="w", pady=(6, 0))
        ttk.Label(path, text="Auto-Passwörter: serienfans.org, serienjunkies.net", style="CardSub.TLabel").grid(
            row=6,
            column=0,
            columnspan=3,
            sticky="w",
            pady=(8, 0),
        )

        links_card, links_body = self._create_card(
            collector_tab,
            "Linksammler",
            "Container und Direktlinks prüfen, sammeln und in die Queue übernehmen",
        )
        links_card.grid(row=1, column=0, sticky="nsew", pady=(10, 0))
        links_body.columnconfigure(0, weight=1)
        links_body.rowconfigure(1, weight=1)

        links_actions = ttk.Frame(links_body, style="Card.TFrame")
        links_actions.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        ttk.Button(links_actions, text="Links laden", style="Ghost.TButton", command=self._load_links_from_file).pack(side="left")
        ttk.Button(links_actions, text="DLC import", style="Ghost.TButton", command=self._import_dlc_file).pack(side="left", padx=(8, 0))
        ttk.Button(links_actions, text="Speichern", style="Ghost.TButton", command=self._save_links_to_file).pack(side="left", padx=(8, 0))
        ttk.Button(links_actions, text="Leeren", style="Ghost.TButton", command=self._clear_links).pack(side="left", padx=(8, 0))
        ttk.Label(links_actions, text=".dlc direkt hier droppen", style="CardSub.TLabel").pack(side="right")

        self.links_text = tk.Text(
            links_body,
            height=18,
            wrap="none",
            bg="#0b1526",
            fg="#e2e8f0",
            insertbackground="#e2e8f0",
            relief="flat",
            padx=10,
            pady=10,
            highlightthickness=1,
            highlightbackground="#253349",
            highlightcolor="#253349",
        )
        self.links_text.grid(row=1, column=0, sticky="nsew")
        links_scroll = ttk.Scrollbar(links_body, orient="vertical", command=self.links_text.yview)
        links_scroll.grid(row=1, column=1, sticky="ns")
        self.links_text.configure(yscrollcommand=links_scroll.set)
        self._setup_dlc_drag_and_drop()

        downloads_tab.columnconfigure(0, weight=1)
        downloads_tab.rowconfigure(0, weight=1)

        downloads_card, downloads_body = self._create_card(
            downloads_tab,
            "Downloads",
            "Paket-Tree mit Download-, Entpack- und Integritätsstatus",
        )
        downloads_card.grid(row=0, column=0, sticky="nsew")
        downloads_body.columnconfigure(0, weight=1)
        downloads_body.rowconfigure(0, weight=1)

        columns = ("file", "status", "progress", "speed", "retries")
        self.table = ttk.Treeview(downloads_body, columns=columns, show="tree headings")
        self.table.heading("#0", text="Paket / Datei")
        self.table.heading("file", text="Datei")
        self.table.heading("status", text="Status")
        self.table.heading("progress", text="Fortschritt")
        self.table.heading("speed", text="Speed")
        self.table.heading("retries", text="Retries")
        self.table.column("#0", width=340, anchor="w")
        self.table.column("file", width=250, anchor="w")
        self.table.column("status", width=260, anchor="w")
        self.table.column("progress", width=100, anchor="center")
        self.table.column("speed", width=110, anchor="center")
        self.table.column("retries", width=85, anchor="center")
        self.table.grid(row=0, column=0, sticky="nsew")

        table_scroll = ttk.Scrollbar(downloads_body, orient="vertical", command=self.table.yview)
        table_scroll.grid(row=0, column=1, sticky="ns")
        self.table.configure(yscrollcommand=table_scroll.set)
        self.table.bind("<Delete>", self._on_table_delete_key)
        self.table.bind("<Button-3>", self._on_table_right_click)
        self.table.bind("<Motion>", self._on_table_motion)
        self.table.bind("<Leave>", self._hide_status_tooltip)

        self.table_context_menu = tk.Menu(self, tearoff=0)
        self.table_context_menu.add_command(label="Aus Fortschritt entfernen", command=self._remove_selected_progress_rows)
        self.table_context_menu.add_command(label="Fortschritt komplett leeren", command=self._clear_progress_only)
        self.table_context_menu.add_separator()
        self.table_context_menu.add_command(label="Links komplett leeren", command=self._clear_links)
        self.table_context_menu.add_command(label="Alles leeren", command=self._clear_all_lists)

        footer = ttk.Frame(downloads_body, style="Card.TFrame")
        footer.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(10, 0))
        footer.columnconfigure(0, weight=1)
        ttk.Progressbar(footer, variable=self.overall_progress_var, maximum=100, mode="determinate").grid(
            row=0,
            column=0,
            sticky="ew",
        )
        ttk.Label(footer, textvariable=self.status_var, style="CardSub.TLabel").grid(row=1, column=0, sticky="w", pady=(6, 0))

        self._build_settings_tab(settings_tab)
        self._on_speed_limit_enabled_toggle()

    def _create_card(self, parent: ttk.Widget, title: str, subtitle: str = "") -> tuple[ttk.Frame, ttk.Frame]:
        card = ttk.Frame(parent, style="Card.TFrame", padding=(14, 12))
        card.columnconfigure(0, weight=1)
        ttk.Label(card, text=title, style="CardTitle.TLabel").grid(row=0, column=0, sticky="w")
        if subtitle:
            ttk.Label(card, text=subtitle, style="CardSub.TLabel").grid(row=1, column=0, sticky="w", pady=(2, 0))
            body_row = 2
        else:
            body_row = 1

        body = ttk.Frame(card, style="Card.TFrame")
        body.grid(row=body_row, column=0, sticky="nsew", pady=(10, 0))
        return card, body

    def _configure_modern_theme(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except Exception:
            pass

        bg = "#070b14"
        surface = "#0e1626"
        card = "#111d31"
        field = "#081120"
        fg = "#e2e8f0"
        muted = "#8fa1b8"
        border = "#24364f"
        accent = "#38bdf8"
        accent_hover = "#60d3ff"
        accent_press = "#27a7de"

        font_base = ("Segoe UI", 10)
        self.option_add("*Font", "{Segoe UI} 10")
        self.configure(bg=bg)

        style.configure(".", font=font_base)
        style.configure("App.TFrame", background=bg)
        style.configure("Surface.TFrame", background=surface)
        style.configure("Card.TFrame", background=card)
        style.configure("TFrame", background=bg)

        style.configure("HeaderTitle.TLabel", background=bg, foreground=fg, font=("Segoe UI Semibold", 17))
        style.configure("HeaderMeta.TLabel", background=bg, foreground=muted, font=("Segoe UI", 10))
        style.configure("HeaderValue.TLabel", background=bg, foreground=fg, font=("Segoe UI Semibold", 10))

        style.configure("Surface.TLabel", background=surface, foreground=fg)
        style.configure("CardTitle.TLabel", background=card, foreground=fg, font=("Segoe UI Semibold", 11))
        style.configure("CardSub.TLabel", background=card, foreground=muted, font=("Segoe UI", 9))
        style.configure("CardLabel.TLabel", background=card, foreground=muted, font=("Segoe UI", 9))
        style.configure("TLabel", background=bg, foreground=fg)

        style.configure(
            "TButton",
            background=surface,
            foreground=fg,
            bordercolor=border,
            relief="flat",
            borderwidth=1,
            focusthickness=0,
            padding=(11, 7),
        )
        style.map(
            "TButton",
            background=[("active", "#17263c"), ("pressed", "#162338")],
            bordercolor=[("active", accent)],
        )

        style.configure(
            "Ghost.TButton",
            background=surface,
            foreground=fg,
            bordercolor=border,
            relief="flat",
            borderwidth=1,
            focusthickness=0,
            padding=(11, 7),
        )
        style.map(
            "Ghost.TButton",
            background=[("active", "#17263c"), ("pressed", "#162338")],
            bordercolor=[("active", accent)],
        )

        style.configure(
            "Accent.TButton",
            background=accent,
            foreground="#041018",
            bordercolor=accent,
            relief="flat",
            borderwidth=1,
            focusthickness=0,
            padding=(12, 7),
        )
        style.map(
            "Accent.TButton",
            background=[("active", accent_hover), ("pressed", accent_press), ("disabled", "#334155")],
            foreground=[("disabled", "#8b9fb5")],
            bordercolor=[("active", accent_hover), ("pressed", accent_press)],
        )

        style.configure("TCheckbutton", background=bg, foreground=fg)
        style.map("TCheckbutton", foreground=[("disabled", muted)])
        style.configure("Surface.TCheckbutton", background=surface, foreground=fg)
        style.configure("Card.TCheckbutton", background=card, foreground=fg)
        style.map("Card.TCheckbutton", foreground=[("disabled", muted)], background=[("active", card)])
        style.map("Surface.TCheckbutton", foreground=[("disabled", muted)], background=[("active", surface)])

        style.configure(
            "TEntry",
            fieldbackground=field,
            foreground=fg,
            bordercolor=border,
            lightcolor=border,
            darkcolor=border,
            insertcolor=fg,
            relief="flat",
            padding=6,
        )
        style.configure(
            "TCombobox",
            fieldbackground=field,
            foreground=fg,
            background=field,
            arrowcolor=muted,
            bordercolor=border,
            lightcolor=border,
            darkcolor=border,
            relief="flat",
            padding=5,
        )
        style.map(
            "TCombobox",
            fieldbackground=[("readonly", field)],
            foreground=[("readonly", fg)],
            selectbackground=[("readonly", field)],
            selectforeground=[("readonly", fg)],
        )
        style.configure(
            "TSpinbox",
            fieldbackground=field,
            foreground=fg,
            background=field,
            arrowcolor=muted,
            bordercolor=border,
            lightcolor=border,
            darkcolor=border,
            relief="flat",
            padding=5,
        )

        style.configure("TNotebook", background=bg, borderwidth=0)
        style.configure("TNotebook.Tab", background=surface, foreground=muted, padding=(16, 8), borderwidth=0)
        style.map(
            "TNotebook.Tab",
            background=[("selected", card), ("active", "#15243a")],
            foreground=[("selected", fg), ("active", fg)],
        )

        style.configure(
            "Treeview",
            background=field,
            fieldbackground=field,
            foreground=fg,
            bordercolor=border,
            lightcolor=border,
            darkcolor=border,
            rowheight=26,
        )
        style.configure("Treeview.Heading", background=surface, foreground=muted, relief="flat")
        style.map(
            "Treeview",
            background=[("selected", "#1d4ed8")],
            foreground=[("selected", "#f8fafc")],
        )
        style.map(
            "Treeview.Heading",
            background=[("active", "#17263c")],
            foreground=[("active", fg)],
        )

        style.configure(
            "Horizontal.TProgressbar",
            troughcolor="#0b1524",
            background=accent,
            bordercolor="#0b1524",
            lightcolor=accent,
            darkcolor=accent,
        )

    def _build_settings_tab(self, parent: ttk.Frame) -> None:
        parent.columnconfigure(0, weight=1)

        reconnect_card, reconnect = self._create_card(
            parent,
            "Queue & Reconnect",
            "Parallele Downloads und IP-Limit-Strategie",
        )
        reconnect_card.grid(row=0, column=0, sticky="ew")
        reconnect.columnconfigure(1, weight=1)

        ttk.Label(reconnect, text="Max. gleichzeitige Downloads", style="CardLabel.TLabel").grid(
            row=0,
            column=0,
            sticky="w",
            padx=(0, 8),
        )
        ttk.Spinbox(reconnect, from_=1, to=50, width=7, textvariable=self.max_parallel_var).grid(row=0, column=1, sticky="w")
        ttk.Checkbutton(
            reconnect,
            text="Automatischer Reconnect aktiv",
            style="Card.TCheckbutton",
            variable=self.auto_reconnect_var,
        ).grid(row=1, column=0, columnspan=2, sticky="w", pady=(8, 0))
        ttk.Label(reconnect, text="Reconnect-Wartezeit (Sek.)", style="CardLabel.TLabel").grid(
            row=2,
            column=0,
            sticky="w",
            padx=(0, 8),
            pady=(8, 0),
        )
        ttk.Spinbox(reconnect, from_=10, to=600, width=9, textvariable=self.reconnect_wait_seconds_var).grid(
            row=2,
            column=1,
            sticky="w",
            pady=(8, 0),
        )

        session_card, session = self._create_card(
            parent,
            "Session & Persistenz",
            "Automatisches Fortsetzen und Bereinigung fertiger Tasks",
        )
        session_card.grid(row=1, column=0, sticky="ew", pady=(10, 0))
        session.columnconfigure(1, weight=1)

        ttk.Checkbutton(
            session,
            text="Downloads beim Start automatisch fortsetzen",
            style="Card.TCheckbutton",
            variable=self.auto_resume_on_start_var,
        ).grid(row=0, column=0, columnspan=2, sticky="w")

        cleanup_label_var = tk.StringVar(
            value=self._finished_cleanup_label(self._normalize_finished_cleanup_policy(self.completed_cleanup_policy_var.get()))
        )
        ttk.Label(session, text="Fertiggestellte Downloads entfernen", style="CardLabel.TLabel").grid(
            row=1,
            column=0,
            sticky="w",
            pady=(8, 0),
            padx=(0, 8),
        )
        ttk.Combobox(
            session,
            textvariable=cleanup_label_var,
            values=tuple(FINISHED_TASK_CLEANUP_LABELS.values()),
            state="readonly",
            width=30,
        ).grid(row=1, column=1, sticky="w", pady=(8, 0))

        integrity_card, integrity = self._create_card(
            parent,
            "Integrität & Cleanup",
            "Datei-Prüfung und post-processing Verhalten",
        )
        integrity_card.grid(row=2, column=0, sticky="ew", pady=(10, 0))

        ttk.Checkbutton(
            integrity,
            text="Integritätsprüfung (SFV/CRC/MD5/SHA1) nach Download",
            style="Card.TCheckbutton",
            variable=self.enable_integrity_check_var,
        ).grid(row=0, column=0, sticky="w")
        ttk.Checkbutton(
            integrity,
            text="Downloadlink-Dateien nach Entpacken entfernen",
            style="Card.TCheckbutton",
            variable=self.remove_link_files_after_extract_var,
        ).grid(row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Checkbutton(
            integrity,
            text="Sample-Dateien/-Ordner nach Entpacken entfernen",
            style="Card.TCheckbutton",
            variable=self.remove_samples_var,
        ).grid(row=2, column=0, sticky="w", pady=(6, 0))

        extract_card, extract = self._create_card(
            parent,
            "Entpacken",
            "Konflikt- und Cleanup-Verhalten für Archive",
        )
        extract_card.grid(row=3, column=0, sticky="ew", pady=(10, 0))
        extract.columnconfigure(1, weight=1)

        ttk.Label(extract, text="Nach erfolgreichem Entpacken", style="CardLabel.TLabel").grid(
            row=0,
            column=0,
            sticky="w",
            padx=(0, 8),
        )
        self.cleanup_combo_settings_tab = ttk.Combobox(
            extract,
            values=tuple(CLEANUP_LABELS.values()),
            state="readonly",
            width=42,
        )
        self.cleanup_combo_settings_tab.set(self._cleanup_label(self._normalize_cleanup_mode(self.cleanup_mode_var.get())))
        self.cleanup_combo_settings_tab.grid(row=0, column=1, sticky="w")

        ttk.Label(extract, text="Wenn Datei bereits existiert", style="CardLabel.TLabel").grid(
            row=1,
            column=0,
            sticky="w",
            padx=(0, 8),
            pady=(8, 0),
        )
        self.conflict_combo_settings_tab = ttk.Combobox(
            extract,
            values=tuple(CONFLICT_LABELS.values()),
            state="readonly",
            width=42,
        )
        self.conflict_combo_settings_tab.set(self._conflict_label(self._normalize_extract_conflict_mode(self.extract_conflict_mode_var.get())))
        self.conflict_combo_settings_tab.grid(row=1, column=1, sticky="w", pady=(8, 0))

        buttons = ttk.Frame(parent, style="App.TFrame")
        buttons.grid(row=4, column=0, sticky="e", pady=(12, 0))

        def apply_settings() -> None:
            self.cleanup_mode_var.set(self._cleanup_mode_from_label(self.cleanup_combo_settings_tab.get()))
            self.extract_conflict_mode_var.set(self._conflict_mode_from_label(self.conflict_combo_settings_tab.get()))
            self.completed_cleanup_policy_var.set(self._finished_cleanup_policy_from_label(cleanup_label_var.get()))
            self._save_config()
            self.status_var.set("Settings gespeichert")

        ttk.Button(buttons, text="Settings speichern", style="Accent.TButton", command=apply_settings).pack(side="right")

    def _on_speed_limit_enabled_toggle(self) -> None:
        enabled = bool(self.speed_limit_enabled_var.get())
        state = "normal" if enabled else "disabled"
        try:
            self.speed_limit_spin.configure(state=state)
        except Exception:
            pass
        try:
            self.speed_mode_box.configure(state="readonly" if enabled else "disabled")
        except Exception:
            pass

        kbps = self._normalize_speed_limit_value(self.speed_limit_kbps_var.get()) if enabled else 0
        mode = self._normalize_speed_mode(self.speed_limit_mode_var.get())
        self._sync_speed_limit(kbps, mode)

    def _maybe_auto_resume_on_start(self) -> None:
        if not self.auto_resume_on_start_var.get():
            return
        if not self.resume_manifest_loaded:
            return
        if self.worker_thread and self.worker_thread.is_alive():
            return
        if not self.token_var.get().strip():
            self.status_var.set("Resume gefunden, aber API Token fehlt")
            return

        if self._normalize_finished_cleanup_policy(self.completed_cleanup_policy_var.get()) == "on_start":
            self._cleanup_finished_rows_on_start()

        self.status_var.set("Auto-Resume startet ...")
        self.start_downloads()

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

    @staticmethod
    def _normalize_cleanup_mode(value: str) -> str:
        mode = str(value or "none").strip().lower()
        return mode if mode in CLEANUP_MODE_CHOICES else "none"

    @staticmethod
    def _normalize_extract_conflict_mode(value: str) -> str:
        mode = str(value or "overwrite").strip().lower()
        return mode if mode in EXTRACT_CONFLICT_CHOICES else "overwrite"

    @staticmethod
    def _normalize_finished_cleanup_policy(value: str) -> str:
        policy = str(value or "never").strip().lower()
        return policy if policy in FINISHED_TASK_CLEANUP_CHOICES else "never"

    @staticmethod
    def _cleanup_label(mode: str) -> str:
        return CLEANUP_LABELS.get(mode, CLEANUP_LABELS["none"])

    @staticmethod
    def _finished_cleanup_label(policy: str) -> str:
        return FINISHED_TASK_CLEANUP_LABELS.get(policy, FINISHED_TASK_CLEANUP_LABELS["never"])

    @staticmethod
    def _finished_cleanup_policy_from_label(label: str) -> str:
        text = str(label or "").strip()
        for policy, policy_label in FINISHED_TASK_CLEANUP_LABELS.items():
            if text == policy_label:
                return policy
        return "never"

    @staticmethod
    def _cleanup_mode_from_label(label: str) -> str:
        text = str(label or "").strip()
        for mode, mode_label in CLEANUP_LABELS.items():
            if text == mode_label:
                return mode
        return "none"

    @staticmethod
    def _conflict_label(mode: str) -> str:
        return CONFLICT_LABELS.get(mode, CONFLICT_LABELS["overwrite"])

    @staticmethod
    def _conflict_mode_from_label(label: str) -> str:
        text = str(label or "").strip()
        for mode, mode_label in CONFLICT_LABELS.items():
            if text == mode_label:
                return mode
        return "overwrite"

    def _open_settings_window(self) -> None:
        if self.settings_window and self.settings_window.winfo_exists():
            self.settings_window.focus_set()
            return

        window = tk.Toplevel(self)
        window.title("Settings")
        window.transient(self)
        window.grab_set()
        window.geometry("760x360")
        window.minsize(700, 320)
        self.settings_window = window

        root = ttk.Frame(window, padding=12)
        root.pack(fill="both", expand=True)
        root.columnconfigure(1, weight=1)

        ttk.Label(root, text="Nach erfolgreichem Entpacken:").grid(row=0, column=0, sticky="w", padx=(0, 8), pady=(0, 10))
        cleanup_label_var = tk.StringVar(value=self._cleanup_label(self._normalize_cleanup_mode(self.cleanup_mode_var.get())))
        cleanup_combo = ttk.Combobox(
            root,
            textvariable=cleanup_label_var,
            values=tuple(CLEANUP_LABELS.values()),
            state="readonly",
            width=58,
        )
        cleanup_combo.grid(row=0, column=1, sticky="ew", pady=(0, 10))

        ttk.Label(root, text="Wenn Datei bereits existiert:").grid(row=1, column=0, sticky="w", padx=(0, 8), pady=(0, 10))
        conflict_label_var = tk.StringVar(value=self._conflict_label(self._normalize_extract_conflict_mode(self.extract_conflict_mode_var.get())))
        conflict_combo = ttk.Combobox(
            root,
            textvariable=conflict_label_var,
            values=tuple(CONFLICT_LABELS.values()),
            state="readonly",
            width=58,
        )
        conflict_combo.grid(row=1, column=1, sticky="ew", pady=(0, 10))

        remove_links_var = tk.BooleanVar(value=self.remove_link_files_after_extract_var.get())
        ttk.Checkbutton(
            root,
            text="Downloadlinks in Archiven nach erfolgreichem Entpacken entfernen?",
            variable=remove_links_var,
        ).grid(row=2, column=0, columnspan=2, sticky="w", pady=(0, 8))

        remove_samples_var = tk.BooleanVar(value=self.remove_samples_var.get())
        ttk.Checkbutton(
            root,
            text="Sample-Dateien/-Ordner nach dem Entpacken entfernen",
            variable=remove_samples_var,
        ).grid(row=3, column=0, columnspan=2, sticky="w", pady=(0, 12))

        buttons = ttk.Frame(root)
        buttons.grid(row=4, column=0, columnspan=2, sticky="e")
        ttk.Button(
            buttons,
            text="Speichern",
            command=lambda: self._save_settings_window(
                cleanup_label_var.get(),
                conflict_label_var.get(),
                remove_links_var.get(),
                remove_samples_var.get(),
            ),
        ).pack(side="right")
        ttk.Button(buttons, text="Abbrechen", command=self._close_settings_window).pack(side="right", padx=(0, 8))

        window.protocol("WM_DELETE_WINDOW", self._close_settings_window)

    def _save_settings_window(
        self,
        cleanup_label: str,
        conflict_label: str,
        remove_link_files_after_extract: bool,
        remove_samples: bool,
    ) -> None:
        cleanup_mode = self._cleanup_mode_from_label(cleanup_label)
        conflict_mode = self._conflict_mode_from_label(conflict_label)
        self.cleanup_mode_var.set(cleanup_mode)
        self.extract_conflict_mode_var.set(conflict_mode)
        self.remove_link_files_after_extract_var.set(bool(remove_link_files_after_extract))
        self.remove_samples_var.set(bool(remove_samples))
        self._save_config()

        self._close_settings_window()

    def _close_settings_window(self) -> None:
        if self.settings_window and self.settings_window.winfo_exists():
            window = self.settings_window
            try:
                window.grab_release()
            except Exception:
                pass
            self.settings_window = None
            window.destroy()

    def _clear_links(self) -> None:
        self.links_text.delete("1.0", "end")

    def _clear_progress_only(self) -> None:
        if self.worker_thread and self.worker_thread.is_alive():
            messagebox.showinfo("Hinweis", "Fortschritt kann während Downloads nicht gelöscht werden")
            return
        self._clear_progress_view()
        with self.speed_events_lock:
            self.speed_events.clear()
        self.speed_var.set("Geschwindigkeit: 0 B/s")
        self.eta_var.set("ETA: --")
        self.status_var.set("Bereit")
        self.overall_progress_var.set(0.0)

    def _clear_all_lists(self) -> None:
        self._clear_links()
        self._clear_progress_only()

    @staticmethod
    def _is_finished_status_text(status_text: str) -> bool:
        text = str(status_text or "").strip().lower()
        return text.startswith("fertig") or "bereits fertig" in text or text.startswith("entpacken fertig")

    def _remove_links_from_text(self, links_to_remove: list[str]) -> None:
        if not links_to_remove:
            return
        lines = [line.strip() for line in self.links_text.get("1.0", "end").splitlines() if line.strip()]
        for link in links_to_remove:
            if link in lines:
                lines.remove(link)
        self._set_links_text_lines(lines)

    def _cleanup_finished_rows_on_start(self) -> None:
        links_to_remove: list[str] = []
        package_ids = list(self.table.get_children(""))
        for package_row_id in package_ids:
            if not self.table.exists(package_row_id):
                continue
            child_ids = list(self.table.get_children(package_row_id))
            remove_child_ids: list[str] = []
            for child_id in child_ids:
                values = list(self.table.item(child_id, "values"))
                status_text = str(values[1]) if len(values) >= 2 else ""
                if self._is_finished_status_text(status_text):
                    remove_child_ids.append(child_id)
                    link_text = str(self.table.item(child_id, "text")).strip()
                    if link_text:
                        links_to_remove.append(link_text)

            for child_id in remove_child_ids:
                if self.table.exists(child_id):
                    self.table.delete(child_id)

            if self.table.exists(package_row_id) and not self.table.get_children(package_row_id):
                self.table.delete(package_row_id)

        self._remove_links_from_text(links_to_remove)

    def _clear_progress_view(self) -> None:
        self.table.delete(*self.table.get_children())
        self.row_map.clear()
        self.package_row_id = None
        self.package_contexts = []
        with self.package_cancel_lock:
            self.cancelled_package_rows.clear()

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
        selected = list(self.table.selection())
        if not selected:
            return

        running = bool(self.worker_thread and self.worker_thread.is_alive())
        if running:
            package_rows: set[str] = set()
            for row_id in selected:
                if not self.table.exists(row_id):
                    continue
                parent = self.table.parent(row_id)
                package_row_id = row_id if not parent else parent
                if package_row_id:
                    package_rows.add(package_row_id)

            if not package_rows:
                return

            context_map = {
                str(context.get("package_row_id")): context
                for context in self.package_contexts
                if isinstance(context, dict)
            }
            active_rows = [row_id for row_id in package_rows if row_id in context_map]
            if not active_rows:
                return

            if not messagebox.askyesno(
                "Paket abbrechen",
                "Ausgewählte Pakete wirklich abbrechen?\n\n"
                "- laufender Download stoppt sofort\n"
                "- unvollständige Archivdateien im Paketordner werden entfernt\n"
                "- bereits entpackte Dateien bleiben erhalten",
            ):
                return

            links_to_remove: list[str] = []
            removed_package_count = 0
            for package_row_id in active_rows:
                context = context_map.get(package_row_id) or {}
                job = context.get("job") if isinstance(context, dict) else None
                if isinstance(job, dict):
                    links_to_remove.extend(
                        str(link).strip()
                        for link in job.get("links", [])
                        if str(link).strip()
                    )
                self._request_package_cancel(package_row_id)
                if self.table.exists(package_row_id):
                    self.table.delete(package_row_id)
                removed_package_count += 1

            if links_to_remove:
                lines = [line.strip() for line in self.links_text.get("1.0", "end").splitlines() if line.strip()]
                for link in links_to_remove:
                    if link in lines:
                        lines.remove(link)
                self._set_links_text_lines(lines)

            self._queue_status(f"{removed_package_count} Paket(e) abgebrochen und aus der Liste entfernt")
            return

        row_ids_to_remove: set[str] = set()
        links_to_remove: list[str] = []

        for row_id in selected:
            if not self.table.exists(row_id):
                continue

            parent = self.table.parent(row_id)
            if not parent:
                row_ids_to_remove.add(row_id)
                for child_id in self.table.get_children(row_id):
                    row_ids_to_remove.add(child_id)
                    link_text = str(self.table.item(child_id, "text")).strip()
                    if link_text:
                        links_to_remove.append(link_text)
            else:
                row_ids_to_remove.add(row_id)
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

        self.row_map.clear()
        self.package_row_id = None
        self.package_contexts = []

    def _ensure_tooltip(self) -> None:
        if self.tooltip_window and self.tooltip_window.winfo_exists() and self.tooltip_label:
            return
        self.tooltip_window = tk.Toplevel(self)
        self.tooltip_window.withdraw()
        self.tooltip_window.overrideredirect(True)
        self.tooltip_label = ttk.Label(self.tooltip_window, text="", background="#fffbe6", relief="solid", padding=6)
        self.tooltip_label.pack()

    def _on_table_motion(self, event: tk.Event) -> None:
        row_id = self.table.identify_row(event.y)
        column_id = self.table.identify_column(event.x)
        if not row_id or column_id != "#2":
            self._hide_status_tooltip()
            return

        values = list(self.table.item(row_id, "values"))
        if len(values) < 2:
            self._hide_status_tooltip()
            return

        status_text = str(values[1]).strip()
        if not status_text:
            self._hide_status_tooltip()
            return

        self._ensure_tooltip()
        if not self.tooltip_window or not self.tooltip_label:
            return

        if self.tooltip_row != row_id or self.tooltip_column != column_id or self.tooltip_label.cget("text") != status_text:
            self.tooltip_label.configure(text=status_text)
            self.tooltip_row = row_id
            self.tooltip_column = column_id

        self.tooltip_window.geometry(f"+{event.x_root + 14}+{event.y_root + 14}")
        self.tooltip_window.deiconify()
        self.tooltip_window.lift()

    def _hide_status_tooltip(self, _event: tk.Event | None = None) -> None:
        self.tooltip_row = ""
        self.tooltip_column = ""
        if self.tooltip_window and self.tooltip_window.winfo_exists():
            self.tooltip_window.withdraw()

    def _manifest_signature(self, packages: list[DownloadPackage], output_dir: Path) -> str:
        payload = {
            "output_dir": str(output_dir),
            "packages": [{"name": pkg.name, "links": pkg.links} for pkg in packages],
        }
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        return hashlib.sha256(raw).hexdigest()

    def _load_manifest_file(self) -> dict:
        if not MANIFEST_FILE.exists():
            return {}
        try:
            payload = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
            return payload if isinstance(payload, dict) else {}
        except Exception as exc:
            LOGGER.error("Manifest konnte nicht geladen werden: %s", exc)
            return {}

    def _save_manifest_file(self) -> None:
        with self.manifest_lock:
            if not self.manifest_data:
                return
            payload = json.dumps(self.manifest_data, indent=2, ensure_ascii=False)
        try:
            MANIFEST_FILE.write_text(payload, encoding="utf-8")
        except Exception as exc:
            LOGGER.error("Manifest konnte nicht gespeichert werden: %s", exc)

    def _set_manifest_for_run(
        self,
        packages: list[dict],
        output_dir: Path,
        signature: str,
        resume_map: dict[str, set[int]] | None = None,
    ) -> None:
        resume_map = resume_map or {}
        with self.manifest_lock:
            self.manifest_data = {
                "version": 1,
                "saved_at": datetime.now().isoformat(timespec="seconds"),
                "output_dir": str(output_dir),
                "signature": signature,
                "finished": False,
                "packages": [
                    {
                        "name": str(package["name"]),
                        "links": list(package["links"]),
                        "completed": sorted(int(x) for x in resume_map.get(str(package["name"]), set())),
                        "failed": [],
                    }
                    for package in packages
                ],
            }
        self._save_manifest_file()

    def _mark_manifest_link(self, package_name: str, link_index: int, success: bool) -> None:
        with self.manifest_lock:
            packages = self.manifest_data.get("packages") or []
            for package in packages:
                if str(package.get("name")) != package_name:
                    continue
                key = "completed" if success else "failed"
                values = set(int(x) for x in package.get(key, []) if isinstance(x, int) or str(x).isdigit())
                values.add(int(link_index))
                package[key] = sorted(values)
                break
            self.manifest_data["saved_at"] = datetime.now().isoformat(timespec="seconds")
        self._save_manifest_file()

    def _finish_manifest(self, summary: str) -> None:
        with self.manifest_lock:
            if not self.manifest_data:
                return
            self.manifest_data["finished"] = True
            self.manifest_data["summary"] = summary
            self.manifest_data["saved_at"] = datetime.now().isoformat(timespec="seconds")
        self._save_manifest_file()

    def _restore_manifest_into_links(self) -> None:
        manifest = self._load_manifest_file()
        if not manifest or manifest.get("finished"):
            self.resume_manifest_loaded = False
            return
        packages = manifest.get("packages")
        if not isinstance(packages, list) or not packages:
            return

        restored_packages: list[DownloadPackage] = []
        cleanup_on_start = self._normalize_finished_cleanup_policy(self.completed_cleanup_policy_var.get()) == "on_start"
        for package in packages:
            if not isinstance(package, dict):
                continue
            name = sanitize_filename(str(package.get("name") or "Paket"))
            raw_links = [str(link).strip() for link in package.get("links", []) if str(link).strip()]
            completed_indices = {
                int(x)
                for x in package.get("completed", [])
                if isinstance(x, int) or str(x).isdigit()
            }
            links: list[str] = []
            for idx, link in enumerate(raw_links, start=1):
                if cleanup_on_start and idx in completed_indices:
                    continue
                links.append(link)
            if links:
                restored_packages.append(DownloadPackage(name=name, links=links))
        if not restored_packages:
            self.resume_manifest_loaded = False
            return

        self._set_packages_to_links_text(restored_packages)
        self.output_dir_var.set(str(manifest.get("output_dir") or self.output_dir_var.get()))
        self.status_var.set("Ungesicherte Session gefunden. Resume ist vorbereitet.")
        self.resume_manifest_loaded = True

    def _can_store_token_securely(self) -> bool:
        return keyring is not None

    def _load_token_from_keyring(self) -> str:
        if not self._can_store_token_securely():
            return ""
        try:
            token = keyring.get_password(KEYRING_SERVICE, KEYRING_USERNAME)
            return token or ""
        except Exception as exc:
            LOGGER.error("Token aus Keyring konnte nicht geladen werden: %s", exc)
            return ""

    def _store_token_in_keyring(self, token: str) -> bool:
        if not self._can_store_token_securely():
            return False
        try:
            if token:
                keyring.set_password(KEYRING_SERVICE, KEYRING_USERNAME, token)
            else:
                keyring.delete_password(KEYRING_SERVICE, KEYRING_USERNAME)
            return True
        except Exception as exc:
            LOGGER.error("Token im Keyring konnte nicht gespeichert werden: %s", exc)
            return False

    @staticmethod
    def _has_enough_disk_space(target_dir: Path, required_bytes: int, reserve_bytes: int = 200 * 1024 * 1024) -> bool:
        if required_bytes <= 0:
            return True
        try:
            usage = shutil.disk_usage(target_dir)
        except Exception:
            return True
        return usage.free >= required_bytes + reserve_bytes

    def _is_package_cancelled(self, package_row_id: str | None) -> bool:
        if not package_row_id:
            return False
        with self.package_cancel_lock:
            return package_row_id in self.cancelled_package_rows

    def _request_package_cancel(self, package_row_id: str) -> None:
        with self.package_cancel_lock:
            self.cancelled_package_rows.add(package_row_id)

    @staticmethod
    def _is_archive_or_temp_file(path: Path) -> bool:
        name_lower = path.name.lower()
        suffix = path.suffix.lower()
        if suffix in ARCHIVE_TEMP_EXTENSIONS:
            return True
        if ".part" in name_lower and name_lower.endswith(".rar"):
            return True
        if RAR_SPLIT_RE.search(name_lower):
            return True
        return False

    def _cleanup_cancelled_package_artifacts(self, package_dir: Path) -> int:
        if not package_dir.exists() or not package_dir.is_dir():
            return 0

        removed = 0
        paths = sorted(package_dir.rglob("*"), key=lambda path: len(path.parts), reverse=True)
        for path in paths:
            if path.is_file() and self._is_archive_or_temp_file(path):
                try:
                    path.unlink(missing_ok=True)
                    removed += 1
                except Exception:
                    continue

        for path in paths:
            if not path.is_dir():
                continue
            if path == package_dir:
                continue
            try:
                path.rmdir()
            except Exception:
                continue

        return removed

    def _wait_if_paused(self, package_row_id: str | None = None) -> None:
        while self.pause_event.is_set() and not self.stop_event.is_set():
            if self._is_package_cancelled(package_row_id):
                return
            sleep(0.15)

    def _is_reconnect_active(self) -> bool:
        with self.reconnect_lock:
            return monotonic() < self.reconnect_active_until

    def _request_reconnect(self, reason: str) -> None:
        if not self.auto_reconnect_var.get():
            return
        wait_seconds = max(10, min(int(self.reconnect_wait_seconds_var.get() or 45), 600))
        with self.reconnect_lock:
            deadline = monotonic() + wait_seconds
            if deadline > self.reconnect_active_until:
                self.reconnect_active_until = deadline
            self.reconnect_requested = True
            self.reconnect_reason = reason
        self._queue_status(f"Reconnect-Wartefenster aktiv ({wait_seconds}s): {reason}")

    def _wait_for_reconnect_window(self, row_index: int, package_row_id: str | None = None) -> None:
        while not self.stop_event.is_set() and not self._is_package_cancelled(package_row_id):
            with self.reconnect_lock:
                remaining = self.reconnect_active_until - monotonic()
                reason = self.reconnect_reason
            if remaining <= 0:
                break
            self._queue_row(
                row_index,
                package_row_id=package_row_id,
                status=f"Reconnect-Wait {int(remaining)}s ({reason})",
                speed="0 B/s",
            )
            sleep(min(1.0, max(0.1, remaining)))

    @staticmethod
    def _parse_hash_line(line: str) -> tuple[str, str] | None:
        text = str(line or "").strip()
        if not text or text.startswith(";"):
            return None
        md = re.match(r"^([0-9a-fA-F]{8,64})\s+\*?(.+)$", text)
        if md:
            return md.group(2).strip(), md.group(1).lower()
        sfv = re.match(r"^(.+?)\s+([0-9A-Fa-f]{8})$", text)
        if sfv:
            return sfv.group(1).strip(), sfv.group(2).lower()
        return None

    def _hash_manifest_for_dir(self, package_dir: Path) -> dict[str, tuple[str, str]]:
        key = str(package_dir)
        with self.integrity_cache_lock:
            cached = self.integrity_cache.get(key)
            if cached is not None:
                return cached

        mapping: dict[str, tuple[str, str]] = {}
        if not package_dir.exists():
            return mapping
        for ext, algo in (("*.sfv", "crc32"), ("*.md5", "md5"), ("*.sha1", "sha1")):
            for hash_file in package_dir.glob(ext):
                try:
                    lines = hash_file.read_text(encoding="utf-8", errors="ignore").splitlines()
                except Exception:
                    continue
                for line in lines:
                    parsed = self._parse_hash_line(line)
                    if not parsed:
                        continue
                    file_name, digest = parsed
                    mapping[file_name.lower()] = (algo, digest)

        with self.integrity_cache_lock:
            self.integrity_cache[key] = mapping
        return mapping

    def _validate_file_integrity(self, file_path: Path, package_dir: Path) -> tuple[bool, str]:
        manifest = self._hash_manifest_for_dir(package_dir)
        if not manifest:
            return True, "Kein Hash verfügbar"

        expected = manifest.get(file_path.name.lower())
        if not expected:
            return True, "Kein Hash für Datei"

        algo, digest = expected
        if algo == "crc32":
            import binascii

            crc = 0
            with file_path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    crc = binascii.crc32(chunk, crc)
            actual = f"{crc & 0xFFFFFFFF:08x}"
        else:
            hasher = hashlib.new(algo)
            with file_path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    hasher.update(chunk)
            actual = hasher.hexdigest().lower()

        if actual.lower() == digest.lower():
            return True, f"{algo.upper()} ok"
        return False, f"{algo.upper()} mismatch"

    def toggle_pause_downloads(self) -> None:
        if not (self.worker_thread and self.worker_thread.is_alive()):
            return
        if self.pause_event.is_set():
            self.pause_event.clear()
            self.pause_button.configure(text="Pause")
            self.status_var.set("Resume: Downloads laufen weiter")
            LOGGER.info("Downloads wurden fortgesetzt")
        else:
            self.pause_event.set()
            self.pause_button.configure(text="Resume")
            self.status_var.set("Pausiert")
            LOGGER.info("Downloads wurden pausiert")

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
    def _unique_preserve_order(items: list[str]) -> list[str]:
        seen: set[str] = set()
        result: list[str] = []
        for item in items:
            key = item.strip()
            if not key or key in seen:
                continue
            seen.add(key)
            result.append(key)
        return result

    def _parse_packages_from_links_text(self, raw_text: str, default_package_name: str) -> list[DownloadPackage]:
        packages: list[DownloadPackage] = []
        current_name = default_package_name.strip()
        current_links: list[str] = []

        def flush_current() -> None:
            nonlocal current_name, current_links
            links = self._unique_preserve_order(current_links)
            if not links:
                current_links = []
                return

            inferred = infer_package_name_from_links(links)
            package_name = sanitize_filename(current_name or inferred or f"Paket-{len(packages) + 1:03d}")
            packages.append(DownloadPackage(name=package_name, links=links))
            current_links = []

        for line in raw_text.splitlines():
            text = line.strip()
            if not text:
                continue

            marker = PACKAGE_MARKER_RE.match(text)
            if marker:
                flush_current()
                current_name = marker.group(1).strip()
                continue

            current_links.append(text)

        flush_current()
        return packages

    def _set_packages_to_links_text(self, packages: list[DownloadPackage]) -> None:
        lines: list[str] = []
        for package in packages:
            lines.append(f"# package: {package.name}")
            lines.extend(package.links)
            lines.append("")

        content = "\n".join(lines).strip()
        if content:
            content += "\n"
        self.links_text.delete("1.0", "end")
        self.links_text.insert("1.0", content)

    def _setup_dlc_drag_and_drop(self) -> None:
        if DND_FILES is None:
            return
        try:
            self.links_text.drop_target_register(DND_FILES)
            self.links_text.dnd_bind("<<Drop>>", self._on_links_drop)
            self.dnd_ready = True
        except Exception as exc:
            self.dnd_ready = False
            LOGGER.warning("Drag-and-Drop konnte nicht aktiviert werden: %s", exc)

    def _on_links_drop(self, event: tk.Event) -> str:
        raw_data = str(getattr(event, "data", "") or "")
        paths = self._parse_dropped_paths(raw_data)
        if not paths:
            self.status_var.set("Drop ignoriert: keine Datei erkannt")
            return "break"

        dlc_files = [path for path in paths if path.suffix.lower() == ".dlc"]
        if not dlc_files:
            self.status_var.set("Drop ignoriert: bitte eine .dlc Datei ziehen")
            return "break"

        if len(dlc_files) > 1:
            self.status_var.set(f"Mehrere DLC-Dateien erkannt ({len(dlc_files)}), lade die erste ...")

        self._import_dlc_path(dlc_files[0], source="Drag-and-Drop")
        return "break"

    def _parse_dropped_paths(self, raw_data: str) -> list[Path]:
        text = str(raw_data or "").strip()
        if not text:
            return []

        parts: tuple[str, ...]
        try:
            parts = tuple(self.tk.splitlist(text))
        except Exception:
            parts = (text,)

        result: list[Path] = []
        for part in parts:
            value = str(part).strip().strip("{}\"")
            if not value:
                continue
            candidate = Path(value)
            if candidate.exists() and candidate.is_file():
                result.append(candidate)
        return result

    def _import_dlc_path(self, file_path: Path, source: str = "DLC Import") -> None:
        try:
            packages = self._decrypt_dlc_file(file_path)
        except Exception as exc:
            messagebox.showerror("DLC Import", f"DLC konnte nicht importiert werden: {exc}")
            return

        if not packages:
            messagebox.showerror("DLC Import", "Keine Links im DLC gefunden")
            return

        self._set_packages_to_links_text(packages)
        if len(packages) == 1:
            self.package_name_var.set(packages[0].name)
        else:
            self.package_name_var.set("")

        total_links = sum(len(package.links) for package in packages)
        self.status_var.set(f"{source}: {len(packages)} Paket(e), {total_links} Link(s)")
        LOGGER.info("%s: %s Paket(e), %s Link(s)", source, len(packages), total_links)

    def _import_dlc_file(self) -> None:
        file_path = filedialog.askopenfilename(
            title="DLC importieren",
            initialdir=str(Path.home() / "Desktop"),
            filetypes=(("DLC Container", "*.dlc"), ("Alle Dateien", "*.*")),
        )
        if not file_path:
            return
        self._import_dlc_path(Path(file_path), source="DLC importiert")

    def _decrypt_dlc_file(self, file_path: Path) -> list[DownloadPackage]:
        # Primary: local decryption via JDownloader DLC service (preserves
        # real package names like JDownloader does).
        if _AES is not None:
            try:
                packages = self._decrypt_dlc_local(file_path)
                if packages:
                    return packages
            except Exception:
                pass  # fall through to dcrypt.it

        # Fallback: dcrypt.it (no package structure, only flat link list).
        with file_path.open("rb") as handle:
            response = requests.post(
                DCRYPT_UPLOAD_URL,
                files={"dlcfile": (file_path.name, handle, "application/octet-stream")},
                timeout=120,
            )

        if not response.ok:
            raise RuntimeError(parse_error_message(response))

        payload = self._decode_dcrypt_payload(response.text)
        if isinstance(payload, dict):
            errors = payload.get("form_errors")
            if isinstance(errors, dict) and errors:
                details: list[str] = []
                for value in errors.values():
                    if isinstance(value, list):
                        details.extend(str(item) for item in value)
                    else:
                        details.append(str(value))
                raise RuntimeError("; ".join(details) if details else "DLC konnte nicht entschluesselt werden")

        packages = self._extract_packages_from_payload(payload)

        # When the payload contains a single flat link list (e.g. dcrypt.it
        # ``{"success": {"links": [...]}}``), _extract_packages_from_payload
        # will lump everything into one package.  Re-group by filename so that
        # distinct releases end up in separate packages.
        if len(packages) == 1:
            regrouped = self._group_links_by_inferred_name(packages[0].links)
            if len(regrouped) > 1:
                packages = regrouped

        if not packages:
            links = self._extract_urls_recursive(payload)
            packages = self._group_links_by_inferred_name(links)

        if not packages:
            links = self._extract_urls_recursive(response.text)
            packages = self._group_links_by_inferred_name(links)

        return packages

    def _decrypt_dlc_local(self, file_path: Path) -> list[DownloadPackage]:
        """Decrypt a DLC container locally via JDownloader's DLC service.

        Returns a list of DownloadPackage with the real release names that
        are embedded in the DLC container's XML structure.
        """
        content = file_path.read_text(encoding="ascii", errors="ignore").strip()
        if len(content) < 89:
            return []

        dlc_key = content[-88:]
        dlc_data = content[:-88]

        # Ask JDownloader service for the RC token.
        url = DLC_SERVICE_URL.format(dlc_key)
        with urllib.request.urlopen(url, timeout=30) as resp:
            rc_response = resp.read().decode("utf-8")

        rc_match = re.search(r"<rc>(.*?)</rc>", rc_response)
        if not rc_match:
            return []

        # Decrypt RC to obtain the real AES key.
        rc_bytes = base64.b64decode(rc_match.group(1))
        cipher = _AES.new(DLC_AES_KEY, _AES.MODE_CBC, DLC_AES_IV)
        real_key = cipher.decrypt(rc_bytes)[:16]

        # Decrypt the main payload.
        encrypted = base64.b64decode(dlc_data)
        cipher2 = _AES.new(real_key, _AES.MODE_CBC, real_key)
        decrypted = cipher2.decrypt(encrypted)
        # Strip PKCS7 padding.
        pad = decrypted[-1]
        if 1 <= pad <= 16 and decrypted[-pad:] == bytes([pad]) * pad:
            decrypted = decrypted[:-pad]

        xml_data = base64.b64decode(decrypted).decode("utf-8")
        root = ET.fromstring(xml_data)
        content_node = root.find("content")
        if content_node is None:
            return []

        packages: list[DownloadPackage] = []
        for pkg_el in content_node.findall("package"):
            name_b64 = pkg_el.get("name", "")
            name = base64.b64decode(name_b64).decode("utf-8") if name_b64 else ""

            urls: list[str] = []
            for file_el in pkg_el.findall("file"):
                url_el = file_el.find("url")
                if url_el is not None and url_el.text:
                    urls.append(base64.b64decode(url_el.text.strip()).decode("utf-8"))

            if urls:
                package_name = sanitize_filename(name or infer_package_name_from_links(urls) or f"Paket-{len(packages) + 1:03d}")
                packages.append(DownloadPackage(name=package_name, links=self._unique_preserve_order(urls)))

        return packages

    def _decode_dcrypt_payload(self, response_text: str) -> object:
        text = response_text.strip()
        match = re.search(r"<textarea[^>]*>(.*?)</textarea>", text, flags=re.IGNORECASE | re.DOTALL)
        if match:
            text = html.unescape(match.group(1).strip())

        if not text:
            return ""

        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    def _extract_urls_recursive(self, data: object) -> list[str]:
        links: list[str] = []
        if isinstance(data, str):
            links.extend(re.findall(r"https?://[^\s\"'<>]+", data))
            return self._unique_preserve_order(links)

        if isinstance(data, dict):
            for value in data.values():
                links.extend(self._extract_urls_recursive(value))
            return self._unique_preserve_order(links)

        if isinstance(data, list):
            for item in data:
                links.extend(self._extract_urls_recursive(item))
            return self._unique_preserve_order(links)

        return []

    def _extract_packages_from_payload(self, payload: object) -> list[DownloadPackage]:
        discovered: list[DownloadPackage] = []

        def walk(node: object, parent_name: str = "") -> None:
            if isinstance(node, dict):
                name = ""
                for key in ("package", "package_name", "packagename", "name", "title"):
                    value = node.get(key)
                    if isinstance(value, str) and value.strip():
                        name = value.strip()
                        break

                direct_links: list[str] = []
                for key in ("links", "urls", "url", "downloads", "download"):
                    if key in node:
                        direct_links.extend(self._extract_urls_recursive(node.get(key)))

                if direct_links:
                    package_name = sanitize_filename(name or parent_name or infer_package_name_from_links(direct_links) or "Paket")
                    discovered.append(DownloadPackage(name=package_name, links=self._unique_preserve_order(direct_links)))

                next_parent = name or parent_name
                for value in node.values():
                    walk(value, next_parent)
                return

            if isinstance(node, list):
                for item in node:
                    walk(item, parent_name)

        walk(payload)

        grouped: dict[str, list[str]] = {}
        for package in discovered:
            grouped.setdefault(package.name, [])
            grouped[package.name].extend(package.links)

        result = [DownloadPackage(name=name, links=self._unique_preserve_order(links)) for name, links in grouped.items() if links]
        return result

    def _group_links_by_inferred_name(self, links: list[str]) -> list[DownloadPackage]:
        unique_links = self._unique_preserve_order(links)
        if not unique_links:
            return []

        grouped: dict[str, list[str]] = {}
        for link in unique_links:
            inferred = infer_package_name_from_links([link])
            package_name = sanitize_filename(inferred or "Paket")
            grouped.setdefault(package_name, []).append(link)

        return [DownloadPackage(name=name, links=package_links) for name, package_links in grouped.items() if package_links]

    @staticmethod
    def _normalize_parallel_value(value: int) -> int:
        return max(1, min(int(value), 50))

    @staticmethod
    def _normalize_speed_limit_value(value: int) -> int:
        return max(0, min(int(value), 500000))

    @staticmethod
    def _normalize_speed_mode(value: str) -> str:
        mode = str(value or "global").strip().lower()
        return mode if mode in SPEED_MODE_CHOICES else "global"

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
        effective = normalized if self.speed_limit_enabled_var.get() else 0
        self._sync_speed_limit(effective, mode)
        if self.worker_thread and self.worker_thread.is_alive():
            self._queue_status(f"Speed-Limit live angepasst: {effective} KB/s ({mode})")

    def _on_speed_mode_change(self, *_: object) -> None:
        mode = self._normalize_speed_mode(self.speed_limit_mode_var.get())
        if mode != self.speed_limit_mode_var.get():
            self.speed_limit_mode_var.set(mode)
            return

        kbps = self._normalize_speed_limit_value(self.speed_limit_kbps_var.get())
        effective = kbps if self.speed_limit_enabled_var.get() else 0
        self._sync_speed_limit(effective, mode)
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
                    messagebox.showinfo("Update", "Update-Prüfung läuft bereits")
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
                self.ui_queue.put(("update_error", "Update-Download läuft bereits"))
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
        except Exception as exc:
            LOGGER.error("Konfiguration konnte nicht geladen werden: %s", exc)
            messagebox.showwarning("Konfiguration", f"Konfigurationsdatei ist beschädigt: {exc}")
            return

        self.output_dir_var.set(data.get("output_dir", self.output_dir_var.get()))
        self.package_name_var.set(data.get("package_name", ""))
        self.auto_extract_var.set(bool(data.get("auto_extract", True)))
        self.extract_dir_var.set(data.get("extract_dir", self.extract_dir_var.get()))
        self.create_extract_subfolder_var.set(bool(data.get("create_extract_subfolder", True)))
        self.hybrid_extract_var.set(bool(data.get("hybrid_extract", True)))
        cleanup_mode = data.get("cleanup_mode")
        if cleanup_mode is None:
            cleanup_mode = "delete" if bool(data.get("cleanup_after_extract", False)) else "none"
        self.cleanup_mode_var.set(self._normalize_cleanup_mode(str(cleanup_mode)))
        self.extract_conflict_mode_var.set(
            self._normalize_extract_conflict_mode(str(data.get("extract_conflict_mode", "overwrite")))
        )
        self.remove_link_files_after_extract_var.set(bool(data.get("remove_link_files_after_extract", False)))
        self.remove_samples_var.set(bool(data.get("remove_samples_after_extract", False)))
        self.enable_integrity_check_var.set(bool(data.get("enable_integrity_check", True)))
        self.auto_resume_on_start_var.set(bool(data.get("auto_resume_on_start", True)))
        self.auto_reconnect_var.set(bool(data.get("auto_reconnect", False)))
        try:
            reconnect_wait = int(data.get("reconnect_wait_seconds", self.reconnect_wait_seconds_var.get()))
        except Exception:
            reconnect_wait = self.reconnect_wait_seconds_var.get()
        self.reconnect_wait_seconds_var.set(max(10, min(reconnect_wait, 600)))
        self.completed_cleanup_policy_var.set(
            self._normalize_finished_cleanup_policy(str(data.get("completed_cleanup_policy", "never")))
        )
        try:
            max_parallel = int(data.get("max_parallel", self.max_parallel_var.get()))
        except Exception:
            max_parallel = self.max_parallel_var.get()
        self.max_parallel_var.set(max(1, min(max_parallel, 50)))

        try:
            speed_limit = int(data.get("speed_limit_kbps", self.speed_limit_kbps_var.get()))
        except Exception:
            speed_limit = self.speed_limit_kbps_var.get()
        normalized_speed_limit = self._normalize_speed_limit_value(speed_limit)
        self.speed_limit_kbps_var.set(normalized_speed_limit)
        self.speed_limit_enabled_var.set(bool(data.get("speed_limit_enabled", normalized_speed_limit > 0)))
        self.speed_limit_mode_var.set(self._normalize_speed_mode(str(data.get("speed_limit_mode", "global"))))

        update_repo = str(data.get("update_repo", DEFAULT_UPDATE_REPO)).strip() or DEFAULT_UPDATE_REPO
        self.update_repo_var.set(update_repo)
        self.auto_update_check_var.set(bool(data.get("auto_update_check", True)))
        remember_token = bool(data.get("remember_token", True))
        self.remember_token_var.set(remember_token)
        if remember_token:
            token_from_keyring = self._load_token_from_keyring()
            if token_from_keyring:
                self.token_var.set(token_from_keyring)
            else:
                self.token_var.set(data.get("token", ""))

    def _save_config(self) -> None:
        token = self.token_var.get().strip() if self.remember_token_var.get() else ""
        if self.remember_token_var.get() and self._can_store_token_securely():
            if self._store_token_in_keyring(token):
                token = ""
        elif not self.remember_token_var.get() and self._can_store_token_securely():
            self._store_token_in_keyring("")
        data = {
            "token": token,
            "remember_token": self.remember_token_var.get(),
            "output_dir": self.output_dir_var.get().strip(),
            "package_name": self.package_name_var.get().strip(),
            "auto_extract": self.auto_extract_var.get(),
            "extract_dir": self.extract_dir_var.get().strip(),
            "create_extract_subfolder": self.create_extract_subfolder_var.get(),
            "hybrid_extract": self.hybrid_extract_var.get(),
            "cleanup_mode": self._normalize_cleanup_mode(self.cleanup_mode_var.get()),
            "extract_conflict_mode": self._normalize_extract_conflict_mode(self.extract_conflict_mode_var.get()),
            "remove_link_files_after_extract": self.remove_link_files_after_extract_var.get(),
            "remove_samples_after_extract": self.remove_samples_var.get(),
            "enable_integrity_check": self.enable_integrity_check_var.get(),
            "auto_resume_on_start": self.auto_resume_on_start_var.get(),
            "auto_reconnect": self.auto_reconnect_var.get(),
            "reconnect_wait_seconds": self.reconnect_wait_seconds_var.get(),
            "completed_cleanup_policy": self._normalize_finished_cleanup_policy(self.completed_cleanup_policy_var.get()),
            "max_parallel": self.max_parallel_var.get(),
            "speed_limit_enabled": self.speed_limit_enabled_var.get(),
            "speed_limit_kbps": self.speed_limit_kbps_var.get(),
            "speed_limit_mode": self.speed_limit_mode_var.get(),
            "update_repo": self.update_repo_var.get().strip(),
            "auto_update_check": self.auto_update_check_var.get(),
        }
        CONFIG_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

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
            messagebox.showerror("Fehler", "Bitte einen Zielordner auswählen")
            return
        output_dir = Path(output_dir_raw)

        raw_links = self.links_text.get("1.0", "end")
        package_name_input = self.package_name_var.get().strip()
        packages = self._parse_packages_from_links_text(raw_links, package_name_input)
        if not packages:
            messagebox.showerror("Fehler", "Bitte mindestens einen Link eintragen")
            return

        invalid_links: list[str] = []
        for package in packages:
            for link in package.links:
                if not is_http_link(link):
                    invalid_links.append(link)
        if invalid_links:
            preview = "\n".join(invalid_links[:5])
            more = "" if len(invalid_links) <= 5 else f"\n... +{len(invalid_links) - 5} weitere"
            messagebox.showerror("Fehler", f"Ungültige Links gefunden (nur http/https):\n{preview}{more}")
            return

        if len(packages) == 1 and package_name_input:
            packages[0].name = sanitize_filename(package_name_input)

        total_links = sum(len(package.links) for package in packages)

        try:
            parallel_raw = int(self.max_parallel_var.get())
        except Exception:
            parallel_raw = 4
        max_parallel = min(self._normalize_parallel_value(parallel_raw), total_links)
        self.max_parallel_var.set(max_parallel)
        self._sync_parallel_limit(max_parallel)

        speed_limit = self._normalize_speed_limit_value(self.speed_limit_kbps_var.get())
        speed_mode = self._normalize_speed_mode(self.speed_limit_mode_var.get())
        self.speed_limit_kbps_var.set(speed_limit)
        self.speed_limit_mode_var.set(speed_mode)
        effective_speed_limit = speed_limit if self.speed_limit_enabled_var.get() else 0
        self._sync_speed_limit(effective_speed_limit, speed_mode)

        hybrid_extract = False
        cleanup_mode = "none"
        extract_conflict_mode = "overwrite"
        remove_link_files_after_extract = False
        remove_samples_after_extract = False
        if self.auto_extract_var.get():
            extract_root_raw = self.extract_dir_var.get().strip()
            extract_root = Path(extract_root_raw) if extract_root_raw else (output_dir / "_entpackt")
            hybrid_extract = bool(self.hybrid_extract_var.get())
            cleanup_mode = self._normalize_cleanup_mode(self.cleanup_mode_var.get())
            extract_conflict_mode = self._normalize_extract_conflict_mode(self.extract_conflict_mode_var.get())
            remove_link_files_after_extract = bool(self.remove_link_files_after_extract_var.get())
            remove_samples_after_extract = bool(self.remove_samples_var.get())

        package_jobs: list[dict] = []
        package_dir_names: set[str] = set()
        signature = self._manifest_signature(packages, output_dir)
        resume_manifest = self._load_manifest_file()
        resume_map: dict[str, set[int]] = {}
        if resume_manifest and not bool(resume_manifest.get("finished")) and str(resume_manifest.get("signature")) == signature:
            for package in resume_manifest.get("packages", []):
                if not isinstance(package, dict):
                    continue
                completed = {
                    int(value)
                    for value in package.get("completed", [])
                    if isinstance(value, int) or str(value).isdigit()
                }
                resume_map[str(package.get("name") or "")] = completed

        try:
            output_dir.mkdir(parents=True, exist_ok=True)

            for package in packages:
                base_name = sanitize_filename(package.name) or f"Paket-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
                candidate_name = base_name
                suffix_index = 1
                while candidate_name.lower() in package_dir_names:
                    candidate_name = f"{base_name} ({suffix_index})"
                    suffix_index += 1
                package_dir_names.add(candidate_name.lower())

                package_dir = next_available_path(output_dir / candidate_name)
                package_dir.mkdir(parents=True, exist_ok=True)

                extract_target_dir: Path | None = None
                if self.auto_extract_var.get():
                    extract_root_raw = self.extract_dir_var.get().strip()
                    extract_root = Path(extract_root_raw) if extract_root_raw else (output_dir / "_entpackt")
                    if self.create_extract_subfolder_var.get():
                        extract_target_dir = next_available_path(extract_root / package_dir.name)
                    else:
                        extract_target_dir = extract_root
                    extract_target_dir.mkdir(parents=True, exist_ok=True)

                package_jobs.append(
                    {
                        "name": candidate_name,
                        "links": package.links,
                        "package_dir": package_dir,
                        "extract_target_dir": extract_target_dir,
                        "completed_indices": sorted(resume_map.get(candidate_name, set())),
                    }
                )

            self._save_config()
            self._set_manifest_for_run(package_jobs, output_dir, signature, resume_map=resume_map)
        except Exception as exc:
            messagebox.showerror("Fehler", f"Konnte Zielordner nicht verwenden: {exc}")
            return

        self.table.delete(*self.table.get_children())
        self.row_map.clear()
        self.package_row_id = None
        self.package_contexts = []
        with self.package_cancel_lock:
            self.cancelled_package_rows.clear()
        with self.path_lock:
            self.reserved_target_keys.clear()
        with self.speed_limit_lock:
            self.global_throttle_window_start = monotonic()
            self.global_throttle_bytes = 0
        with self.speed_events_lock:
            self.speed_events.clear()
        self.pause_event.clear()
        self.pause_button.configure(text="Pause", state="normal")
        self.run_started_at = monotonic()
        self.total_downloaded_bytes = 0
        self.speed_var.set("Geschwindigkeit: 0 B/s")

        for package_index, job in enumerate(package_jobs, start=1):
            package_row_id = f"package-{package_index}"
            self.table.insert(
                "",
                "end",
                iid=package_row_id,
                text=str(job["name"]),
                values=("-", "Wartet", f"0/{len(job['links'])}", "0 B/s", "0"),
                open=True,
            )

            row_map: dict[int, str] = {}
            for link_index, link in enumerate(job["links"], start=1):
                row_id = f"{package_row_id}-link-{link_index}"
                row_map[link_index] = row_id
                completed_indices = set(job.get("completed_indices", []))
                status_text = "Bereits fertig (Resume)" if link_index in completed_indices else "Wartet"
                progress_text = "100%" if link_index in completed_indices else "0%"
                self.table.insert(
                    package_row_id,
                    "end",
                    iid=row_id,
                    text=link,
                    values=("-", status_text, progress_text, "0 B/s", "0"),
                )

            self.package_contexts.append(
                {
                    "package_row_id": package_row_id,
                    "row_map": row_map,
                    "job": job,
                }
            )

        resumed_links = sum(len(set(job.get("completed_indices", []))) for job in package_jobs)
        initial_percent = (resumed_links / total_links) * 100 if total_links else 0.0
        self.overall_progress_var.set(initial_percent)
        self.status_var.set(f"Starte {len(package_jobs)} Paket(e) mit {total_links} Link(s), parallel: {max_parallel}")
        LOGGER.info("Download gestartet: %s Paket(e), %s Link(s)", len(package_jobs), total_links)
        self.stop_event.clear()
        self.start_button.configure(state="disabled")
        self.stop_button.configure(state="normal")

        self.worker_thread = threading.Thread(
            target=self._download_queue_worker,
            args=(
                token,
                max_parallel,
                hybrid_extract,
                cleanup_mode,
                extract_conflict_mode,
                total_links,
                remove_link_files_after_extract,
                remove_samples_after_extract,
            ),
            daemon=True,
        )
        self.worker_thread.start()

    def stop_downloads(self) -> None:
        if self.worker_thread and self.worker_thread.is_alive():
            self.pause_event.clear()
            self.stop_event.set()
            self.status_var.set("Stop angefordert...")
            LOGGER.info("Stop wurde angefordert")

    def _download_queue_worker(
        self,
        token: str,
        max_parallel: int,
        hybrid_extract: bool,
        cleanup_mode: str,
        extract_conflict_mode: str,
        overall_total_links: int,
        remove_link_files_after_extract: bool,
        remove_samples_after_extract: bool,
    ) -> None:
        processed_offset = 0
        package_total = len(self.package_contexts)
        total_success = 0
        total_failed = 0
        total_extracted = 0
        total_cancelled = 0

        extract_futures: list = []
        with ThreadPoolExecutor(max_workers=2) as extract_executor:
            for package_index, context in enumerate(self.package_contexts, start=1):
                if self.stop_event.is_set():
                    break

                package_row_id = str(context["package_row_id"])
                row_map = dict(context["row_map"])
                job = dict(context["job"])
                package_name = str(job["name"])
                package_links = list(job["links"])
                package_dir = Path(job["package_dir"])
                extract_target_dir = Path(job["extract_target_dir"]) if job.get("extract_target_dir") else None

                if self._is_package_cancelled(package_row_id):
                    skipped_links = len(package_links)
                    removed_files = self._cleanup_cancelled_package_artifacts(package_dir)
                    processed_offset += skipped_links
                    total_cancelled += skipped_links
                    self._queue_overall(processed_offset, overall_total_links)
                    self._queue_status(
                        f"Paket entfernt: {package_name} ({skipped_links} Link(s), {removed_files} Archivdatei(en) gelöscht)"
                    )
                    continue

                self.package_row_id = package_row_id
                self.row_map = row_map
                completed_for_package = len(
                    set(int(x) for x in job.get("completed_indices", []) if isinstance(x, int) or str(x).isdigit())
                )
                self._queue_package(
                    status=f"Starte ({package_index}/{package_total})",
                    progress=f"{completed_for_package}/{len(package_links)}",
                    retries="0",
                )
                self._queue_status(
                    f"Paket {package_index}/{package_total}: {package_name} ({len(package_links)} Links, parallel {self._active_parallel_limit(len(package_links))})"
                )

                hybrid_extract_for_package = hybrid_extract and package_total <= 1
                if hybrid_extract and package_total > 1 and package_index == 1:
                    self._queue_status("Hinweis: Entpacken läuft paketweise im Hintergrund, während weitere Pakete laden")

                package_result = self._download_worker(
                    token=token,
                    package_name=package_name,
                    package_dir=package_dir,
                    links=package_links,
                    extract_target_dir=extract_target_dir,
                    initial_parallel=max_parallel,
                    hybrid_extract=hybrid_extract_for_package,
                    cleanup_mode=cleanup_mode,
                    extract_conflict_mode=extract_conflict_mode,
                    progress_offset=processed_offset,
                    overall_total_links=overall_total_links,
                    completed_indices=set(
                        int(x) for x in job.get("completed_indices", []) if isinstance(x, int) or str(x).isdigit()
                    ),
                    package_row_id=package_row_id,
                    defer_final_extract=bool(extract_target_dir),
                    remove_link_files_after_extract=remove_link_files_after_extract,
                    remove_samples_after_extract=remove_samples_after_extract,
                )
                processed_offset += package_result.processed
                if package_result.skipped:
                    processed_offset += package_result.skipped
                    total_cancelled += package_result.skipped
                    self._queue_overall(processed_offset, overall_total_links)
                total_success += package_result.success
                total_failed += package_result.failed
                total_extracted += package_result.extracted

                if (
                    not self.stop_event.is_set()
                    and not package_result.cancelled
                    and extract_target_dir
                    and package_result.downloaded_files
                ):
                    self._queue_status(f"Paket {package_name}: Entpacken läuft parallel im Hintergrund")
                    self._queue_package_row(package_row_id, status="Download fertig, Entpacken läuft ...")
                    future = extract_executor.submit(
                        self._finalize_package_extraction,
                        package_name,
                        package_row_id,
                        list(package_result.downloaded_files),
                        extract_target_dir,
                        set(package_result.extracted_job_keys),
                        cleanup_mode,
                        extract_conflict_mode,
                        remove_link_files_after_extract,
                        remove_samples_after_extract,
                    )
                    extract_futures.append(future)

                if self.stop_event.is_set():
                    break

            if extract_futures:
                done, _ = wait(tuple(extract_futures))
                for future in done:
                    try:
                        add_extracted, add_failed = future.result()
                        total_extracted += add_extracted
                        total_failed += add_failed
                    except Exception as exc:
                        total_failed += 1
                        LOGGER.error("Hintergrund-Entpacken fehlgeschlagen: %s", exc)

        duration = max(monotonic() - self.run_started_at, 0.01)
        avg_speed = self.total_downloaded_bytes / duration
        total_processed = total_success + total_failed
        success_rate = (total_success / total_processed * 100.0) if total_processed else 0.0
        summary = (
            f"Summary: Dauer {duration:.1f}s, Ø Speed {human_size(int(avg_speed))}/s, "
            f"Erfolg {success_rate:.1f}% ({total_success}/{total_processed}), Entpackt {total_extracted}, Abgebrochen {total_cancelled}"
        )

        if self.stop_event.is_set():
            self._queue_status(f"Queue gestoppt. {summary}")
        else:
            self._queue_status(f"Alle Pakete abgeschlossen. {summary}")

        self._finish_manifest(summary)

        self.ui_queue.put(("controls", False))

    def _download_worker(
        self,
        token: str,
        package_name: str,
        package_dir: Path,
        links: list[str],
        extract_target_dir: Path | None,
        initial_parallel: int,
        hybrid_extract: bool,
        cleanup_mode: str,
        extract_conflict_mode: str,
        progress_offset: int = 0,
        overall_total_links: int | None = None,
        completed_indices: set[int] | None = None,
        package_row_id: str | None = None,
        defer_final_extract: bool = False,
        remove_link_files_after_extract: bool = False,
        remove_samples_after_extract: bool = False,
    ) -> PackageRunResult:
        self._sync_parallel_limit(initial_parallel)
        total = len(links)
        cleanup_policy = self._normalize_finished_cleanup_policy(self.completed_cleanup_policy_var.get())
        overall_total = overall_total_links if overall_total_links is not None else total
        resume_done = set(completed_indices or set())
        processed = len(resume_done)
        success = len(resume_done)
        failed = 0
        extracted = 0
        downloaded_files: list[Path] = []
        extracted_job_keys: set[str] = set()
        package_cancelled = self._is_package_cancelled(package_row_id)

        if extract_target_dir and package_dir.exists():
            for candidate in package_dir.iterdir():
                if not candidate.is_file():
                    continue
                if candidate.suffix.lower() in {".zip", ".rar", ".7z"}:
                    downloaded_files.append(candidate)

        pending_links: deque[tuple[int, str]] = deque(
            (index, link) for index, link in enumerate(links, start=1) if index not in resume_done
        )
        running_futures: dict = {}
        with ThreadPoolExecutor(max_workers=max(1, min(50, total))) as executor:
            while (pending_links or running_futures) and not self.stop_event.is_set() and not package_cancelled:
                if self._is_package_cancelled(package_row_id):
                    package_cancelled = True
                    break

                self._wait_if_paused(package_row_id)
                if self._is_reconnect_active():
                    if package_row_id:
                        self._queue_package_row(package_row_id, status="Reconnect-Wartefenster aktiv", speed="0 B/s")
                    sleep(0.35)
                    continue
                desired_parallel = self._active_parallel_limit(total)

                while pending_links and len(running_futures) < desired_parallel and not self.stop_event.is_set() and not package_cancelled:
                    index, link = pending_links.popleft()
                    future = executor.submit(self._download_single_link, token, package_dir, index, link, package_row_id)
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
                        result = future.result()
                        if result is not None:
                            if result.path not in downloaded_files:
                                downloaded_files.append(result.path)
                            self.total_downloaded_bytes += int(result.bytes_written)
                            success += 1
                            self._mark_manifest_link(package_name, index, success=True)
                            if cleanup_policy == "immediate":
                                link_text = links[index - 1] if 1 <= index <= len(links) else ""
                                self._queue_cleanup_row(package_row_id, index, link_text)
                            if extract_target_dir and hybrid_extract:
                                add_extracted, add_failed = self._extract_ready_archives(
                                    downloaded_files,
                                    extract_target_dir,
                                    extracted_job_keys,
                                    strict_complete=False,
                                    cleanup_mode=cleanup_mode,
                                    conflict_mode=extract_conflict_mode,
                                    package_name=package_name,
                                    package_row_id=package_row_id,
                                    remove_link_files_after_extract=remove_link_files_after_extract,
                                    remove_samples_after_extract=remove_samples_after_extract,
                                )
                                extracted += add_extracted
                                failed += add_failed
                        else:
                            failed += 1
                            self._mark_manifest_link(package_name, index, success=False)
                    except InterruptedError:
                        self._queue_row(index, package_row_id=package_row_id, status="Gestoppt", progress="-", speed="0 B/s", retries="-")
                        self.stop_event.set()
                        break
                    except PackageCancelledError:
                        self._queue_row(index, package_row_id=package_row_id, status="Entfernt", progress="-", speed="0 B/s", retries="-")
                        package_cancelled = True
                        break
                    except Exception as exc:
                        error_text = compact_error_text(str(exc))
                        self._queue_row(
                            index,
                            package_row_id=package_row_id,
                            status=f"Fehler: {error_text}",
                            progress="-",
                            speed="0 B/s",
                            retries="-",
                        )
                        LOGGER.error("Downloadfehler [%s #%s]: %s", package_name, index, exc)
                        failed += 1
                        self._mark_manifest_link(package_name, index, success=False)
                    finally:
                        processed += 1
                        self._queue_overall(progress_offset + processed, overall_total)
                        self._queue_package(
                            status=f"Laufend: {success} ok, {failed} fehler",
                            progress=f"{processed}/{total}",
                        )

                    if package_cancelled:
                        break

            if self.stop_event.is_set() or package_cancelled:
                for pending_future in running_futures:
                    pending_future.cancel()

        if package_cancelled:
            skipped_links = max(total - processed, 0)
            removed_files = self._cleanup_cancelled_package_artifacts(package_dir)
            self._queue_status(
                f"Paket entfernt: {package_name}. Gelöschte Archivdateien: {removed_files}, übersprungene Links: {skipped_links}"
            )
            if package_row_id:
                self._queue_package_row(package_row_id, status="Entfernt", progress=f"{processed}/{total}", speed="0 B/s")
            return PackageRunResult(
                processed=processed,
                success=success,
                failed=failed,
                extracted=extracted,
                downloaded_files=list(downloaded_files),
                extracted_job_keys=set(extracted_job_keys),
                cancelled=True,
                skipped=skipped_links,
            )

        extract_failed = 0
        if not self.stop_event.is_set() and extract_target_dir and downloaded_files and not defer_final_extract:
            self._queue_status("Downloads fertig, starte Entpacken...")
            try:
                add_extracted, extract_failed = self._extract_ready_archives(
                    downloaded_files,
                    extract_target_dir,
                    extracted_job_keys,
                    strict_complete=True,
                    cleanup_mode=cleanup_mode,
                    conflict_mode=extract_conflict_mode,
                    package_name=package_name,
                    package_row_id=package_row_id,
                    remove_link_files_after_extract=remove_link_files_after_extract,
                    remove_samples_after_extract=remove_samples_after_extract,
                )
                extracted += add_extracted
                failed += extract_failed
            except InterruptedError:
                self.stop_event.set()

        if self.stop_event.is_set():
            self._queue_status(f"Gestoppt. Fertig: {success}, Fehler: {failed}")
            self._queue_package(status="Gestoppt", progress=f"{processed}/{total}")
        else:
            if cleanup_policy == "package_done" and failed == 0 and processed >= total:
                self._queue_cleanup_package(package_row_id, list(links))
            self._queue_overall(progress_offset + processed, overall_total)
            if extract_target_dir and not defer_final_extract:
                self._queue_status(
                    f"Abgeschlossen. Fertig: {success}, Fehler: {failed}, Entpackt: {extracted}. Ziel: {extract_target_dir}"
                )
                self._queue_package(status=f"Fertig: {success} ok, {failed} fehler, {extracted} entpackt", progress=f"{processed}/{total}")
            elif extract_target_dir and defer_final_extract and downloaded_files:
                self._queue_status(f"Download abgeschlossen: {success} fertig, {failed} Fehler. Entpacken läuft im Hintergrund...")
                self._queue_package(status=f"Download fertig: {success} ok, {failed} fehler", progress=f"{processed}/{total}")
            else:
                self._queue_status(f"Abgeschlossen. Fertig: {success}, Fehler: {failed}")
                self._queue_package(status=f"Fertig: {success} ok, {failed} fehler", progress=f"{processed}/{total}")

        return PackageRunResult(
            processed=processed,
            success=success,
            failed=failed,
            extracted=extracted,
            downloaded_files=list(downloaded_files),
            extracted_job_keys=set(extracted_job_keys),
        )

    def _download_single_link(
        self,
        token: str,
        package_dir: Path,
        index: int,
        link: str,
        package_row_id: str | None = None,
    ) -> DownloadResult | None:
        if self.stop_event.is_set():
            raise InterruptedError("Download wurde gestoppt")
        if self._is_package_cancelled(package_row_id):
            raise PackageCancelledError("Paket wurde entfernt")

        client = RealDebridClient(token)
        target_path: Path | None = None
        try:
            self._wait_if_paused(package_row_id)
            self._queue_row(
                index,
                package_row_id=package_row_id,
                status="Link wird via Real-Debrid umgewandelt",
                progress="0%",
                speed="0 B/s",
                retries="0",
            )
            filename, direct_url, unrestrict_retries, file_size = client.unrestrict_link(link)
            target_path = self._reserve_download_target(package_dir, filename)
            if file_size and not self._has_enough_disk_space(package_dir, file_size):
                raise RuntimeError(f"Zu wenig Speicherplatz für {target_path.name} ({human_size(file_size)})")
            if self._is_package_cancelled(package_row_id):
                raise PackageCancelledError("Paket wurde entfernt")

            self._queue_row(
                index,
                package_row_id=package_row_id,
                file=target_path.name,
                status="Download läuft",
                progress="0%",
                speed="0 B/s",
                retries=str(unrestrict_retries),
            )
            integrity_retries = 0
            while True:
                download_retries, written_bytes = self._stream_download(
                    client.session,
                    direct_url,
                    target_path,
                    index,
                    package_row_id=package_row_id,
                )

                if not self.enable_integrity_check_var.get():
                    break

                self._queue_row(index, package_row_id=package_row_id, status="CRC-Check läuft", speed="0 B/s")
                ok, integrity_text = self._validate_file_integrity(target_path, package_dir)
                if ok:
                    self._queue_row(index, package_row_id=package_row_id, status=f"Download läuft ({integrity_text})")
                    break

                target_path.unlink(missing_ok=True)
                integrity_retries += 1
                if integrity_retries <= 1:
                    self._queue_row(
                        index,
                        package_row_id=package_row_id,
                        status=f"{integrity_text}, Neuversuch {integrity_retries}/1",
                        progress="0%",
                        speed="0 B/s",
                    )
                    continue
                raise RuntimeError(f"Integritätsprüfung fehlgeschlagen ({integrity_text})")

            total_retries = unrestrict_retries + download_retries
            self._queue_row(
                index,
                package_row_id=package_row_id,
                status=f"Fertig ({human_size(target_path.stat().st_size)})",
                progress="100%",
                speed="0 B/s",
                retries=str(total_retries),
            )
            return DownloadResult(path=target_path, bytes_written=written_bytes)
        finally:
            client.session.close()
            if target_path is not None:
                self._release_reserved_target(target_path)

    def _finalize_package_extraction(
        self,
        package_name: str,
        package_row_id: str,
        downloaded_files: list[Path],
        extract_target_dir: Path,
        extracted_job_keys: set[str],
        cleanup_mode: str,
        conflict_mode: str,
        remove_link_files_after_extract: bool,
        remove_samples_after_extract: bool,
    ) -> tuple[int, int]:
        if self.stop_event.is_set():
            self._queue_package_row(package_row_id, status="Entpacken gestoppt")
            return 0, 0
        if self._is_package_cancelled(package_row_id):
            self._queue_package_row(package_row_id, status="Entfernt")
            return 0, 0

        self._queue_package_row(package_row_id, status="Entpacken gestartet")
        try:
            extracted, failed = self._extract_ready_archives(
                downloaded_files,
                extract_target_dir,
                extracted_job_keys,
                strict_complete=True,
                cleanup_mode=cleanup_mode,
                conflict_mode=conflict_mode,
                package_name=package_name,
                package_row_id=package_row_id,
                remove_link_files_after_extract=remove_link_files_after_extract,
                remove_samples_after_extract=remove_samples_after_extract,
            )
            if self.stop_event.is_set():
                self._queue_package_row(package_row_id, status="Entpacken gestoppt")
            else:
                self._queue_package_row(package_row_id, status=f"Entpacken fertig: {extracted} ok, {failed} fehler")
            return extracted, failed
        except InterruptedError:
            self._queue_package_row(package_row_id, status="Entpacken gestoppt")
            return 0, 0
        except PackageCancelledError:
            removed_files = 0
            if downloaded_files:
                removed_files = self._cleanup_cancelled_package_artifacts(downloaded_files[0].parent)
            self._queue_status(f"Paket entfernt: {package_name}. Gelöschte Archivdateien: {removed_files}")
            self._queue_package_row(package_row_id, status="Entfernt")
            return 0, 0
        except Exception as exc:
            LOGGER.error("Entpack-Fehler [%s]: %s", package_name, exc)
            self._queue_package_row(package_row_id, status=f"Entpack-Fehler: {compact_error_text(str(exc))}")
            return 0, 1

    def _extract_ready_archives(
        self,
        downloaded_files: list[Path],
        extract_target_dir: Path,
        extracted_job_keys: set[str],
        strict_complete: bool,
        cleanup_mode: str,
        conflict_mode: str,
        package_name: str = "",
        package_row_id: str | None = None,
        remove_link_files_after_extract: bool = False,
        remove_samples_after_extract: bool = False,
    ) -> tuple[int, int]:
        jobs, skipped_reason_count = self._collect_extract_jobs(downloaded_files, strict_complete)
        pending_jobs = [job for job in jobs if job.key not in extracted_job_keys]
        if not pending_jobs:
            return 0, skipped_reason_count

        prefix = f"[{package_name}] " if package_name else ""

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
        total_jobs = len(pending_jobs)
        for position, job in enumerate(pending_jobs, start=1):
            if self.stop_event.is_set():
                raise InterruptedError("Entpacken wurde gestoppt")
            if self._is_package_cancelled(package_row_id):
                raise PackageCancelledError("Paket wurde entfernt")

            if package_row_id:
                self._queue_package_row(package_row_id, status=f"Entpacken {position}/{total_jobs}: {job.archive_path.name}")

            self._queue_status(f"{prefix}Entpacke {job.archive_path.name} ...")
            try:
                used_password = self._extract_archive(job.archive_path, extract_target_dir, conflict_mode)
                extracted_job_keys.add(job.key)
                self._cleanup_archive_sources(job.source_files, cleanup_mode)
                if remove_link_files_after_extract:
                    removed_links = self._remove_download_link_artifacts(extract_target_dir)
                    if removed_links:
                        self._queue_status(f"{prefix}Downloadlink-Dateien entfernt: {removed_links}")
                if remove_samples_after_extract:
                    removed_sample_files, removed_sample_dirs = self._remove_sample_artifacts(extract_target_dir)
                    if removed_sample_files or removed_sample_dirs:
                        self._queue_status(
                            f"{prefix}Samples entfernt: {removed_sample_files} Datei(en), {removed_sample_dirs} Ordner"
                        )
                if used_password:
                    self._queue_status(f"{prefix}Entpackt: {job.archive_path.name} (Passwort: {used_password})")
                else:
                    self._queue_status(f"{prefix}Entpackt: {job.archive_path.name}")
                extracted += 1
            except Exception as exc:
                failed += 1
                self._queue_status(f"{prefix}Entpack-Fehler bei {job.archive_path.name}: {compact_error_text(str(exc))}")

        return extracted, failed

    def _cleanup_archive_sources(self, source_files: list[Path], cleanup_mode: str) -> None:
        mode = self._normalize_cleanup_mode(cleanup_mode)
        if mode == "none":
            return

        deleted = 0
        for file_path in source_files:
            try:
                if file_path.exists():
                    if mode == "trash" and send2trash is not None:
                        send2trash(str(file_path))
                        deleted += 1
                    elif mode == "trash":
                        file_path.unlink(missing_ok=True)
                        deleted += 1
                    elif mode == "delete":
                        file_path.unlink(missing_ok=True)
                        deleted += 1
            except Exception:
                continue
        if deleted:
            if mode == "trash" and send2trash is not None:
                self._queue_status(f"Cleanup: {deleted} Archivdatei(en) in Papierkorb verschoben")
            else:
                self._queue_status(f"Cleanup: {deleted} Archivdatei(en) gelöscht")

    def _remove_download_link_artifacts(self, extract_target_dir: Path) -> int:
        removed = 0
        for file_path in extract_target_dir.rglob("*"):
            if not file_path.is_file():
                continue

            suffix = file_path.suffix.lower()
            name_lower = file_path.name.lower()
            should_remove = False

            if suffix in LINK_ARTIFACT_EXTENSIONS:
                should_remove = True
            elif suffix in {".txt", ".html", ".htm", ".nfo"}:
                if not any(token in name_lower for token in ("link", "links", "download", "downloads", "url", "urls", "dlc")):
                    continue
                try:
                    if file_path.stat().st_size > 512 * 1024:
                        continue
                    text = file_path.read_text(encoding="utf-8", errors="ignore")
                except Exception:
                    continue
                should_remove = bool(re.search(r"https?://", text, flags=re.IGNORECASE))

            if not should_remove:
                continue

            try:
                file_path.unlink(missing_ok=True)
                removed += 1
            except Exception:
                continue

        return removed

    def _remove_sample_artifacts(self, extract_target_dir: Path) -> tuple[int, int]:
        removed_files = 0
        removed_dirs = 0
        paths = sorted(extract_target_dir.rglob("*"), key=lambda path: len(path.parts), reverse=True)

        for path in paths:
            if not path.is_file():
                continue

            parent_lower = path.parent.name.lower()
            stem_lower = path.stem.lower()
            suffix = path.suffix.lower()
            in_sample_dir = parent_lower in SAMPLE_DIR_NAMES
            is_sample_video = suffix in SAMPLE_VIDEO_EXTENSIONS and bool(SAMPLE_TOKEN_RE.search(stem_lower))
            if not (in_sample_dir or is_sample_video):
                continue

            try:
                path.unlink(missing_ok=True)
                removed_files += 1
            except Exception:
                continue

        for path in paths:
            if not path.is_dir():
                continue
            if path.name.lower() not in SAMPLE_DIR_NAMES:
                continue
            try:
                shutil.rmtree(path, ignore_errors=True)
                removed_dirs += 1
            except Exception:
                continue

        return removed_files, removed_dirs

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
                    self._queue_status(f"Übersprungen (kein Part1): {base_name}")
                continue

            max_part = max(parts)
            missing_parts = [part for part in range(1, max_part + 1) if part not in parts]
            if missing_parts:
                if strict_complete:
                    skipped += 1
                    missing_text = ", ".join(str(part) for part in missing_parts[:8])
                    self._queue_status(f"Übersprungen (fehlende Parts {missing_text}): {parts[1].name}")
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

    def _extract_archive(self, archive_path: Path, extract_target_dir: Path, conflict_mode: str) -> str | None:
        suffix = archive_path.suffix.lower()

        if suffix == ".zip":
            return self._extract_zip_archive(archive_path, extract_target_dir, conflict_mode)

        if suffix == ".rar":
            if self.seven_zip_path:
                return self._extract_with_7zip(archive_path, extract_target_dir, conflict_mode)
            return self._extract_with_unrar(archive_path, extract_target_dir, conflict_mode)

        if suffix == ".7z":
            return self._extract_with_7zip(archive_path, extract_target_dir, conflict_mode)

        raise RuntimeError("Archivformat wird nicht unterstuetzt")

    def _extract_zip_archive(self, archive_path: Path, extract_target_dir: Path, conflict_mode: str) -> str | None:
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

                    merge_directory(temp_path, extract_target_dir, conflict_mode)
                    return password

            except zipfile.BadZipFile as exc:
                raise RuntimeError("ZIP-Datei ist defekt oder ungültig") from exc
            except NotImplementedError as exc:
                if self.seven_zip_path:
                    return self._extract_with_7zip(archive_path, extract_target_dir, conflict_mode)
                last_error = exc
                continue
            except Exception as exc:
                last_error = exc
                if self._looks_like_password_error(str(exc)):
                    continue

        raise RuntimeError("Kein passendes ZIP-Passwort gefunden") from last_error

    def _extract_with_7zip(self, archive_path: Path, extract_target_dir: Path, conflict_mode: str) -> str | None:
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
                    merge_directory(Path(temp_dir), extract_target_dir, conflict_mode)
                    return password

                output = f"{result.stdout}\n{result.stderr}".strip()
                last_output = output
                if self._looks_like_7zip_password_error(output):
                    continue

        raise RuntimeError(last_output or "Kein passendes Archiv-Passwort gefunden")

    def _extract_with_unrar(self, archive_path: Path, extract_target_dir: Path, conflict_mode: str) -> str | None:
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
                    merge_directory(Path(temp_dir), extract_target_dir, conflict_mode)
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
        package_row_id: str | None = None,
    ) -> tuple[int, int]:
        last_error: Exception | None = None
        for attempt in range(1, REQUEST_RETRIES + 1):
            response: requests.Response | None = None
            try:
                if self._is_reconnect_active():
                    self._wait_for_reconnect_window(row_index, package_row_id)
                response = session.get(url, stream=True, timeout=(25, 300))
            except requests.RequestException as exc:
                last_error = exc
                if attempt < REQUEST_RETRIES:
                    self._queue_row(
                        row_index,
                        package_row_id=package_row_id,
                        status=f"Verbindungsfehler, retry {attempt + 1}/{REQUEST_RETRIES}",
                        speed="0 B/s",
                        retries=str(attempt),
                    )
                    retry_sleep(attempt)
                    continue
                raise RuntimeError(f"Download-Start fehlgeschlagen: {exc}") from exc

            if not response.ok:
                error_text = parse_error_message(response)
                if self.auto_reconnect_var.get() and response.status_code in {429, 503}:
                    self._request_reconnect(f"HTTP {response.status_code}")
                    self._wait_for_reconnect_window(row_index, package_row_id)
                if should_retry_status(response.status_code) and attempt < REQUEST_RETRIES:
                    self._queue_row(
                        row_index,
                        package_row_id=package_row_id,
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
                        if self._is_package_cancelled(package_row_id):
                            raise PackageCancelledError("Paket wurde entfernt")
                        self._wait_if_paused(package_row_id)

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
                                self._queue_row(row_index, package_row_id=package_row_id, progress=f"{percent}%")
                        else:
                            bucket = written // (10 * 1024 * 1024)
                            if bucket != last_reported_bucket:
                                last_reported_bucket = bucket
                                self._queue_row(row_index, package_row_id=package_row_id, progress=human_size(written))

                        now = monotonic()
                        elapsed = now - speed_window_start
                        if elapsed >= 0.8:
                            speed_value = speed_window_bytes / elapsed if elapsed > 0 else 0.0
                            self._queue_row(row_index, package_row_id=package_row_id, speed=f"{human_size(int(speed_value))}/s")
                            speed_window_start = now
                            speed_window_bytes = 0

                self._queue_row(row_index, package_row_id=package_row_id, speed="0 B/s", retries=str(attempt - 1))
                return attempt - 1, written
            except InterruptedError:
                if target_path.exists():
                    target_path.unlink(missing_ok=True)
                raise
            except PackageCancelledError:
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
                        package_row_id=package_row_id,
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

    def _queue_row(self, row_index: int, package_row_id: str | None = None, **updates: str) -> None:
        if package_row_id:
            row_id = f"{package_row_id}-link-{row_index}"
        else:
            row_id = self.row_map.get(row_index)
        if not row_id:
            return
        self.ui_queue.put(("row", row_id, updates))

    def _queue_package(self, package_row_id: str | None = None, **updates: str) -> None:
        row_id = package_row_id or self.package_row_id
        self.ui_queue.put(("package", row_id, updates))

    def _queue_package_row(self, package_row_id: str, **updates: str) -> None:
        self.ui_queue.put(("package_row", package_row_id, updates))

    def _queue_cleanup_row(self, package_row_id: str | None, row_index: int, link_text: str) -> None:
        if not package_row_id:
            return
        row_id = f"{package_row_id}-link-{row_index}"
        self.ui_queue.put(("cleanup_row", row_id, link_text))

    def _queue_cleanup_package(self, package_row_id: str | None, links: list[str]) -> None:
        if not package_row_id:
            return
        self.ui_queue.put(("cleanup_package", package_row_id, list(links)))

    def _queue_status(self, message: str) -> None:
        LOGGER.info("%s", message)
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
                row_id = str(event[1])
                updates = event[2]
                if row_id and self.table.exists(row_id):
                    values = list(self.table.item(row_id, "values"))
                    columns = {"file": 0, "status": 1, "progress": 2, "speed": 3, "retries": 4}
                    for key, value in updates.items():
                        column_index = columns.get(key)
                        if column_index is not None:
                            values[column_index] = value
                    self.table.item(row_id, values=values)

            elif kind == "package":
                package_row_id = str(event[1]) if event[1] else ""
                updates = event[2]
                if package_row_id and self.table.exists(package_row_id):
                    values = list(self.table.item(package_row_id, "values"))
                    columns = {"file": 0, "status": 1, "progress": 2, "speed": 3, "retries": 4}
                    for key, value in updates.items():
                        column_index = columns.get(key)
                        if column_index is not None:
                            values[column_index] = value
                    self.table.item(package_row_id, values=values)

            elif kind == "package_row":
                package_row_id = str(event[1])
                updates = event[2]
                if package_row_id and self.table.exists(package_row_id):
                    values = list(self.table.item(package_row_id, "values"))
                    columns = {"file": 0, "status": 1, "progress": 2, "speed": 3, "retries": 4}
                    for key, value in updates.items():
                        column_index = columns.get(key)
                        if column_index is not None:
                            values[column_index] = value
                    self.table.item(package_row_id, values=values)

            elif kind == "status":
                self.status_var.set(event[1])

            elif kind == "overall":
                processed, total = event[1], event[2]
                percent = (processed / total) * 100 if total else 0
                self.overall_progress_var.set(percent)
                if processed > 0 and total > 0 and self.run_started_at > 0:
                    elapsed = max(monotonic() - self.run_started_at, 0.1)
                    rate = processed / elapsed
                    remaining = max(total - processed, 0)
                    eta_seconds = int(remaining / rate) if rate > 0 else -1
                    if eta_seconds >= 0:
                        minutes, seconds = divmod(eta_seconds, 60)
                        hours, minutes = divmod(minutes, 60)
                        if hours > 0:
                            self.eta_var.set(f"ETA: {hours:02d}:{minutes:02d}:{seconds:02d}")
                        else:
                            self.eta_var.set(f"ETA: {minutes:02d}:{seconds:02d}")

            elif kind == "cleanup_row":
                row_id = str(event[1])
                link_text = str(event[2]).strip()
                if row_id and self.table.exists(row_id):
                    parent_id = self.table.parent(row_id)
                    self.table.delete(row_id)
                    if parent_id and self.table.exists(parent_id) and not self.table.get_children(parent_id):
                        self.table.delete(parent_id)
                if link_text:
                    self._remove_links_from_text([link_text])

            elif kind == "cleanup_package":
                package_row_id = str(event[1])
                links = [str(link).strip() for link in event[2] if str(link).strip()]
                if package_row_id and self.table.exists(package_row_id):
                    self.table.delete(package_row_id)
                self._remove_links_from_text(links)

            elif kind == "speed_bytes":
                byte_count = int(event[1])
                now = monotonic()
                with self.speed_events_lock:
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
                messagebox.showinfo("Update", f"Kein Update verfügbar. Aktuell: v{APP_VERSION}, Latest: v{latest}")

            elif kind == "update_error":
                LOGGER.error("Updatefehler: %s", event[1])
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
                self.pause_button.configure(state="normal" if running else "disabled")
                if not running:
                    with self.speed_events_lock:
                        self.speed_events.clear()
                    self.pause_event.clear()
                    self.pause_button.configure(text="Pause")
                    with self.package_cancel_lock:
                        self.cancelled_package_rows.clear()
                    with self.path_lock:
                        self.reserved_target_keys.clear()
                    self.speed_var.set("Geschwindigkeit: 0 B/s")
                    self.eta_var.set("ETA: --")
                    if self.package_row_id and self.table.exists(self.package_row_id):
                        values = list(self.table.item(self.package_row_id, "values"))
                        if len(values) >= 4:
                            values[3] = "0 B/s"
                            self.table.item(self.package_row_id, values=values)

        self.after(100, self._process_ui_queue)

    def _handle_update_available(self, release: ReleaseInfo, manual: bool) -> None:
        if getattr(sys, "frozen", False):
            should_update = messagebox.askyesno(
                "Update verfügbar",
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
        if messagebox.askyesno("Update verfügbar", message) and release.html_url:
            webbrowser.open(release.html_url)


def main() -> None:
    app = DownloaderApp()
    app.mainloop()


if __name__ == "__main__":
    main()
