from api.hello import shout


def test_shout():
    assert shout("ada") == "HELLO ADA"
