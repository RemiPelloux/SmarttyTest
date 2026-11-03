import pytest

from shop.cart import Cart


@pytest.fixture
def cart() -> Cart:
    return Cart().add(1000)
