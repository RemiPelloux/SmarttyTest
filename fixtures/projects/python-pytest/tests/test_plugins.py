from shop.plugins import load


def test_load():
    assert load("json").dumps(1) == "1"
