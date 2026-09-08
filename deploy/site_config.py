"""Migrate operator data without executing legacy JavaScript (run by installer)."""
import argparse
import ast
import hashlib
import json
import math
import os
import re
import shutil
import tempfile
from pathlib import Path


class LiteralParser:
    """Only the shipped config's literal subset, never expressions or code."""

    tokens = re.compile(
        r"""\s+|//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'"""
        r"""|[A-Za-z_$][\w$]*|-?\d+(?:\.\d+)?|[{}\[\]:,]""", re.S)


    def __init__(self, source):
        match = re.search(r"^\s*window\.OWNTONE_DASHBOARD\s*=\s*", source, re.M)
        if not match:
            raise ValueError("Legacy config has no literal OWNTONE_DASHBOARD assignment")
        self.source = source[match.end():]
        self.offset = 0

    def take(self):
        while True:
            match = self.tokens.match(self.source, self.offset)
            if not match:
                raise ValueError("Legacy config must contain literal settings only; migrate it manually")
            self.offset = match.end()
            lexeme = match.group()
            if not lexeme.isspace() and not lexeme.startswith(("//", "/*")):
                return lexeme

    def value(self, lexeme=None):
        lexeme = lexeme or self.take()
        if lexeme in ("{", "["):
            mapping = lexeme == "{"
            result = {} if mapping else []
            end = "}" if mapping else "]"
            lexeme = self.take()
            while lexeme != end:
                if mapping:
                    key = ast.literal_eval(lexeme) if lexeme[0] in "\"'" else lexeme
                    if key in result or self.take() != ":":
                        raise ValueError("Duplicate or invalid configuration key")
                    result[key] = self.value()
                else:
                    result.append(self.value(lexeme))
                lexeme = self.take()
                if lexeme == end:
                    break
                if lexeme != ",":
                    raise ValueError("Expected comma in literal configuration")
                lexeme = self.take()
            return result
        if lexeme[0] in "\"'":
            return ast.literal_eval(lexeme)
        if lexeme in ("true", "false"):
            return lexeme == "true"
        if re.fullmatch(r"-?\d+(?:\.\d+)?", lexeme):
            return float(lexeme) if "." in lexeme else int(lexeme)
        raise ValueError("Configuration expressions are unsupported; migrate to JSON manually")

    def assignment(self):
        value = self.value()
        rest = self.source[self.offset:]
        rest = re.sub(r"^(?:\s+|/\*.*?\*/|//[^\n]*)*", "", rest, flags=re.S)
        if not rest.startswith(";"):
            raise ValueError("Legacy config must end its literal assignment with a semicolon")
        return value


def validate(overrides, defaults):
    if not isinstance(overrides, dict):
        raise ValueError("Site configuration must be a JSON object")
    for key, value in overrides.items():
        if key not in defaults:
            raise ValueError(f"Unknown site setting: {key}")
        original = defaults[key]
        if isinstance(original, bool):
            valid = isinstance(value, bool)
        elif isinstance(original, (int, float)):
            maximum = 24 if key.endswith("Hour") else 100 if key.endswith("Volume") else math.inf
            valid = (type(value) in (int, float) and math.isfinite(value) and 0 <= value <= maximum
                     and (not key.endswith(("Ms", "Limit")) or value > 0))
        elif isinstance(original, dict):
            valid = isinstance(value, dict) and all(isinstance(v, str) for v in value.values())
        elif isinstance(original, list):
            valid = isinstance(value, list) and all(isinstance(v, str) for v in value)
        else:
            valid = isinstance(value, str)
        if not valid:
            raise ValueError(f"Invalid site setting: {key}")


def prepare(source, previous, external):
    """Copy legacy settings once, preserve existing external data, link new release."""
    defaults = LiteralParser((source / "config.js").read_text()).assignment()
    config = external / "config.json"
    if not external.is_absolute() or external.resolve() != external:
        raise ValueError("Site directory must be canonical and not a symlink")
    if config.is_symlink():
        raise ValueError("Site configuration must be a regular file")
    # Both paths and their parents must stay outside any tree being replaced.
    for release in (source.resolve(), previous.resolve(), Path(str(previous.resolve()) + ".rollback")):
        if external == release or release in external.parents or external in release.parents:
            raise ValueError("Operator storage must be separate from live, staging and rollback trees")
    artwork = external / "artwork"
    if artwork.is_symlink() or any(p.is_symlink() for p in artwork.rglob("*")):
        raise ValueError("Operator artwork directory must not contain symlinks")
    legacy = previous / "station-logos"
    files = list(legacy.rglob("*")) if legacy.exists() else []
    if legacy.is_symlink() or any(p.is_symlink() for p in files):
        raise ValueError("Legacy artwork symlinks need manual migration")
    legacy_config = previous / "config.js"
    fingerprint = {}
    if legacy_config.is_file():
        fingerprint["config.js"] = hashlib.sha256(legacy_config.read_bytes()).hexdigest()
    for path in files:
        if path.is_file():
            name = "station-logos/" + path.relative_to(legacy).as_posix()
            fingerprint[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    marker = external / ".legacy-migration.json"
    if marker.is_symlink():
        raise ValueError("Migration record must not be a symlink")
    if (marker.exists() and not (previous / "site-config.json").exists()
            and json.loads(marker.read_text()) != fingerprint):
        raise ValueError("Legacy settings/artwork changed after migration; reconcile external data "
                         "and remove .legacy-migration.json before retrying")
    if config.exists():
        overrides = json.loads(config.read_text())
    elif (previous / "site-config.json").is_file():
        overrides = json.loads((previous / "site-config.json").read_text())
    elif legacy_config.is_file():
        overrides = LiteralParser(legacy_config.read_text()).assignment()
    else:
        overrides = {}
    validate(overrides, defaults)

    def public_directory(path):
        if not path.exists():
            public_directory(path.parent)
            path.mkdir(mode=0o755)
            path.chmod(0o755)  # mkdir's mode alone is restricted by umask.

    def create_json(path, data):
        fd, temporary = tempfile.mkstemp(prefix=".site-config-", dir=external)
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(data, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fchmod(handle.fileno(), 0o644)
                os.fsync(handle.fileno())
            os.link(temporary, path)
        finally:
            os.unlink(temporary)

    public_directory(external)
    public_directory(artwork)
    if not config.exists():
        # Record origin before the first copy so interrupted migrations still
        # detect edits made to the restored legacy files before a retry.
        if fingerprint and not marker.exists():
            create_json(marker, fingerprint)
        for path in files:
            destination = artwork / path.relative_to(legacy)
            if path.is_dir():
                public_directory(destination)
            elif path.is_file() and not destination.exists():
                public_directory(destination.parent)
                fd, temporary = tempfile.mkstemp(prefix=".artwork-", dir=destination.parent)
                os.close(fd)
                try:
                    shutil.copyfile(path, temporary)
                    os.chmod(temporary, 0o644)
                    # Publish only a complete copy; never replace operator files.
                    os.link(temporary, destination)
                finally:
                    os.unlink(temporary)
        def migrated_url(value):
            for prefix in ("station-logos/", "./station-logos/", "/station-logos/"):
                if value.startswith(prefix):
                    return "/site-assets/" + value[len(prefix):]
            return value
        overrides["radioArtwork"] = {
            key: migrated_url(value) for key, value in overrides.get("radioArtwork", {}).items()
        }
        create_json(config, overrides)
    for name, target in (("site-config.json", config), ("site-assets", artwork)):
        link = source / name
        if link.exists() or link.is_symlink():
            if link.is_dir() and not link.is_symlink():
                raise ValueError(f"Reserved operator mount exists in release: {name}")
            link.unlink()
        link.symlink_to(target)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("previous", type=Path)
    parser.add_argument("external", type=Path)
    args = parser.parse_args()
    prepare(args.source, args.previous, args.external)
