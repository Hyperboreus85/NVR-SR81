import json
from types import SimpleNamespace

import pytest

from nvr.network_targets import NetworkTargetError, NetworkTargets, TARGETS_KEY


def memory_store():
    data = {}
    return SimpleNamespace(meta_get=data.get, meta_set=lambda key, value: data.__setitem__(key, value), data=data)


def test_named_targets_persist_without_credentials_or_network_lookups_and_can_be_removed():
    store = memory_store()
    targets = NetworkTargets(store)
    assert targets.read() == {"targets": [], "max_targets": 32} and store.data == {}
    one = targets.create(" Local cameras ", "192.168.20.19/24")["targets"][0]
    assert one["name"] == "Local cameras" and one["address"] == "192.168.20.0/24"
    second = targets.create("Remote recorder", "CAMERA.example")["targets"][1]
    assert second["address"] == "camera.example"
    assert NetworkTargets(store).read()["targets"] == [one, second]
    assert targets.delete(one["id"])["targets"] == [second]
    with pytest.raises(NetworkTargetError) as error:
        targets.delete(one["id"])
    assert error.value.status_code == 404


@pytest.mark.parametrize("name,address", [("", "192.168.1.1"), ("x\u202e", "192.168.1.1"), ("x", "http://camera.example/onvif"),
    ("x", "user:private-password@camera.example"), ("x", "8.8.8.0/24"), ("x", "192.168.0.0/16")])
def test_invalid_targets_never_change_saved_values(name, address):
    store = memory_store()
    with pytest.raises(NetworkTargetError):
        NetworkTargets(store).create(name, address)
    assert store.data == {}


def test_corrupt_target_metadata_fails_without_overwriting_it():
    store = memory_store()
    store.data[TARGETS_KEY] = json.dumps([{"id": "x", "name": "Remote", "address": "camera.example", "password": "private"}])
    before = dict(store.data)
    with pytest.raises(NetworkTargetError) as error:
        NetworkTargets(store).create("Good", "192.168.1.2")
    assert error.value.status_code == 503 and "private" not in str(error.value)
    assert store.data == before


def test_duplicate_and_capacity_limits_do_not_replace_existing_search_scopes():
    store = memory_store()
    manager = NetworkTargets(store)
    for index in range(32):
        manager.create("Camera", f"192.168.1.{index + 1}")
    before = dict(store.data)
    with pytest.raises(NetworkTargetError):
        manager.create("More", "192.168.2.1")
    assert store.data == before
    smaller = memory_store()
    one = NetworkTargets(smaller)
    one.create("First", "camera.example")
    with pytest.raises(NetworkTargetError) as error:
        one.create("Second", "CAMERA.example")
    assert error.value.status_code == 409
