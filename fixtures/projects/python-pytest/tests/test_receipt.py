from shop.cart import Cart
from shop.receipt import receipt


def test_receipt():
    assert receipt(Cart().add(500)) == "TOTAL 6.00"
