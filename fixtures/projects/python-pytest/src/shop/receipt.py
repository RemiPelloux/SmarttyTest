from .cart import Cart


def receipt(cart: Cart) -> str:
    return f"TOTAL {cart.total() / 100:.2f}"
