"""Local, validated JSON language packs with immutable English fallback."""
from __future__ import annotations

import contextlib
from copy import deepcopy
import json
import os
from pathlib import Path
import re
import tempfile

FORMAT = "nvr-sr81.language-pack"
VERSION = 1
MAX_PACK_BYTES = 512 * 1024
MAX_TRANSLATIONS = 2000
LOCALE_PATTERN = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*")
PLACEHOLDERS = re.compile(r"\{([A-Za-z][A-Za-z0-9_]*)\}")
LEGACY_METADATA_KEY = "translation_overrides_v1"
MIGRATION_METADATA_KEY = "language_packs_legacy_it_migrated_v1"


class LanguageError(ValueError):
    """Safe for API responses; never contains file paths or uploaded contents."""

    def __init__(self, message="Invalid language pack.", status_code=422):
        super().__init__(message)
        self.status_code = status_code


def canonical_locale(value: str) -> str:
    if not isinstance(value, str) or len(value) > 35 or not LOCALE_PATTERN.fullmatch(value):
        raise LanguageError("Invalid language code.")
    pieces = value.split("-")
    result = [pieces[0].lower()]
    for piece in pieces[1:]:
        if len(piece) == 4 and piece.isalpha():
            result.append(piece.title())
        elif len(piece) == 2 and piece.isalpha():
            result.append(piece.upper())
        else:
            result.append(piece.lower())
    return "-".join(result)


def _text(value, maximum, *, allow_empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not allow_empty and not value.strip()):
        raise LanguageError()
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise LanguageError() from None
    return value


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise LanguageError("Duplicate fields are not allowed in a language pack.")
        result[key] = value
    return result


class LanguageManager:
    def __init__(self, directory: Path, bundled: Path):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o750, parents=True, exist_ok=True)
        self._keys: set[str] | None = None
        english = self._read(Path(bundled) / "en.json")
        self._keys = set(english["translations"])
        self._included = {"en": english, "it": self._read(Path(bundled) / "it.json")}
        self._installed: dict[str, dict] = {}
        for path in sorted(self.directory.glob("*.json")):
            if path.is_symlink() or not path.is_file():
                continue
            try:
                pack = self._read(path)
                locale = pack["locale"]
                if locale != "en" and path.name == locale + ".json":
                    self._installed[locale] = pack
            except (LanguageError, OSError):
                # A corrupt or incompatible optional pack cannot stop recording.
                continue

    def _validate(self, value) -> dict:
        required = {"format", "version", "locale", "name", "native_name", "translations"}
        if not isinstance(value, dict) or set(value) != required:
            raise LanguageError()
        if value["format"] != FORMAT or type(value["version"]) is not int or value["version"] != VERSION:
            raise LanguageError("Unsupported language pack format or version.")
        locale = canonical_locale(value["locale"])
        name = _text(value["name"], 80).strip()
        native_name = _text(value["native_name"], 80).strip()
        translations = value["translations"]
        if not isinstance(translations, dict) or len(translations) > MAX_TRANSLATIONS:
            raise LanguageError("A language pack can contain at most 2000 translations.")
        cleaned = {}
        for key, translation in translations.items():
            _text(key, 500)
            _text(translation, 2000, allow_empty=True)
            if self._keys is not None and key not in self._keys:
                raise LanguageError("The language pack contains unknown English source keys.")
            if translation.strip() and sorted(PLACEHOLDERS.findall(key)) != sorted(PLACEHOLDERS.findall(translation)):
                raise LanguageError("Translation placeholders must match the English source.")
            cleaned[key] = translation
        return {"format": FORMAT, "version": VERSION, "locale": locale, "name": name,
                "native_name": native_name, "translations": cleaned}

    def parse(self, data: bytes | bytearray) -> dict:
        if len(data) > MAX_PACK_BYTES:
            raise LanguageError("Language pack file is too large.", 413)
        try:
            parsed = json.loads(data, object_pairs_hook=_unique_object)
        except (ValueError, UnicodeError, TypeError, RecursionError):
            raise LanguageError() from None
        return self._validate(parsed)

    def _read(self, path: Path) -> dict:
        with path.open("rb") as stream:
            return self.parse(stream.read(MAX_PACK_BYTES + 1))

    def _pack(self, locale: str) -> dict:
        locale = canonical_locale(locale)
        pack = self._installed.get(locale) or self._included.get(locale)
        if pack is None:
            raise LanguageError("Language pack not found.", 404)
        return pack

    def metadata(self, locale: str) -> dict:
        pack = self._pack(locale)
        locale = pack["locale"]
        return {"locale": locale, "name": pack["name"], "native_name": pack["native_name"],
                "source": "installed" if locale in self._installed else "included",
                "translated": sum(bool(value.strip()) for value in pack["translations"].values()),
                "total": len(self._keys)}

    def list(self) -> dict:
        locales = set(self._included) | set(self._installed)
        return {"default": "en", "fallback": "en", "languages": [self.metadata(locale)
                for locale in sorted(locales, key=lambda value: (value != "en", value))]}

    def get(self, locale: str) -> dict:
        return deepcopy(self._pack(locale))

    def template(self) -> dict:
        return {"format": FORMAT, "version": VERSION, "locale": "xx", "name": "Language name",
                "native_name": "Native language name", "translations": {key: key for key in self._included["en"]["translations"]}}

    def install(self, value: dict) -> dict:
        pack = self._validate(value)
        locale = pack["locale"]
        if locale == "en":
            raise LanguageError("The included English language pack cannot be changed.", 403)
        data = json.dumps(pack, ensure_ascii=False, indent=2).encode("utf-8")
        if len(data) > MAX_PACK_BYTES:
            raise LanguageError("Language pack file is too large.", 413)
        replaced = locale in self._included or locale in self._installed
        temporary = None
        try:
            fd, filename = tempfile.mkstemp(prefix=".language-", suffix=".tmp", dir=self.directory)
            temporary = Path(filename)
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.directory / (locale + ".json"))
        except OSError:
            raise LanguageError("Unable to save the language pack.", 503) from None
        finally:
            if temporary is not None:
                with contextlib.suppress(OSError):
                    temporary.unlink(missing_ok=True)
        self._installed[locale] = pack
        return {"language": self.metadata(locale), "replaced": replaced}

    def delete(self, locale: str) -> dict:
        locale = canonical_locale(locale)
        if locale == "en":
            raise LanguageError("The included English language pack cannot be changed.", 403)
        if locale not in self._installed:
            raise LanguageError("No installed language pack was found for this language.", 404)
        try:
            (self.directory / (locale + ".json")).unlink(missing_ok=True)
        except OSError:
            raise LanguageError("Unable to remove the language pack.", 503) from None
        del self._installed[locale]
        return {"locale": locale, "restored": locale in self._included}

    def migrate_legacy(self, store) -> None:
        """Keep the old SQLite entry for downgrades; migrate known keys once."""
        if store.meta_get(MIGRATION_METADATA_KEY):
            return
        old = store.meta_get(LEGACY_METADATA_KEY)
        if old and "it" not in self._installed:
            try:
                legacy = json.loads(old)
                overrides = legacy.get("overrides") if isinstance(legacy, dict) and legacy.get("locale") == "it" else None
                if isinstance(overrides, dict) and overrides:
                    pack = self.get("it")
                    changed = False
                    for key, translation in overrides.items():
                        if key not in self._keys:
                            continue
                        try:
                            _text(translation, 2000, allow_empty=True)
                            if translation.strip() and sorted(PLACEHOLDERS.findall(key)) != sorted(PLACEHOLDERS.findall(translation)):
                                continue
                        except LanguageError:
                            continue
                        pack["translations"][key] = translation
                        changed = True
                    if changed:
                        self.install(pack)
            except LanguageError as error:
                if error.status_code == 503:
                    return  # Retry an interrupted disk migration on next start.
            except (ValueError, TypeError, RecursionError):
                pass
        store.meta_set(MIGRATION_METADATA_KEY, "1")
