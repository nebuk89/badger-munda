"""Bounded JSON state with recoverable atomic replacement."""

try:
    import ujson as json
except ImportError:
    import json
import os

try:
    from .defaults import MAX_STATE_BYTES, STATE_DIR, STATE_SEED_DIR
except ImportError:
    from defaults import MAX_STATE_BYTES, STATE_DIR, STATE_SEED_DIR


class StateError(ValueError):
    pass


def _missing(error):
    return bool(error.args) and error.args[0] == 2


class StateStore:
    def __init__(self, root=STATE_DIR, os_module=os, open_fn=open,
                 max_bytes=MAX_STATE_BYTES, seed_root=STATE_SEED_DIR):
        self.root = root.rstrip("/")
        self.seed_root = seed_root.rstrip("/") if seed_root else None
        self.os = os_module
        self.open = open_fn
        self.max_bytes = max_bytes
        self.last_source = None

    def _path(self, name):
        if not name or "/" in name or name.startswith("."):
            raise StateError("invalid state name")
        return self.root + "/" + name

    def _seed_path(self, name):
        self._path(name)
        return self.seed_root + "/" + name

    def _exists(self, path):
        try:
            self.os.stat(path)
            return True
        except OSError as error:
            if _missing(error):
                return False
            raise

    def _remove(self, path):
        try:
            self.os.remove(path)
        except OSError as error:
            if not _missing(error):
                raise

    def _read(self, path, validator):
        with self.open(path, "r") as source:
            raw = source.read(self.max_bytes + 1)
        if len(raw) > self.max_bytes:
            raise StateError("state file too large")
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            raise StateError("invalid state JSON") from None
        return validator(value)

    def _encode(self, value, validator):
        value = validator(value)
        try:
            raw = json.dumps(value)
        except (TypeError, ValueError):
            raise StateError("state is not JSON serializable") from None
        if len(raw) > self.max_bytes:
            raise StateError("state file too large")
        return value, raw

    def _write_checked(self, path, raw, validator):
        self._remove(path)
        with self.open(path, "w") as target:
            target.write(raw)
            flush = getattr(target, "flush", None)
            if callable(flush):
                flush()
        sync = getattr(self.os, "sync", None)
        if callable(sync):
            sync()
        return self._read(path, validator)

    def _try_read(self, path, validator):
        try:
            return True, self._read(path, validator)
        except OSError as error:
            if _missing(error):
                return False, None
            raise
        except StateError:
            return None, None

    def _ensure_root(self):
        parts = self.root.split("/")
        current = ""
        for part in parts:
            if not part:
                continue
            current += "/" + part
            if not self._exists(current):
                try:
                    self.os.mkdir(current)
                except OSError as error:
                    if not self._exists(current):
                        raise error

    def load(self, name, validator, default):
        primary = self._path(name)
        candidate = primary + ".new"
        backup = primary + ".bak"
        primary_status, primary_value = self._try_read(primary, validator)
        if primary_status is True:
            self.last_source = "primary"
            self._remove(candidate)
            return primary_value

        candidate_status, candidate_value = self._try_read(candidate, validator)
        if candidate_status is True:
            self.last_source = "candidate"
            try:
                if self._exists(primary):
                    self._remove(primary)
                self.os.rename(candidate, primary)
            except OSError:
                pass
            return candidate_value

        backup_status, backup_value = self._try_read(backup, validator)
        if backup_status is True:
            self.last_source = "backup"
            try:
                _value, raw = self._encode(backup_value, validator)
                self._write_checked(candidate, raw, validator)
                self._remove(primary)
                self.os.rename(candidate, primary)
            except (OSError, StateError):
                self._remove(candidate)
            return backup_value

        if primary_status is None or candidate_status is None or backup_status is None:
            self.last_source = "invalid"
            raise StateError("saved state is corrupt")
        self.last_source = "default"
        return validator(default)

    def load_seeded(self, name, validator, default):
        value = self.load(name, validator, default)
        if self.last_source != "default" or self.seed_root is None:
            return value
        seed_status, seed_value = self._try_read(
            self._seed_path(name), validator
        )
        if seed_status is False:
            return value
        if seed_status is None:
            self.last_source = "seed-invalid"
            raise StateError("provisioned state is corrupt")
        saved = self.save(name, seed_value, validator)
        self.last_source = "system-seed"
        return saved

    def save(self, name, value, validator):
        value, raw = self._encode(value, validator)
        self._ensure_root()
        primary = self._path(name)
        candidate = primary + ".new"
        backup = primary + ".bak"
        self._write_checked(candidate, raw, validator)

        moved_primary = False
        try:
            if self._exists(primary):
                try:
                    self._read(primary, validator)
                    primary_valid = True
                except StateError:
                    primary_valid = False
                if primary_valid:
                    self._remove(backup)
                    self.os.rename(primary, backup)
                    moved_primary = True
                else:
                    self._remove(primary)
            self.os.rename(candidate, primary)
            saved = self._read(primary, validator)
        except (OSError, StateError):
            self._remove(candidate)
            if moved_primary and not self._exists(primary) and self._exists(backup):
                try:
                    self.os.rename(backup, primary)
                except OSError:
                    pass
            raise
        self.last_source = "primary"
        return saved

    def scrub_backup(self, name, value, validator):
        """Replace a secret-bearing backup after a destructive state change."""
        _value, raw = self._encode(value, validator)
        primary = self._path(name)
        backup = primary + ".bak"
        candidate = backup + ".new"
        try:
            self._write_checked(candidate, raw, validator)
        except (OSError, StateError):
            self._remove(backup)
            self._remove(candidate)
            return
        self._remove(backup)
        try:
            self.os.rename(candidate, backup)
        except OSError:
            self._remove(candidate)
