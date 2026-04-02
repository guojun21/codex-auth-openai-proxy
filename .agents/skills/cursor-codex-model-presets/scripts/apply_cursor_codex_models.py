#!/usr/bin/env python3

import argparse
import json
import sqlite3
import subprocess
import time
from pathlib import Path


KEY = "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser"
GLOBAL_STORAGE_DIR = Path("~/Library/Application Support/Cursor/User/globalStorage").expanduser()
DB_NAMES = ["state.vscdb", "state.vscdb.backup"]
REMOVE_NAMES = {
    "codex-gpt-5-4-fast-xhigh",
    "codex-gpt-5-4-low",
    "codex-gpt-5-4-low-fast",
    "codex-gpt-5-4-medium",
    "codex-gpt-5-4-medium-fast",
    "codex-gpt-5-4-high",
    "codex-gpt-5-4-high-fast",
    "codex-gpt-5-4-xhigh",
    "codex-gpt-5-4-xhigh-fast",
}


def tooltip(title: str, version: str) -> dict:
    return {
        "primaryText": "",
        "secondaryText": "",
        "secondaryWarningText": False,
        "icon": "",
        "tertiaryText": "",
        "tertiaryTextUrl": "",
        "markdownContent": (
            f"**{title}**<br />Backed by your Codex/ChatGPT-auth proxy for Cursor."
            f"<br /><br />260k context window"
            f"<br /><br /><span style=\"color:var(--vscode-editorWarning-foreground);\">"
            f"Uses fast priority processing.</span>"
            f"<br /><br />*Version: {version}*"
        ),
    }


def model_entry(server_name: str, display_name: str, version: str) -> dict:
    tip = tooltip("GPT-5.4 Codex Fast", version)
    return {
        "name": server_name,
        "defaultOn": False,
        "parameterDefinitions": [],
        "variants": [],
        "legacySlugs": [],
        "supportsAgent": True,
        "degradationStatus": 0,
        "tooltipData": tip,
        "supportsThinking": True,
        "supportsImages": True,
        "supportsMaxMode": True,
        "clientDisplayName": display_name,
        "serverModelName": server_name,
        "supportsNonMaxMode": True,
        "tooltipDataForMaxMode": tip,
        "isRecommendedForBackgroundComposer": False,
        "supportsPlanMode": True,
        "isUserAdded": True,
        "inputboxShortModelName": display_name,
        "supportsSandboxing": True,
        "namedModelSectionIndex": 1,
    }


FAST_ONLY_MODELS = [
    model_entry("codex-gpt-5-4-low-fast", "GPT-5.4 Codex Low Fast", "low reasoning effort"),
    model_entry(
        "codex-gpt-5-4-medium-fast",
        "GPT-5.4 Codex Medium Fast",
        "medium reasoning effort",
    ),
    model_entry("codex-gpt-5-4-high-fast", "GPT-5.4 Codex High Fast", "high reasoning effort"),
    model_entry(
        "codex-gpt-5-4-xhigh-fast",
        "GPT-5.4 Codex Extra High Fast",
        "extra high reasoning effort",
    ),
]


def cursor_running() -> bool:
    return subprocess.run(
        ["pgrep", "-x", "Cursor"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


def quit_cursor() -> None:
    if not cursor_running():
        return
    subprocess.run(
        ["osascript", "-e", 'tell application "Cursor" to quit'],
        check=True,
    )
    for _ in range(30):
        if not cursor_running():
            return
        time.sleep(1)
    raise RuntimeError("Cursor did not quit within 30 seconds")


def open_cursor() -> None:
    subprocess.run(["open", "-a", "Cursor"], check=True)


def update_db(db_path: Path, models: list[dict], dry_run: bool) -> list[tuple[str, str]]:
    with sqlite3.connect(db_path) as con:
        row = con.execute("select value from ItemTable where key=?", (KEY,)).fetchone()
        if not row:
            raise RuntimeError(f"{KEY} not found in {db_path}")

        current_value = row[0]
        backup_path = Path(f"/tmp/{db_path.name}.applicationUser.{int(time.time())}.json")
        backup_path.write_text(current_value, encoding="utf-8")

        payload = json.loads(current_value)
        available_models = payload.get("availableDefaultModels2")
        if not isinstance(available_models, list):
            raise RuntimeError(f"availableDefaultModels2 missing in {db_path}")

        available_models = [
            model
            for model in available_models
            if not (
                isinstance(model, dict)
                and model.get("serverModelName") in REMOVE_NAMES
            )
        ]
        available_models.extend(models)
        payload["availableDefaultModels2"] = available_models

        if not dry_run:
            con.execute(
                "update ItemTable set value=? where key=?",
                (json.dumps(payload, ensure_ascii=False, separators=(",", ":")), KEY),
            )
            con.commit()

        return [
            (
                model.get("serverModelName", ""),
                model.get("clientDisplayName", ""),
            )
            for model in available_models
            if isinstance(model, dict) and model.get("isUserAdded")
        ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--global-storage-dir",
        default=str(GLOBAL_STORAGE_DIR),
        help="Cursor globalStorage directory",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-reopen", action="store_true")
    args = parser.parse_args()

    global_storage_dir = Path(args.global_storage_dir).expanduser()
    if not global_storage_dir.exists():
        raise SystemExit(f"globalStorage dir not found: {global_storage_dir}")

    if not args.dry_run:
        quit_cursor()

    for name in DB_NAMES:
        db_path = global_storage_dir / name
        if not db_path.exists():
            raise SystemExit(f"missing database: {db_path}")
        visible = update_db(db_path, FAST_ONLY_MODELS, args.dry_run)
        print(db_path)
        for server_name, display_name in visible:
            print(f"  {server_name} => {display_name}")

    if not args.dry_run and not args.no_reopen:
        open_cursor()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
