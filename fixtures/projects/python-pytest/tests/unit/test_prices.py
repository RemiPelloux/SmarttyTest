from shop.prices import discount


def test_discount():
    assert discount(1000, 10) == 900
