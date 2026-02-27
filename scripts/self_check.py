from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path
from tkinter import messagebox

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import real_debrid_downloader_gui as appmod


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def run() -> None:
    temp_root = Path(tempfile.mkdtemp(prefix="rd_self_check_"))

    original_config = appmod.CONFIG_FILE
    original_manifest = appmod.MANIFEST_FILE
    appmod.CONFIG_FILE = temp_root / "rd_downloader_config.json"
    appmod.MANIFEST_FILE = temp_root / "rd_download_manifest.json"

    message_calls: list[tuple[str, str, str]] = []
    original_showerror = messagebox.showerror
    original_showwarning = messagebox.showwarning
    original_showinfo = messagebox.showinfo

    def fake_message(kind: str):
        def _inner(title: str, text: str):
            message_calls.append((kind, str(title), str(text)))
            return None

        return _inner

    messagebox.showerror = fake_message("error")
    messagebox.showwarning = fake_message("warning")
    messagebox.showinfo = fake_message("info")

    app = appmod.DownloaderApp()
    app.withdraw()

    try:
        app.token_var.set("demo-token")
        app.output_dir_var.set(str(temp_root / "downloads"))
        app.links_text.delete("1.0", "end")
        app.links_text.insert("1.0", "not_a_link")
        app.start_downloads()
        assert_true(
            any("Ungültige Links" in text for kind, _, text in message_calls if kind == "error"),
            "Link-Validierung hat ungültige Eingabe nicht blockiert",
        )

        app.cleanup_mode_var.set("delete")
        app.extract_conflict_mode_var.set("rename")
        app.remove_link_files_after_extract_var.set(True)
        app.remove_samples_var.set(True)
        app.remember_token_var.set(True)
        app.token_var.set("token-123")

        original_can_secure = app._can_store_token_securely
        original_store_keyring = app._store_token_in_keyring
        app._can_store_token_securely = lambda: True
        app._store_token_in_keyring = lambda token: False
        app._save_config()

        config_data = json.loads(appmod.CONFIG_FILE.read_text(encoding="utf-8"))
        assert_true(config_data.get("token") == "token-123", "Token-Fallback in Config bei Keyring-Fehler fehlt")

        app.cleanup_mode_var.set("none")
        app.extract_conflict_mode_var.set("overwrite")
        app.remove_link_files_after_extract_var.set(False)
        app.remove_samples_var.set(False)
        app.token_var.set("")
        app._load_config()
        assert_true(app.cleanup_mode_var.get() == "delete", "cleanup_mode wurde nicht aus Config geladen")
        assert_true(app.extract_conflict_mode_var.get() == "rename", "extract_conflict_mode wurde nicht geladen")
        assert_true(app.remove_link_files_after_extract_var.get() is True, "remove_link_files_after_extract fehlt")
        assert_true(app.remove_samples_var.get() is True, "remove_samples_after_extract fehlt")

        app._can_store_token_securely = original_can_secure
        app._store_token_in_keyring = original_store_keyring

        class DummyWorker:
            @staticmethod
            def is_alive() -> bool:
                return True

        app.worker_thread = DummyWorker()
        app.pause_event.clear()
        app.toggle_pause_downloads()
        assert_true(app.pause_event.is_set(), "Pause wurde nicht aktiviert")
        app.toggle_pause_downloads()
        assert_true(not app.pause_event.is_set(), "Resume wurde nicht aktiviert")

        app.pause_event.set()
        started = time.monotonic()

        def _unpause() -> None:
            time.sleep(0.25)
            app.pause_event.clear()

        threading.Thread(target=_unpause, daemon=True).start()
        app._wait_if_paused()
        waited = time.monotonic() - started
        assert_true(waited >= 0.2, "Pause-Wait hat nicht geblockt")

        status_events: list[tuple[float, str]] = []
        extract_times: dict[str, float] = {}
        download_starts: dict[str, float] = {}

        original_queue_status = app._queue_status
        original_download_single = app._download_single_link
        original_extract_archive = app._extract_archive

        def fake_queue_status(message: str) -> None:
            status_events.append((time.monotonic(), message))
            original_queue_status(message)

        def fake_download_single(token: str, package_dir: Path, index: int, link: str) -> appmod.DownloadResult:
            package_name = package_dir.name
            download_starts.setdefault(package_name, time.monotonic())
            archive_path = package_dir / f"{package_name}_{index}.zip"
            archive_path.parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("movie.mkv", b"movie-data")
                archive.writestr(f"Samples/{package_name}-sample.mkv", b"sample-data")
                archive.writestr("download_links.txt", "https://example.com/file")
            time.sleep(0.18)
            return appmod.DownloadResult(path=archive_path, bytes_written=archive_path.stat().st_size)

        def fake_extract_archive(archive_path: Path, extract_target_dir: Path, conflict_mode: str):
            package_name = archive_path.parent.name
            if package_name == "pkg1":
                extract_times["pkg1_start"] = time.monotonic()
                time.sleep(0.8)
            else:
                time.sleep(0.25)
            with zipfile.ZipFile(archive_path) as archive:
                archive.extractall(extract_target_dir)
            if package_name == "pkg1":
                extract_times["pkg1_end"] = time.monotonic()
            return None

        app._queue_status = fake_queue_status
        app._download_single_link = fake_download_single
        app._extract_archive = fake_extract_archive

        app.table.delete(*app.table.get_children())
        app.package_contexts = []

        package_specs: list[tuple[str, Path, Path]] = []
        for idx in (1, 2):
            package_name = f"pkg{idx}"
            package_dir = temp_root / package_name
            extract_dir = temp_root / f"extract_{package_name}"
            package_dir.mkdir(parents=True, exist_ok=True)
            extract_dir.mkdir(parents=True, exist_ok=True)

            package_row_id = f"package-{idx}"
            app.table.insert("", "end", iid=package_row_id, text=package_name, values=("-", "Wartet", "0/1", "0 B/s", "0"), open=True)
            row_id = f"{package_row_id}-link-1"
            app.table.insert(package_row_id, "end", iid=row_id, text="https://example.com/file", values=("-", "Wartet", "0%", "0 B/s", "0"))

            app.package_contexts.append(
                {
                    "package_row_id": package_row_id,
                    "row_map": {1: row_id},
                    "job": {
                        "name": package_name,
                        "links": ["https://example.com/file"],
                        "package_dir": package_dir,
                        "extract_target_dir": extract_dir,
                        "completed_indices": [],
                    },
                }
            )
            package_specs.append((package_name, package_dir, extract_dir))

        app.run_started_at = time.monotonic()
        app.total_downloaded_bytes = 0
        app.stop_event.clear()
        app.pause_event.clear()
        app._set_manifest_for_run(
            [
                {"name": name, "links": ["https://example.com/file"]}
                for name, _package_dir, _extract_dir in package_specs
            ],
            temp_root / "downloads",
            "self-check-signature",
            resume_map={},
        )

        app._download_queue_worker(
            token="demo-token",
            max_parallel=1,
            hybrid_extract=True,
            cleanup_mode="none",
            extract_conflict_mode="overwrite",
            overall_total_links=2,
            remove_link_files_after_extract=True,
            remove_samples_after_extract=True,
        )
        app._process_ui_queue()

        pkg1_extract_dir = temp_root / "extract_pkg1"
        pkg2_extract_dir = temp_root / "extract_pkg2"
        assert_true((pkg1_extract_dir / "movie.mkv").exists(), "Entpacken pkg1 fehlgeschlagen")
        assert_true((pkg2_extract_dir / "movie.mkv").exists(), "Entpacken pkg2 fehlgeschlagen")
        assert_true(not (pkg1_extract_dir / "download_links.txt").exists(), "Link-Artefakte wurden nicht entfernt")
        assert_true(not (pkg2_extract_dir / "download_links.txt").exists(), "Link-Artefakte pkg2 wurden nicht entfernt")
        assert_true(not (pkg1_extract_dir / "Samples").exists(), "Sample-Ordner pkg1 wurde nicht entfernt")
        assert_true(not (pkg2_extract_dir / "Samples").exists(), "Sample-Ordner pkg2 wurde nicht entfernt")

        assert_true("pkg1_start" in extract_times and "pkg1_end" in extract_times, "Entpack-Zeiten für pkg1 fehlen")
        assert_true("pkg2" in download_starts, "Downloadstart für pkg2 fehlt")
        assert_true(
            download_starts["pkg2"] < extract_times["pkg1_end"],
            "Paket 2 startete nicht parallel zum Entpacken von Paket 1",
        )

        manifest_data = json.loads(appmod.MANIFEST_FILE.read_text(encoding="utf-8"))
        assert_true(bool(manifest_data.get("finished")), "Manifest wurde nach Lauf nicht abgeschlossen")

        with app.path_lock:
            app.reserved_target_keys.add("dummy-key")
        app.ui_queue.put(("controls", False))
        app._process_ui_queue()
        with app.path_lock:
            assert_true(len(app.reserved_target_keys) == 0, "reserved_target_keys wurden nicht bereinigt")

        app._queue_status = original_queue_status
        app._download_single_link = original_download_single
        app._extract_archive = original_extract_archive

        assert_true(any("Entpacken läuft parallel" in text for _, text in status_events), "Kein Parallel-Entpacken-Status geloggt")
        print("Self-check erfolgreich")
    finally:
        try:
            app.destroy()
        except Exception:
            pass
        messagebox.showerror = original_showerror
        messagebox.showwarning = original_showwarning
        messagebox.showinfo = original_showinfo
        appmod.CONFIG_FILE = original_config
        appmod.MANIFEST_FILE = original_manifest


if __name__ == "__main__":
    run()
