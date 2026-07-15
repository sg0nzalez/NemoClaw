// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Python helpers that parse TOML and open the fresh config without following links. */
export const KEY_ALLOWLIST_CONFIG_PYTHON = String.raw`
import copy
import hashlib
import json
import math
import os
import secrets
import stat
import sys
import tomllib
import tomli_w

MAX_CONFIG_BYTES = 16 * 1024 * 1024


def fail(message):
    raise SystemExit(message)


def parse_config_payload(payload, label):
    if len(payload) > MAX_CONFIG_BYTES:
        fail(f"{label} config exceeds the restore size limit")
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        fail(f"{label} config is not valid UTF-8")
    try:
        parsed = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        fail(f"{label} config is not valid TOML")
    if not isinstance(parsed, dict):
        fail(f"{label} config must be a TOML document")
    return text, parsed


def read_staged_config(pathname, expected_digest, label):
    if (
        not isinstance(pathname, str)
        or not os.path.isabs(pathname)
        or not os.path.basename(pathname).startswith("nemoclaw-state-restore-")
        or os.path.normpath(pathname) != pathname
    ):
        fail("staged config path is invalid")
    if len(expected_digest) != 64 or any(char not in "0123456789abcdef" for char in expected_digest):
        fail("staged config digest is invalid")
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
    parent_fd = os.open("/", flags)
    parts = pathname.split("/")[1:]
    try:
        for component in parts[:-1]:
            next_fd = os.open(component, flags, dir_fd=parent_fd)
            os.close(parent_fd)
            parent_fd = next_fd
        before = os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False)
        payload_fd = os.open(
            parts[-1], os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd
        )
        try:
            metadata = os.fstat(payload_fd)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_nlink != 1
                or metadata.st_size > MAX_CONFIG_BYTES
                or metadata.st_uid != os.geteuid()
                or metadata.st_gid != os.getegid()
                or metadata.st_mode & 0o022
                or (metadata.st_dev, metadata.st_ino) != (before.st_dev, before.st_ino)
            ):
                fail("staged config is not a single bounded regular file")
            os.unlink(parts[-1], dir_fd=parent_fd)
            baseline = os.fstat(payload_fd)
            chunks = []
            total = 0
            digest = hashlib.sha256()
            while True:
                chunk = os.read(payload_fd, 65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_CONFIG_BYTES:
                    fail("staged config exceeds the restore size limit")
                digest.update(chunk)
                chunks.append(chunk)
            after = os.fstat(payload_fd)
            if (
                total != baseline.st_size
                or after.st_size != baseline.st_size
                or after.st_mtime_ns != baseline.st_mtime_ns
                or after.st_ctime_ns != baseline.st_ctime_ns
            ):
                fail("staged config changed while snapshotting")
            if digest.hexdigest() != expected_digest:
                fail("staged config digest mismatch")
        finally:
            os.close(payload_fd)
    finally:
        os.close(parent_fd)
    return parse_config_payload(b"".join(chunks), label)


def open_config_parent(base_dir, relative_path):
    if not os.path.isabs(base_dir):
        fail("config base directory must be absolute")
    if os.path.isabs(relative_path) or "\\" in relative_path:
        fail("config path must be canonical and relative")
    segments = relative_path.split("/")
    if not segments or any(segment in ("", ".", "..") for segment in segments):
        fail("config path must be canonical and relative")
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(base_dir, flags)
    except OSError:
        fail("config parent directory is unsafe")
    try:
        for segment in segments[:-1]:
            next_fd = os.open(segment, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
    except OSError:
        os.close(fd)
        fail("config parent directory is unsafe")
    return fd, segments[-1]


def read_regular_file_at(parent_fd, name, label):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(name, flags, dir_fd=parent_fd)
    except OSError:
        fail(f"{label} config is missing or unsafe")
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            fail(f"{label} config is not a single regular file")
        if metadata.st_size > MAX_CONFIG_BYTES:
            fail(f"{label} config exceeds the restore size limit")
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_CONFIG_BYTES:
                fail(f"{label} config exceeds the restore size limit")
            chunks.append(chunk)
    finally:
        os.close(fd)
    text, parsed = parse_config_payload(b"".join(chunks), label)
    return text, parsed, metadata


def load_spec(raw):
    try:
        spec = json.loads(raw)
    except (TypeError, ValueError):
        fail("restore ownership spec is not valid JSON")
    if not isinstance(spec, dict):
        fail("restore ownership spec must be an object")
    return spec
`.trim();
