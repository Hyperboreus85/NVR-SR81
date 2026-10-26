"""Threshold boundaries use available bytes, never rounded UI percentages."""
from types import SimpleNamespace
import pytest
from nvr.storage_policy import archive_reserve_bytes, archive_storage_status, disk_storage_status, storage_overview


@pytest.mark.parametrize('free,state,warning,overwrite',[
    (110,'normal',False,False),(100,'normal',False,False),(99,'warning',True,False),
    (50,'warning',True,False),(49,'critical',True,True),(0,'critical',True,True),
])
def test_exact_boundaries(free,state,warning,overwrite):
    result=archive_storage_status({'total':1000,'free':free})
    assert result['state']==state and result['warning'] is warning and result['overwrite_required'] is overwrite
    assert result['free_percent']==free/10 and result['reserve_bytes']==50


def test_fractional_percentages_cannot_round_out_of_warning_or_critical():
    assert archive_storage_status({'total':1000000,'free':99999})['state']=='warning'
    assert archive_storage_status({'total':1000000,'free':49999})['overwrite_required'] is True
    assert archive_reserve_bytes(1001)==51
    assert archive_storage_status(SimpleNamespace(total=1001,free=50))['overwrite_required'] is True
    assert archive_storage_status(SimpleNamespace(total=1001,free=51))['overwrite_required'] is False


@pytest.mark.parametrize('disk',[None,{}, {'total':0,'free':0},{'total':-1,'free':0},
    {'total':100,'free':101},{'total':100,'free':None},{'total':True,'free':0},
    {'total':100,'free':False},{'total':100,'free':-1},{'total':100,'free':float('nan')},
    {'total':float('inf'),'free':0},{'total':'100','free':0},{'total':100.5,'free':0}])
def test_unknown_or_inconsistent_measurements_never_authorize_cleanup(disk):
    result=archive_storage_status(disk)
    assert result['state']=='unavailable' and result['reserve_bytes'] is None and result['free_percent'] is None
    assert result['warning'] is result['overwrite_required'] is False


def test_system_warning_is_separate_and_never_authorizes_system_file_deletion():
    value=disk_storage_status({'total':1000,'free':20})
    assert value['state']=='critical' and value['warning'] is True
    assert value['overwrite_required'] is False and value['reserve_bytes'] is None
    separate=storage_overview({'recordings':{'total':1000,'free':200},'root':{'total':100,'free':2},'shared_filesystem':False})
    assert separate['archive']['state']=='normal' and separate['system']['state']=='critical'
    assert storage_overview({'recordings':{'total':1000,'free':20},'shared_filesystem':True})['system'] is None


def test_byte_counts_keep_integer_precision_on_large_filesystems():
    total=10**20
    assert archive_reserve_bytes(total)==5*10**18
    assert archive_storage_status({'total':total,'free':5*10**18})['overwrite_required'] is False
    assert archive_storage_status({'total':total,'free':5*10**18-1})['overwrite_required'] is True
