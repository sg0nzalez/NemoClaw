#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Patch Hermes' Discord pairing approval help to use the Hermes CLI name."""

from __future__ import annotations

import sys
from pathlib import Path

LEGACY_COMMAND = "openclaw pairing approve"
HERMES_COMMAND = "hermes pairing approve"
TEXT_SUFFIXES = {
    ".cfg",
    ".ini",
    ".json",
    ".md",
    ".py",
    ".rst",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}


def _iter_text_candidates(root: Path):
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in TEXT_SUFFIXES:
            yield path


def patch_pairing_message(root: Path) -> int:
    patched_count = 0
    found_corrected = False

    for path in _iter_text_candidates(root):
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue

        if HERMES_COMMAND in text:
            found_corrected = True

        if LEGACY_COMMAND not in text:
            continue

        path.write_text(text.replace(LEGACY_COMMAND, HERMES_COMMAND), encoding="utf-8")
        patched_count += 1
        found_corrected = True

    if not found_corrected:
        raise RuntimeError(f"Hermes pairing approval command text not found under {root}")

    return patched_count


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: patch-pairing-message.py <hermes-source-root>", file=sys.stderr)
        return 2

    root = Path(argv[1])
    if not root.is_dir():
        print(f"Hermes source root does not exist: {root}", file=sys.stderr)
        return 2

    try:
        patched_count = patch_pairing_message(root)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(f"Hermes pairing approval command patch applied to {patched_count} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
