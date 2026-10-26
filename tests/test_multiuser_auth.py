"""Authentication races and migration use only fixture accounts/passwords."""
from concurrent.futures import ThreadPoolExecutor
import json
import threading
import time
import uuid

import pytest

from nvr import security
from nvr.accounts import AccountError, BUILTIN_ADMIN_ID, PERMISSIONS, password_hash
from nvr.security import Auth
from nvr.store import Store


PASSWORD = "fixture-only-password-123"
NEW_PASSWORD = "new-fixture-password-456"
OTHER_PASSWORD = "other-fixture-password-789"


@pytest.fixture
def auth(tmp_path):
    store = Store(tmp_path)
    return Auth(store, PASSWORD), store


def user(auth, username="viewer", **changes):
    return auth.accounts.create({"username": username, "password": PASSWORD, **changes}, BUILTIN_ADMIN_ID)


def test_legacy_hash_wins_over_environment_during_migration_and_key_is_preserved(tmp_path):
    store = Store(tmp_path)
    legacy = password_hash(PASSWORD)
    store.meta_set("password_hash", legacy)
    key = (tmp_path / "credentials.key").read_bytes()
    auth = Auth(store, NEW_PASSWORD)
    assert auth.password_hash == legacy == store.meta_get("password_hash")
    assert auth.authenticate(" ADMIN ", PASSWORD, "host")
    assert auth.authenticate("admin", NEW_PASSWORD, "host") is None
    assert (tmp_path / "credentials.key").read_bytes() == key
    assert auth.accounts.get(BUILTIN_ADMIN_ID)["username"] == "admin"


def test_numeric_expiries_legacy_check_login_and_external_sessions_pop_still_work(auth):
    login, _ = auth
    assert login.check(PASSWORD, "legacy", username="ADMIN")
    token = login.login()
    assert isinstance(login.sessions[token], (int, float)) and login.sessions[token] > time.monotonic()
    assert login.valid(token) and login.principal(token)["id"] == BUILTIN_ADMIN_ID
    login.sessions.pop(token)
    assert not login.valid(token)
    assert not login.valid(None) and not login.valid({})


def test_privilege_camera_scope_and_orphan_archives_are_enforced_by_fresh_principals(auth):
    login, store = auth
    first, other = uuid.uuid4().hex, uuid.uuid4().hex
    with store.connect() as db:
        db.execute("INSERT INTO cameras VALUES (?,?,?,?,?,?,?,?)", (first, "Fixture", "encrypted", "", 1, "none", 7, 1))
    created = user(login, permissions=["live", "recordings"], camera_ids=[first])
    token = login.authenticate("VIEWER", PASSWORD, "viewer-host")
    assert token and login.allows(token, "live", first) and login.allows(token, "recordings", first)
    assert not login.allows(token, "live", other) and not login.allows(token, "download", first)
    assert not login.allows(token, "users") and not login.allows(token, "maintenance")
    with store.connect() as db:
        db.execute("DELETE FROM cameras WHERE id=?", (first,))
    assert login.allows(token, "recordings", first)  # API verifies an actual recording separately.
    assert PASSWORD not in json.dumps(login.principal(token)) and "revision" not in login.principal(token)
    login.accounts.update(created["id"], {"permissions": []}, BUILTIN_ADMIN_ID)
    assert login.principal(token) is None and not login.valid(token)


@pytest.mark.parametrize("operation", ["permissions", "password", "disabled", "deleted"])
def test_every_account_edit_reset_disable_or_delete_revokes_existing_sessions(auth, operation):
    login, _ = auth
    created = user(login, permissions=["live"], camera_scope="all")
    token = login.authenticate("viewer", PASSWORD, "host")
    if operation == "deleted":
        login.accounts.delete(created["id"], BUILTIN_ADMIN_ID)
    else:
        patch = {"permissions": ["recordings"]} if operation == "permissions" else {"password": NEW_PASSWORD} if operation == "password" else {"enabled": False}
        login.accounts.update(created["id"], patch, BUILTIN_ADMIN_ID)
    assert not login.valid(token) and token not in login.sessions


def test_self_password_change_requires_current_password_logs_out_every_session_and_survives_old_env_restart(auth, tmp_path):
    login, store = auth
    first = login.authenticate("admin", PASSWORD, "first-host")
    second = login.authenticate("admin", PASSWORD, "second-host")
    with pytest.raises(AccountError, match="Current password"):
        login.change_password(first, "incorrect-fixture", NEW_PASSWORD, "change-host")
    assert login.valid(first)
    login.change_password(first, PASSWORD, NEW_PASSWORD, "change-host")
    assert not login.valid(first) and not login.valid(second)
    assert not login.sessions and store.meta_get("password_hash") == login.password_hash
    restarted = Auth(Store(tmp_path), PASSWORD)
    assert restarted.authenticate("admin", NEW_PASSWORD, "new-host")
    assert restarted.authenticate("admin", PASSWORD, "old-host") is None


def test_ordinary_users_cannot_change_password_through_admin_only_route(auth):
    login, _ = auth
    user(login)
    token = login.authenticate("viewer", PASSWORD, "host")
    with pytest.raises(AccountError) as error:
        login.change_password(token, PASSWORD, NEW_PASSWORD, "change-host")
    assert error.value.status_code == 403 and login.valid(token)


def test_unknown_disabled_and_invalid_usernames_all_do_the_same_scrypt_work(auth, monkeypatch):
    login, _ = auth
    user(login, enabled=False)
    original, calls = security.hashlib.scrypt, []
    def spy(*args, **kwargs):
        calls.append((kwargs["n"], kwargs["r"], kwargs["p"], len(kwargs["salt"])))
        return original(*args, **kwargs)
    monkeypatch.setattr(security.hashlib, "scrypt", spy)
    assert login.authenticate("admin", "bad-fixture-password", "one") is None
    assert login.authenticate("missing", "bad-fixture-password", "two") is None
    assert login.authenticate("viewer", PASSWORD, "three") is None
    assert login.authenticate("not/valid", PASSWORD, "four") is None
    assert calls == [(16384, 8, 1, 16)] * 4


def test_success_with_another_account_never_resets_previous_failed_host_attempts(auth):
    login, _ = auth
    user(login)
    for _ in range(4):
        assert login.authenticate("admin", "incorrect-fixture", "shared-host") is None
        assert login.authenticate("viewer", PASSWORD, "shared-host")
    assert login.authenticate("admin", "incorrect-fixture", "shared-host") is None
    assert len(login.failures["shared-host"]) == 5
    assert login.authenticate("viewer", PASSWORD, "shared-host") is None


def test_rate_limiter_is_bounded_and_parallel_attempts_reserve_before_hashing(auth, monkeypatch):
    login, _ = auth
    calls = []
    def incorrect(*args, **kwargs):
        calls.append(1); time.sleep(.02); return b"not-a-digest"
    monkeypatch.setattr(security.hashlib, "scrypt", incorrect)
    with ThreadPoolExecutor(max_workers=10) as pool:
        assert not any(pool.map(lambda _: login.authenticate("admin", "bad", "same-host"), range(10)))
    assert len(calls) == len(login.failures["same-host"]) == 5
    now = time.monotonic()
    login.failures = {f"host-{index}": [now] for index in range(1024)}
    assert login.authenticate("admin", PASSWORD, "new-host") is None and len(login.failures) == 1024


@pytest.mark.parametrize("change", ["reset", "disable", "delete"])
def test_password_or_account_change_during_hashing_cannot_mint_a_session(auth, monkeypatch, change):
    login, _ = auth
    created = user(login)
    entered, release = threading.Event(), threading.Event()
    original = security.verify_password
    def blocked(value, encoded):
        matched = original(value, encoded)
        entered.set(); assert release.wait(3)
        return matched
    monkeypatch.setattr(security, "verify_password", blocked)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(login.authenticate, "viewer", PASSWORD, "race-host")
        assert entered.wait(2)
        try:
            if change == "delete":
                login.accounts.delete(created["id"], BUILTIN_ADMIN_ID)
            else:
                login.accounts.update(created["id"], {"password": NEW_PASSWORD} if change == "reset" else {"enabled": False}, BUILTIN_ADMIN_ID)
        finally:
            release.set()
        assert pending.result(2) is None
    assert not login.sessions


def test_concurrent_reset_invalidates_the_self_change_revision_after_expensive_hash(auth, monkeypatch):
    login, _ = auth
    manager = user(login, "manager", role="admin")
    token = login.authenticate("manager", PASSWORD, "host")
    entered, release = threading.Event(), threading.Event()
    original = security.password_hash
    def blocked(value):
        encoded = original(value)
        entered.set(); assert release.wait(3)
        return encoded
    monkeypatch.setattr(security, "password_hash", blocked)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(login.change_password, token, PASSWORD, NEW_PASSWORD, "change-host")
        assert entered.wait(2)
        try:
            login.accounts.update(manager["id"], {"password": OTHER_PASSWORD}, BUILTIN_ADMIN_ID)
        finally:
            release.set()
        with pytest.raises(AccountError) as error:
            pending.result(2)
        assert error.value.status_code == 409
    assert login.authenticate("manager", OTHER_PASSWORD, "fresh")
    assert login.authenticate("manager", NEW_PASSWORD, "rejected") is None


def test_storage_failure_is_fail_closed_and_never_echoes_exception_details(auth, monkeypatch):
    login, _ = auth
    token = login.authenticate("admin", PASSWORD, "host")
    def failed(**kwargs):
        raise AccountError("User storage is unavailable. Try again shortly.", 503)
    monkeypatch.setattr(login.accounts, "_auth_record", failed)
    assert login.principal(token) is None
    assert login.authenticate("admin", PASSWORD, "new-host") is None
    assert not login.check(PASSWORD, "third-host")
