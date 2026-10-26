"""Account policy tests use local temporary SQLite databases and fixture passwords."""
from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3
import uuid

import pytest

from nvr.accounts import AccountError, Accounts, BUILTIN_ADMIN_ID, PERMISSIONS
from nvr.security import Auth
from nvr.store import Store


PASSWORD = "fixture-only-password-123"
NEW_PASSWORD = "different-fixture-password-456"


@pytest.fixture
def accounts(tmp_path):
    store = Store(tmp_path)
    auth = Auth(store, PASSWORD)
    return auth.accounts, store, auth


def create(accounts, username="viewer", **changes):
    return accounts.create({"username": username, "password": PASSWORD, **changes}, BUILTIN_ADMIN_ID)


def camera(store):
    identity = uuid.uuid4().hex
    with store.connect() as db:
        db.execute("INSERT INTO cameras VALUES (?,?,?,?,?,?,?,?)", (identity, "Fixture", "encrypted", "", 1, "none", 7, 1))
    return identity


def test_builtin_and_public_rows_never_expose_password_hashes_or_revisions(accounts):
    users, store, _ = accounts
    built = users.get(BUILTIN_ADMIN_ID)
    assert built == {"id": BUILTIN_ADMIN_ID, "username": "admin", "display_name": "Administrator", "role": "admin",
                     "permissions": list(PERMISSIONS), "camera_scope": "all", "camera_ids": [], "enabled": True, "builtin": True}
    row = create(users)
    assert row["role"] == "user" and row["permissions"] == [] and row["camera_scope"] == "selected"
    for record in [row, *users.list(), users.by_username(" VIEWER ")]:
        assert set(record) == set(built)
        assert PASSWORD not in json.dumps(record) and "password_hash" not in record and "revision" not in record
    with store.connect() as db:
        stored = db.execute("SELECT password_hash,revision FROM accounts WHERE id=?", (row["id"],)).fetchone()
    assert stored["revision"] == 1 and stored["password_hash"] != PASSWORD and len(stored["password_hash"].split(":")) == 2


def test_usernames_are_ascii_case_insensitive_and_collision_is_transactional(accounts):
    users, _, _ = accounts
    created = create(users, " Alice.One ")
    assert created["username"] == "alice.one"
    assert users.by_username("ALICE.ONE")["id"] == created["id"]
    with pytest.raises(AccountError) as duplicate:
        create(users, "aLICE.oNE")
    assert duplicate.value.status_code == 409
    def attempt(name):
        try:
            return create(users, name)
        except AccountError as error:
            return error.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(attempt, [" Race.User ", "RACE.USER"]))
    assert sum(isinstance(value, dict) for value in outcomes) == 1 and outcomes.count(409) == 1


@pytest.mark.parametrize("username", ["a", "ab", "-viewer", "_viewer", ".viewer", "ålice", "viewer/name", "a" * 33, "foo\nbar"])
def test_invalid_usernames_are_rejected_without_echo(accounts, username):
    users, _, _ = accounts
    with pytest.raises(AccountError) as error:
        create(users, username)
    assert error.value.status_code == 422
    assert error.value.safe == "Username must contain 3 to 32 ASCII letters, numbers, dots, underscores or hyphens and start with a letter or number."


@pytest.mark.parametrize("patch", [
    {"password": "short"}, {"password": "x" * 1025}, {"password": True}, {"password": "surrogate-password-\ud800"},
    {"display_name": "x" * 81}, {"display_name": "unsafe\nname"}, {"display_name": "zero\u200bwidth"},
    {"display_name": "bidi\u202ename"}, {"display_name": "surrogate\ud800"}, {"role": "owner"}, {"role": []},
    {"enabled": 1}, {"permissions": {"live": True}}, {"permissions": ["unknown"]},
    {"permissions": ["download"]}, {"permissions": ["archive_delete"], "camera_scope": "selected"},
    {"camera_scope": "something"}, {"camera_scope": []}, {"camera_ids": ["../outside"]},
    {"camera_ids": [uuid.uuid4().hex for _ in range(33)]}, {"unknown": PASSWORD},
])
def test_invalid_account_settings_never_become_privileges(accounts, patch):
    users, _, _ = accounts
    with pytest.raises(AccountError) as error:
        create(users, **patch)
    assert error.value.status_code == 422
    assert PASSWORD not in str(error.value) and NEW_PASSWORD not in str(error.value)
    assert users.by_username("viewer") is None


def test_camera_grants_use_only_numeric_index_ids_and_preserve_existing_orphans(accounts, monkeypatch):
    users, store, _ = accounts
    first, second = camera(store), camera(store)
    monkeypatch.setattr(store, "list_cameras", lambda: pytest.fail("Account grants must never decrypt camera streams"))
    row = create(users, permissions=["live", "recordings"], camera_ids=[first, second])
    with store.connect() as db:
        db.execute("DELETE FROM cameras WHERE id=?", (first,))
    updated = users.update(row["id"], {"display_name": "Keep archived grants"}, BUILTIN_ADMIN_ID)
    assert updated["camera_ids"] == [first, second]
    with pytest.raises(AccountError, match="unavailable"):
        users.update(row["id"], {"camera_ids": [first, uuid.uuid4().hex]}, BUILTIN_ADMIN_ID)
    all_cameras = users.update(row["id"], {"camera_scope": "all", "camera_ids": []}, BUILTIN_ADMIN_ID)
    assert all_cameras["camera_scope"] == "all" and all_cameras["camera_ids"] == []


def test_admin_role_is_implicit_all_access_and_global_archive_permission_requires_all_scope(accounts):
    users, _, _ = accounts
    admin = create(users, "manager", role="admin", permissions=[], camera_scope="selected")
    assert admin["permissions"] == list(PERMISSIONS) and admin["camera_scope"] == "all" and admin["camera_ids"] == []
    operator = create(users, "operator", camera_scope="all", permissions=["archive_delete", "recordings", "download"])
    assert operator["permissions"] == ["recordings", "download", "archive_delete"]


def test_partial_admin_demotion_clears_implicit_grants_but_keeps_explicit_requested_permissions(accounts):
    users, _, auth = accounts
    manager = create(users, "manager", role="admin")
    token = auth.authenticate("manager", PASSWORD, "before-demotion")
    demoted = users.update(manager["id"], {"role": "user"}, BUILTIN_ADMIN_ID)
    assert demoted["permissions"] == [] and demoted["camera_scope"] == "selected" and demoted["camera_ids"] == []
    assert not auth.valid(token)
    replacement = auth.authenticate("manager", PASSWORD, "after-demotion")
    assert replacement and not any(auth.allows(replacement, key) for key in PERMISSIONS)
    explicit = create(users, "explicit", role="admin")
    changed = users.update(explicit["id"], {"role": "user", "permissions": ["live"], "camera_scope": "all"}, BUILTIN_ADMIN_ID)
    assert changed["permissions"] == ["live"] and changed["camera_scope"] == "all" and changed["camera_ids"] == []


def test_builtin_self_protection_and_dedicated_self_password_path(accounts):
    users, _, _ = accounts
    for patch in [{"username": "renamed"}, {"enabled": False}, {"role": "user"}, {"password": NEW_PASSWORD}]:
        with pytest.raises(AccountError) as error:
            users.update(BUILTIN_ADMIN_ID, patch, BUILTIN_ADMIN_ID)
        assert error.value.status_code == 409
    with pytest.raises(AccountError):
        users.delete(BUILTIN_ADMIN_ID, BUILTIN_ADMIN_ID)
    manager = create(users, "manager", role="admin")
    for patch in [{"enabled": False}, {"role": "user"}]:
        with pytest.raises(AccountError):
            users.update(manager["id"], patch, manager["id"])
    with pytest.raises(AccountError):
        users.delete(manager["id"], manager["id"])
    assert users.update(manager["id"], {"display_name": "My name"}, manager["id"])["display_name"] == "My name"


def test_password_reset_updates_only_hash_and_revision_and_builtin_rollback_metadata(accounts):
    users, store, auth = accounts
    manager = create(users, "manager", role="admin")
    original = auth.password_hash
    users.update(BUILTIN_ADMIN_ID, {"password": NEW_PASSWORD}, manager["id"])
    assert auth.password_hash != original and auth.password_hash == store.meta_get("password_hash")
    assert auth.check(NEW_PASSWORD, "fresh-host") and not auth.check(PASSWORD, "old-host")
    revision = users._auth_record(identity=manager["id"])["revision"]
    old_hash = users._auth_record(identity=manager["id"])["password_hash"]
    users.update(manager["id"], {"password": None, "display_name": "Changed"}, BUILTIN_ADMIN_ID)
    changed = users._auth_record(identity=manager["id"])
    assert changed["revision"] == revision + 1 and changed["password_hash"] == old_hash


def test_fresh_admin_actor_is_required_inside_every_write_transaction(accounts):
    users, _, _ = accounts
    viewer = create(users)
    for operation in [lambda: users.create({"username": "forbidden", "password": PASSWORD}, viewer["id"]),
                      lambda: users.update(viewer["id"], {"role": "admin"}, viewer["id"]),
                      lambda: users.delete(viewer["id"], viewer["id"])]:
        with pytest.raises(AccountError) as error:
            operation()
        assert error.value.status_code == 403
    assert users.by_username("forbidden") is None and users.get(viewer["id"])["role"] == "user"


def test_concurrent_admin_disables_cannot_remove_the_last_enabled_administrator(accounts):
    users, store, _ = accounts
    first, second = create(users, "first", role="admin"), create(users, "second", role="admin")
    # Deliberately remove the normally immutable builtin only in this fixture so
    # the transactional last-admin invariant is exercised independently.
    with store.connect() as db:
        db.execute("DELETE FROM accounts WHERE id=?", (BUILTIN_ADMIN_ID,))
    def disable(pair):
        actor, target = pair
        try:
            users.update(target, {"enabled": False}, actor)
            return "changed"
        except AccountError:
            return "rejected"
    with ThreadPoolExecutor(max_workers=2) as pool:
        result = list(pool.map(disable, [(first["id"], second["id"]), (second["id"], first["id"])]))
    assert sorted(result) == ["changed", "rejected"]
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM accounts WHERE role='admin' AND enabled=1").fetchone()[0] == 1
